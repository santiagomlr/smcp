// macOS Contacts inside people_lookup. The Contacts framework is replaced by a small fake of the
// JavaScript for Automation bridge, so the real script in src/contacts.js runs here against an address
// book held in memory. That checks its logic and the mapping around it; it cannot check macOS itself.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { createContacts, friendlyContactsError, localContacts, queryKind } from "../src/contacts.js";
import { scriptBody } from "../src/jxa.js";
import { readPolicy } from "../src/policy.js";
import { lookupPerson, registerPeople } from "../src/tools/people.js";

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-contacts-"));
});
after(() => rm(dir, { recursive: true, force: true }));
const defaults = () => readPolicy(join(dir, "no-config.json"));

/** What NSDateComponents holds for a part that was never set, such as the year of a birthday. */
const UNSET = 9223372036854775807;

const BOOK = [
  {
    given: "Ana",
    family: "Prueba",
    organization: "Ejemplo SA",
    phones: [["_$!<Mobile>!$_", "+52 55 1234 5678"], [null, "555 0100"]],
    emails: [["_$!<Work>!$_", "ana@example.com"]],
    birthday: { year: 1990, month: 3, day: 7 },
  },
  { given: "Ana", family: "Otra", phones: [], emails: [["_$!<Home>!$_", "ana.otra@example.com"]], birthday: { year: UNSET, month: 12, day: 24 } },
  { organization: "Anahuac Ejemplo", phones: [["_$!<Main>!$_", "555 0199"]], emails: [] },
  { nickname: "Beto", phones: [], emails: [] },
];

/** An address book behind the handful of Contacts calls the script makes. */
function fakeContacts({ book = BOOK, access = 3, fetchError = null } = {}) {
  const state = { access, asked: 0, keys: null, predicates: [] };
  const nil = { isNil: () => true };
  const wrap = (value) => {
    if (value === undefined || value === null) return nil;
    if (typeof value === "string") return { js: value, isNil: () => false };
    if (Array.isArray(value)) return { count: value.length, objectAtIndex: (i) => value[i], items: value, isNil: () => false };
    return value;
  };
  const labeled = (pairs, asValue) => wrap((pairs ?? []).map(([label, value]) => ({ label: wrap(label), value: asValue(value) })));
  const contactObject = (contact) => ({
    givenName: wrap(contact.given ?? ""),
    familyName: wrap(contact.family ?? ""),
    nickname: wrap(contact.nickname ?? ""),
    organizationName: wrap(contact.organization ?? ""),
    phoneNumbers: labeled(contact.phones, (number) => ({ stringValue: wrap(number) })),
    emailAddresses: labeled(contact.emails, (address) => wrap(address)),
    birthday: contact.birthday ? { ...contact.birthday, isNil: () => false } : nil,
    // Reading anything that was not asked for throws in the real framework.
    get note() { throw new Error("CNPropertyNotFetchedException"); },
  });
  const words = (contact) => [contact.given, contact.family, contact.nickname, contact.organization].filter(Boolean).join(" ").toLowerCase().split(" ");
  const digits = (text) => text.replace(/\D/g, "");
  const store = {
    requestAccessForEntityTypeCompletionHandler: (type, done) => {
      state.asked += 1;
      state.access = state.answer ?? 3;
      done(state.access === 3, nil);
    },
    unifiedContactsMatchingPredicateKeysToFetchError: (predicate, keys, error) => {
      state.keys = keys.items;
      if (fetchError) {
        error[0] = { isNil: () => false, localizedDescription: wrap(fetchError) };
        return nil;
      }
      return wrap(book.filter(predicate).map(contactObject));
    },
  };
  const matcher = (kind, test) => (value) => {
    state.predicates.push(kind);
    return (contact) => test(contact, value);
  };
  const $ = (value) => wrap(value);
  Object.assign($, {
    NSRunLoop: { currentRunLoop: { runUntilDate() {} } },
    NSDate: { dateWithTimeIntervalSinceNow: () => ({}) },
    CNContactStore: { authorizationStatusForEntityType: () => state.access, alloc: { get init() { return store; } } },
    CNContact: {
      predicateForContactsMatchingName: matcher("name", (contact, name) => name.js.toLowerCase().split(" ").every((part) => words(contact).some((word) => word.startsWith(part)))),
      predicateForContactsMatchingEmailAddress: matcher("email", (contact, address) => (contact.emails ?? []).some(([, value]) => value === address.js)),
      predicateForContactsMatchingPhoneNumber: matcher("phone", (contact, number) => (contact.phones ?? []).some(([, value]) => digits(value).endsWith(digits(number.text)))),
    },
    CNPhoneNumber: { phoneNumberWithStringValue: (value) => ({ text: value.js }) },
    CNLabeledValue: { localizedStringForLabel: (label) => wrap(label.js.replace(/^_\$!<(.*)>!\$_$/, "$1").toLowerCase()) },
  });
  const jxa = async (prelude, script, params) => {
    const run = vm.runInNewContext(`${scriptBody(prelude, script)}\nrun;`, { ObjC: { import() {} }, $, Ref: () => [] });
    try {
      return JSON.parse(run([JSON.stringify(params)]));
    } catch (error) {
      throw new Error(error.message);
    }
  };
  return { jxa, state };
}

