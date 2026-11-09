import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createAccountStore, createGmail, friendlyMailError, normalizeCredentials } from "../app/core/gmail.js";
import { denialFor, readPolicy, toolGroup } from "../src/policy.js";

const PASSWORD = "abcdefghijklmnop";
let dir;
let path;
let store;
const encrypt = (text) => Buffer.from(`enc:${text}`).toString("base64");
const decrypt = (secret) => Buffer.from(secret, "base64").toString().replace(/^enc:/, "");

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-gmail-"));
});
after(() => rm(dir, { recursive: true, force: true }));
beforeEach(async () => {
  path = join(dir, `${Math.random()}.json`);
  store = createAccountStore({ path, encrypt, decrypt });
});

function fakeImap({ uids = [1, 2, 3], connectError } = {}) {
  const log = { connected: [], searches: [], locks: [], fetched: [] };
  const factory = (credentials) => ({
    connect: async () => {
      if (connectError) throw connectError;
      log.connected.push(credentials);
    },
    logout: async () => {},
    list: async () => [{ path: "INBOX" }, { path: "[Gmail]/Todos", specialUse: "\\All" }],
    getMailboxLock: async (name, options) => {
      log.locks.push({ name, options });
      return { release() {} };
    },
    search: async (query) => {
      log.searches.push(query);
      return uids;
    },
    async *fetch(list) {
      log.fetched.push(list);
      for (const uid of list) {
        yield {
          uid,
          envelope: { from: [{ name: "Ana", address: "ana@x.com" }], subject: `S${uid}`, date: new Date(2026, 0, uid) },
          flags: new Set(uid === 3 ? [] : ["\\Seen"]),
        };
      }
    },
    fetchOne: async (uid, query) =>
      query.source
        ? { source: Buffer.from("From: Ana <ana@x.com>\r\nSubject: Hola\r\nContent-Type: text/plain\r\n\r\nCuerpo ñ\r\n") }
        : { envelope: { messageId: `<m${uid}@x>` } },
  });
  return { factory, log };
}

function fakeSmtp() {
  const sent = [];
  return { sent, factory: () => ({ sendMail: async (mail) => (sent.push(mail), { messageId: "<id>", accepted: mail.to }), close() {} }) };
}

test("valida correo y contraseña; acepta la contraseña con espacios como la muestra Google", () => {
  const clean = normalizeCredentials({ label: " Trabajo ", email: " Ana@X.COM ", password: "abcd efgh ijkl mnop" });
  assert.deepEqual(clean, { label: "Trabajo", email: "ana@x.com", password: PASSWORD });
  assert.throws(() => normalizeCredentials({ email: "no", password: PASSWORD }), /email/);
  assert.throws(() => normalizeCredentials({ email: "a@x.com", password: "MiClaveNormal1" }), /16 letters/);
});

test("la contraseña se guarda cifrada, con permisos privados, y nunca sale en la lista", async () => {
  await store.add({ label: "Trabajo", email: "a@x.com", password: PASSWORD });
  const text = await readFile(path, "utf8");
  assert.ok(!text.includes(PASSWORD));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.list(), [{ label: "Trabajo", email: "a@x.com" }]);
  assert.equal((await store.credentials("a@x.com")).password, PASSWORD);
});

test("varias cuentas: agregar la misma la reemplaza y quitar borra solo esa", async () => {
  await store.add({ label: "A", email: "a@x.com", password: PASSWORD });
  await store.add({ label: "B", email: "b@x.com", password: PASSWORD });
  await store.add({ label: "A2", email: "a@x.com", password: PASSWORD });
  assert.equal((await store.list()).length, 2);
  await store.remove("a@x.com");
  assert.deepEqual((await store.list()).map((account) => account.email), ["b@x.com"]);
});

test("si Google rechaza el acceso, la cuenta no se guarda", async () => {
  const { factory } = fakeImap({ connectError: Object.assign(new Error("x"), { authenticationFailed: true }) });
  const gmail = createGmail({ store, confirm: async () => true, imap: factory });
  await assert.rejects(gmail.verifyAndAdd({ email: "a@x.com", password: PASSWORD }), /refused/);
  assert.deepEqual(await store.list(), []);
});

test("los errores no exponen detalles internos ni la contraseña", () => {
  const message = friendlyMailError(new Error(`algo raro con ${PASSWORD}`));
  assert.ok(!message.includes(PASSWORD));
});

test("busca en Todos, en solo lectura, con la sintaxis de Gmail y los más recientes primero", async () => {
  await store.add({ label: "A", email: "a@x.com", password: PASSWORD });
  const { factory, log } = fakeImap();
  const gmail = createGmail({ store, confirm: async () => false, imap: factory });
  const result = await gmail.search({ account: "a", query: "is:unread", limit: 2 });
  assert.equal(log.locks[0].name, "[Gmail]/Todos");
  assert.equal(log.locks[0].options.readOnly, true);
  assert.deepEqual(log.searches[0], { gmraw: "is:unread" });
  assert.deepEqual(log.fetched[0], [2, 3]);
  assert.deepEqual(result.messages.map((message) => message.uid), [3, 2]);
  assert.equal(result.messages[0].unread, true);
  assert.equal(result.totals["a@x.com"], 3);
});

