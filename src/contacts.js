// macOS Contacts, read only, through the Contacts framework. macOS ties the permission to the app
// that asks, so SMCP.app runs this (see `localContacts`), like Calendar and Apple Notes.
import { runJxa, WAIT_FOR } from "./jxa.js";

const MAX_RESULTS = 20;

/** The keys are written out because their constants (CNContactGivenNameKey…) are just these names. */
const PRELUDE = `
ObjC.import("Foundation");
ObjC.import("Contacts");
${WAIT_FOR}
const KEYS = ["givenName", "familyName", "nickname", "organizationName", "phoneNumbers", "emailAddresses", "birthday"];
const status = () => Number($.CNContactStore.authorizationStatusForEntityType(0));
function request() {
  const store = $.CNContactStore.alloc.init;
  let finished = false;
  store.requestAccessForEntityTypeCompletionHandler(0, () => { finished = true; });
  waitFor(() => finished, 60);
  return status();
}
/** Asks the first time; afterwards macOS remembers the answer and never asks again. */
function open() {
  const current = status() === 0 ? request() : status();
  if (current !== 3) throw new Error("NO_ACCESS:" + current);
  return $.CNContactStore.alloc.init;
}
const str = (value) => (value && !value.isNil() ? value.js : "");
function predicateFor(a) {
  if (a.kind === "email") return $.CNContact.predicateForContactsMatchingEmailAddress($(a.query));
  if (a.kind === "phone") return $.CNContact.predicateForContactsMatchingPhoneNumber($.CNPhoneNumber.phoneNumberWithStringValue($(a.query)));
  return $.CNContact.predicateForContactsMatchingName($(a.query));
}
function labeled(values, read) {
  const out = [];
  for (let i = 0; values && !values.isNil() && i < values.count; i++) {
    const item = values.objectAtIndex(i);
    const label = item.label;
    out.push({ label: label && !label.isNil() ? str($.CNLabeledValue.localizedStringForLabel(label)) : "", value: read(item.value) });
  }
  return out;
}
function describe(c) {
  const day = c.birthday;
  return {
    given: str(c.givenName),
    family: str(c.familyName),
    nickname: str(c.nickname),
    organization: str(c.organizationName),
    phones: labeled(c.phoneNumbers, (value) => str(value.stringValue)),
    emails: labeled(c.emailAddresses, (value) => str(value)),
    birthday: day && !day.isNil() ? { year: Number(day.year), month: Number(day.month), day: Number(day.day) } : null,
  };
}
`;

const SEARCH = `
function main(a) {
  const store = open();
  const error = Ref();
  const found = store.unifiedContactsMatchingPredicateKeysToFetchError(predicateFor(a), $(KEYS), error);
  if (!found || found.isNil()) throw new Error("FETCH_FAILED:" + (error[0] && !error[0].isNil() ? error[0].localizedDescription.js : ""));
  const contacts = [];
  for (let i = 0; i < found.count && contacts.length < a.limit; i++) contacts.push(describe(found.objectAtIndex(i)));
  return { contacts };
}`;

/** Contacts matches names by word, and has its own matchers for an email address and a phone number. */
export function queryKind(query) {
  if (query.includes("@")) return "email";
  return /^\+?\d{5,}$/.test(query.replace(/[\s().-]/g, "")) ? "phone" : "name";
}

/** A birthday saved without its year comes back with a huge number in its place, or with 1604 from older address books. */
function birthday(parts) {
  const month = Number(parts?.month);
  const day = Number(parts?.day);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const pad = (n, size = 2) => String(n).padStart(size, "0");
  const year = Number(parts.year);
  return `${year >= 1 && year <= 9999 && year !== 1604 ? `${pad(year, 4)}-` : ""}${pad(month)}-${pad(day)}`;
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

function presentContact(contact) {
  const entries = (list, name) =>
    (Array.isArray(list) ? list : []).map((item) => ({ label: text(item?.label), [name]: text(item?.value) })).filter((item) => item[name]);
  const organization = text(contact?.organization);
  return {
    name: [text(contact?.given), text(contact?.family)].filter(Boolean).join(" ") || text(contact?.nickname) || organization,
    organization,
    phones: entries(contact?.phones, "number"),
    emails: entries(contact?.emails, "address"),
    birthday: birthday(contact?.birthday),
  };
}

/** Turns the script's short codes into sentences a person can act on. */
export function friendlyContactsError(error) {
  const message = String(error?.message ?? "");
  if (/NO_ACCESS/.test(message) || /has not given SMCP permission/.test(message)) {
    return "SMCP cannot use your Contacts. Allow it in System Settings > Privacy & Security > Contacts, and turn on SMCP.";
  }
  if (/FETCH_FAILED/.test(message)) return `Contacts did not answer: ${message.split("FETCH_FAILED:")[1]?.trim() || "unknown reason"}.`;
  return "Could not read this Mac's Contacts.";
}

/** Dependencies are injectable so tests never touch real contacts. */
export function createContacts({ jxa = runJxa, platform = process.platform } = {}) {
  return {
    async search({ query, limit = 5 } = {}) {
      if (platform !== "darwin") throw new Error("Contacts are only available on a Mac.");
      const clean = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!clean) throw new Error("Type a name, phone number or email address.");
      const size = Math.min(Math.max(Math.trunc(Number(limit)) || 5, 1), MAX_RESULTS);
      let found;
      try {
        found = await jxa(PRELUDE, SEARCH, { query: clean, kind: queryKind(clean), limit: size }, { timeoutMs: 70_000, failure: "" });
      } catch (error) {
        throw new Error(friendlyContactsError(error));
      }
      return (Array.isArray(found?.contacts) ? found.contacts : []).slice(0, size).map(presentContact);
    },
  };
}

/** Runs in this process. SMCP.app calls it so the Contacts permission is asked under its name. */
export function localContacts(params = {}, options) {
  return createContacts(options).search(params ?? {});
}