const onMac = (options) => {
  const fake = fakeContacts(options);
  return { ...fake, contacts: createContacts({ jxa: fake.jxa, platform: "darwin" }) };
};

test("a contact comes back with its name, numbers, addresses and birthday", async () => {
  const { contacts, state } = onMac();
  const found = await contacts.search({ query: "Ana Prueba" });
  assert.deepEqual(found, [
    {
      name: "Ana Prueba",
      organization: "Ejemplo SA",
      phones: [{ label: "mobile", number: "+52 55 1234 5678" }, { label: "", number: "555 0100" }],
      emails: [{ label: "work", address: "ana@example.com" }],
      birthday: "1990-03-07",
    },
  ]);
  // Only what is shown is asked for; notes would need a special permission from Apple.
  assert.deepEqual([...state.keys], ["givenName", "familyName", "nickname", "organizationName", "phoneNumbers", "emailAddresses", "birthday"]);
  assert.equal(state.asked, 0);
});

test("a birthday without its year is month and day, and a company or a nickname stands in for a name", async () => {
  const { contacts } = onMac();
  const anas = await contacts.search({ query: "ana" });
  assert.deepEqual(anas.map((contact) => [contact.name, contact.birthday]), [["Ana Prueba", "1990-03-07"], ["Ana Otra", "12-24"], ["Anahuac Ejemplo", null]]);
  assert.equal(anas[2].organization, "Anahuac Ejemplo");
  assert.deepEqual(await contacts.search({ query: "beto" }), [{ name: "Beto", organization: "", phones: [], emails: [], birthday: null }]);
  assert.deepEqual(await contacts.search({ query: "nadie" }), []);
});

test("the search keeps to its limit, and an email address or a phone number has its own matcher", async () => {
  const { contacts, state } = onMac();
  assert.equal((await contacts.search({ query: "ana", limit: 2 })).length, 2);
  assert.equal((await contacts.search({ query: "ana", limit: 0 })).length, 3);
  assert.deepEqual((await contacts.search({ query: "ana.otra@example.com" })).map((contact) => contact.name), ["Ana Otra"]);
  assert.deepEqual((await contacts.search({ query: "+52 (55) 1234-5678" })).map((contact) => contact.name), ["Ana Prueba"]);
  assert.deepEqual(state.predicates, ["name", "name", "email", "phone"]);
  assert.equal(queryKind("Ana 2"), "name");
  assert.equal(queryKind("5550100"), "phone");
  assert.equal(queryKind("1234"), "name");
  assert.equal(queryKind("ana@example.com"), "email");
});