test("sin cuenta busca en todas; si una falla, sigue con las demás y lo reporta", async () => {
  await store.add({ label: "A", email: "a@x.com", password: PASSWORD });
  await store.add({ label: "B", email: "b@x.com", password: PASSWORD });
  const good = fakeImap();
  const factory = (credentials) =>
    credentials.email === "b@x.com"
      ? { connect: async () => { throw Object.assign(new Error("x"), { authenticationFailed: true }); }, logout: async () => {} }
      : good.factory(credentials);
  const gmail = createGmail({ store, confirm: async () => false, imap: factory });
  const result = await gmail.search({});
  assert.deepEqual(log(result), { messages: 3, errors: ["b@x.com"] });
  assert.deepEqual(good.log.searches[0], { gmraw: "in:inbox" });
  function log(value) {
    return { messages: value.messages.length, errors: value.errors.map((error) => error.account) };
  }
});

test("lee el correo con acentos", async () => {
  await store.add({ label: "A", email: "a@x.com", password: PASSWORD });
  const gmail = createGmail({ store, confirm: async () => false, imap: fakeImap().factory });
  const message = await gmail.read({ account: "a@x.com", uid: 7 });
  assert.equal(message.subject, "Hola");
  assert.equal(message.text, "Cuerpo ñ");
  await assert.rejects(gmail.read({ account: "a@x.com", uid: 0 }), /Invalid/);
  await assert.rejects(gmail.read({ account: "nadie", uid: 1 }), /No connected account/);
});

test("cancelar la ventana no envía; la ventana muestra cuenta, destino, asunto y texto", async () => {
  await store.add({ label: "Trabajo", email: "a@x.com", password: PASSWORD });
  const smtp = fakeSmtp();
  let shown;
  const gmail = createGmail({ store, smtp: smtp.factory, imap: fakeImap().factory, confirm: async (text) => ((shown = text), false) });
  const result = await gmail.send({ account: "trabajo", to: ["b@y.com"], subject: "Asunto", body: "Texto" });
  assert.equal(result.sent, false);
  assert.equal(smtp.sent.length, 0);
  assert.ok(shown.startsWith("From: Trabajo (a@x.com)\nTo: b@y.com\nSubject: Asunto"));
  assert.ok(shown.endsWith("Texto"));
});

test("confirmar envía desde la cuenta elegida y mantiene la conversación al responder", async () => {
  await store.add({ label: "A", email: "a@x.com", password: PASSWORD });
  const smtp = fakeSmtp();
  const gmail = createGmail({ store, smtp: smtp.factory, imap: fakeImap().factory, confirm: async () => true });
  const result = await gmail.send({ account: "a@x.com", to: ["b@y.com"], subject: "Re", body: "Hola", reply_to_uid: 9 });
  assert.equal(result.sent, true);
  assert.equal(smtp.sent[0].from.address, "a@x.com");
  assert.equal(smtp.sent[0].inReplyTo, "<m9@x>");
});

test("no pregunta ni envía con datos inválidos o inyección en el asunto", async () => {
  await store.add({ label: "A", email: "a@x.com", password: PASSWORD });
  const smtp = fakeSmtp();
  let asked = false;
  const gmail = createGmail({ store, smtp: smtp.factory, imap: fakeImap().factory, confirm: async () => ((asked = true), true) });
  const base = { account: "a@x.com", to: ["b@y.com"], subject: "S", body: "T" };
  for (const bad of [
    { to: ["no-es-correo"] },
    { to: ["a@x.com\nBcc: c@z.com"] },
    { to: Array(11).fill("b@y.com") },
    { subject: "Hola\r\nBcc: c@z.com" },
    { body: "   " },
    { body: "x".repeat(2001) },
  ]) {
    await assert.rejects(gmail.send({ ...base, ...bad }));
  }
  assert.equal(asked, false);
  assert.equal(smtp.sent.length, 0);
});

test("Gmail tiene su propio permiso y respeta solo lectura", () => {
  assert.equal(toolGroup("gmail_send"), "gmail");
  const policy = readPolicy(join(dir, "no-existe.json"));
  assert.equal(policy.disabled.gmail, false);
  assert.match(denialFor("gmail_send", { destructiveHint: true }, { ...policy, readOnly: true }), /read-only/);
  assert.equal(denialFor("gmail_search", { readOnlyHint: true }, { ...policy, readOnly: true }), null);
  assert.match(denialFor("gmail_search", { readOnlyHint: true }, { ...policy, disabled: { ...policy.disabled, gmail: true } }), /turned off/);
});