test("the query travels as data, never inside the script", async () => {
  const seen = [];
  const contacts = createContacts({ platform: "darwin", jxa: async (prelude, script, params) => (seen.push({ prelude, script, params }), { contacts: [] }) });
  const query = '"); doShellScript("rm -rf ~';
  assert.deepEqual(await contacts.search({ query, limit: 500 }), []);
  assert.deepEqual(seen[0].params, { query, kind: "name", limit: 20 });
  assert.ok(!`${seen[0].prelude}${seen[0].script}`.includes("doShellScript"));
  await assert.rejects(contacts.search({ query: "   " }), /name, phone number or email/);
  assert.equal(seen.length, 1);
});

test("on anything but a Mac the search is refused without running anything", async () => {
  const jxa = () => assert.fail("must not run a script");
  for (const platform of ["linux", "win32"]) {
    await assert.rejects(createContacts({ jxa, platform }).search({ query: "Ana" }), { message: "Contacts are only available on a Mac." });
    await assert.rejects(localContacts({ query: "Ana" }, { jxa, platform }), /only available on a Mac/);
  }
  assert.deepEqual(await localContacts({ query: "beto" }, { jxa: fakeContacts().jxa, platform: "darwin" }), [{ name: "Beto", organization: "", phones: [], emails: [], birthday: null }]);
});

test("the first search asks macOS for access once, and a no is explained", async () => {
  const first = onMac({ access: 0 });
  assert.equal((await first.contacts.search({ query: "beto" })).length, 1);
  assert.equal(first.state.asked, 1);
  await first.contacts.search({ query: "beto" });
  assert.equal(first.state.asked, 1);

  const refused = onMac({ access: 0 });
  refused.state.answer = 2;
  const message = "SMCP cannot use your Contacts. Allow it in System Settings > Privacy & Security > Contacts, and turn on SMCP.";
  await assert.rejects(refused.contacts.search({ query: "beto" }), { message });
  await assert.rejects(onMac({ access: 2 }).contacts.search({ query: "beto" }), { message });
  await assert.rejects(onMac({ access: 1 }).contacts.search({ query: "beto" }), { message });
  await assert.rejects(onMac({ fetchError: "The database is busy" }).contacts.search({ query: "beto" }), /Contacts did not answer: The database is busy\./);
  assert.equal(friendlyContactsError(new Error(" macOS has not given SMCP permission. Allow it in System Settings > Privacy & Security.")), message);
  assert.equal(friendlyContactsError(new Error("")), "Could not read this Mac's Contacts.");
});

// people_lookup

const ANA = "5215512345678@s.whatsapp.net";
function otherSources(extra = {}) {
  return {
    whatsapp: async (args) => (args[0] === "contacts" ? [{ jid: ANA, name: "Ana Prueba", phone: "+5215512345678" }] : []),
    gmailSearch: async () => ({ messages: [] }),
    notesSearch: async () => [{ vault: "Notas", path: "personas/Ana Prueba.md" }],
    tasks: async () => ({ total: 0, tareas: [] }),
    ...extra,
  };
}

test("people_lookup includes the Mac's contacts next to the other sections", async () => {
  const { contacts } = onMac();
  const asked = [];
  const sources = otherSources({ contacts: (params) => (asked.push(params), contacts.search(params)) });
  const result = await lookupPerson({ query: 'Ana "Prueba"', limit: 20, sources, policy: defaults, platform: "darwin" });
  assert.deepEqual(Object.keys(result), ["query", "whatsapp", "email", "contacts", "notes", "tasks"]);
  assert.deepEqual(asked, [{ query: "Ana Prueba", limit: 5 }]);
  assert.deepEqual(result.contacts.matches.map((contact) => [contact.name, contact.emails[0].address, contact.birthday]), [["Ana Prueba", "ana@example.com", "1990-03-07"]]);
  assert.equal(result.whatsapp.matches[0].jid, ANA);

  // Never more than the best five, whatever the source returns.
  const many = otherSources({ contacts: async () => Array.from({ length: 9 }, (_, i) => ({ name: `Ana ${i}` })) });
  assert.equal((await lookupPerson({ query: "Ana", limit: 20, sources: many, policy: defaults, platform: "darwin" })).contacts.matches.length, 5);
});

test("a Contacts failure reports its own error and leaves the rest of the lookup alone", async () => {
  const denied = onMac({ access: 2 });
  const sources = otherSources({ contacts: (params) => denied.contacts.search(params) });
  const result = await lookupPerson({ query: "Ana", sources, policy: defaults, platform: "darwin" });
  assert.match(result.contacts.error, /Privacy & Security > Contacts/);
  assert.equal(result.whatsapp.matches[0].jid, ANA);
  assert.equal(result.notes[0].path, "personas/Ana Prueba.md");

  const closed = otherSources({ contacts: async () => { throw new Error("Open the SMCP app to use Contacts."); } });
  assert.deepEqual((await lookupPerson({ query: "Ana", sources: closed, policy: defaults, platform: "darwin" })).contacts, { error: "Open the SMCP app to use Contacts." });
  const slow = otherSources({ contacts: () => new Promise(() => {}) });
  assert.match((await lookupPerson({ query: "Ana", sources: slow, policy: defaults, platform: "darwin", timeoutMs: 30 })).contacts.error, /too long/);
});

test("contacts are left out when the caller says so, off a Mac, and while SMCP is paused", async () => {
  const sources = otherSources({ contacts: async () => assert.fail("must not look in Contacts") });
  assert.deepEqual((await lookupPerson({ query: "Ana", contacts: false, sources, policy: defaults, platform: "darwin" })).contacts, { skipped: "Left out of this lookup." });
  for (const platform of ["linux", "win32"]) {
    assert.deepEqual((await lookupPerson({ query: "Ana", sources, policy: defaults, platform })).contacts, { skipped: "Contacts are only available on a Mac." });
  }
  const paused = await lookupPerson({ query: "Ana", sources, policy: () => ({ ...defaults(), paused: true }), platform: "darwin" });
  assert.match(paused.contacts.skipped, /paused/);
  // Turning other areas off does not turn Contacts off: it has no switch of its own.
  const { contacts } = onMac();
  const policy = () => ({ ...defaults(), disabled: { ...defaults().disabled, whatsapp: true, gmail: true, notes: true, tasks: true } });
  const result = await lookupPerson({ query: "beto", sources: otherSources({ contacts: (params) => contacts.search(params) }), policy, platform: "darwin" });
  assert.match(result.whatsapp.skipped, /whatsapp/);
  assert.equal(result.contacts.matches[0].name, "Beto");
});

test("the people_lookup tool offers the contacts switch and passes it on", async () => {
  const tools = {};
  const seen = [];
  const sources = otherSources({ contacts: async (params) => (seen.push(params), [{ name: "Ana Prueba", organization: "", phones: [], emails: [], birthday: null }]) });
  registerPeople({ registerTool: (name, config, handler) => (tools[name] = { config, handler }) }, { sources, policy: defaults, platform: "darwin" });
  const { inputSchema, description, annotations } = tools.people_lookup.config;
  assert.match(description, /Contacts/);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(inputSchema.contacts.parse(undefined), true);
  const withContacts = JSON.parse((await tools.people_lookup.handler({ query: "Ana", limit: 5, contacts: true })).content[0].text);
  assert.equal(withContacts._untrusted_external, true);
  assert.equal(withContacts.data.contacts.matches[0].name, "Ana Prueba");
  const without = JSON.parse((await tools.people_lookup.handler({ query: "Ana", limit: 5, contacts: false })).content[0].text);
  assert.match(without.data.contacts.skipped, /Left out/);
  assert.equal(seen.length, 1);
});
