import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTaskStore } from "../app/core/tasks.js";
import { readPolicy } from "../src/policy.js";
import {
  classifyChat,
  classifyEmail,
  findFollowups,
  FOLLOWUP_MARKER,
  followupsToTasks,
  followupTask,
  isDirectChat,
  lookupPerson,
  parseAddresses,
  registerPeople,
  threadSubject,
} from "../src/tools/people.js";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 9, 18, 0);
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();
const ANA = "5215512345678@s.whatsapp.net";
const BETO = "5218112345678@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const OPTS = { now: NOW, answerAfterMs: 3 * HOUR, waitMs: 48 * HOUR };

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-people-"));
});
after(() => rm(dir, { recursive: true, force: true }));

const defaults = () => readPolicy(join(dir, "no-config.json"));
const msg = (id, hours, fromMe, text, extra = {}) => ({ MsgID: id, Timestamp: ago(hours), FromMe: fromMe, Text: text, SenderName: fromMe ? "" : "Ana", ...extra });

// WhatsApp

test("solo cuentan los chats con una persona, no grupos, canales ni estados", () => {
  assert.ok(isDirectChat({ jid: ANA, kind: "dm" }));
  assert.ok(isDirectChat({ jid: "123@lid" }));
  assert.ok(!isDirectChat({ jid: GROUP, kind: "group" }));
  assert.ok(!isDirectChat({ jid: "status@broadcast" }));
  assert.ok(!isDirectChat({ jid: "1@newsletter" }));
});

test("si la otra persona escribió al último y pasó el tiempo, espera respuesta, con sus últimos mensajes", () => {
  const chat = { jid: ANA, name: "Ana", unread: true };
  const item = classifyChat(chat, [msg("C", 5, false, "¿me mandas el contrato?"), msg("B", 6, false, "Hola"), msg("A", 30, true, "Te aviso")], OPTS);
  assert.equal(item.kind, "to_answer");
  assert.equal(item.key, "fu:wa:C");
  assert.equal(item.name, "Ana");
  assert.equal(item.hours, 5);
  assert.equal(item.unread, true);
  assert.deepEqual(item.preview, ["Hola", "¿me mandas el contrato?"]);
});

test("un mensaje reciente, un 'gracias' o una reacción no cuentan como pendientes", () => {
  const chat = { jid: ANA, name: "Ana" };
  assert.equal(classifyChat(chat, [msg("A", 1, false, "¿Vienes?")], OPTS), null);
  assert.equal(classifyChat(chat, [msg("B", 10, false, "Muchas gracias!"), msg("A", 11, true, "Listo")], OPTS), null);
  assert.equal(classifyChat(chat, [msg("B", 10, false, "👍")], OPTS), null);
  // The reaction is newer but is not a message: the last real one is mine and asks nothing.
  assert.equal(classifyChat(chat, [msg("R", 4, false, "", { ReactionToID: "A", ReactionEmoji: "❤️" }), msg("A", 60, true, "Ahí va el archivo")], OPTS), null);
});

test("si la persona preguntó y nadie contestó en días, queda esperando; si no preguntó, no", () => {
  const chat = { jid: BETO, name: "Beto" };
  const waiting = classifyChat(chat, [msg("A", 72, true, "Me confirmas si quedó el pago")], OPTS);
  assert.equal(waiting.kind, "waiting_on");
  assert.equal(waiting.name, "Beto");
  assert.equal(classifyChat(chat, [msg("A", 72, true, "Ahí te dejo el archivo")], OPTS), null);
  assert.equal(classifyChat(chat, [msg("A", 20, true, "¿Ya quedó?")], OPTS), null);
});

function fakeWhatsApp({ chats, messages, calls = [] }) {
  return async (args) => {
    calls.push(args);
    if (args[0] === "chats") return chats;
    if (args[0] === "messages") return { messages: messages[args.find((a) => a.startsWith("--chat=")).slice(7)] ?? [] };
    if (args[0] === "contacts") return [];
    throw new Error("unexpected");
  };
}

const CHATS = [
  { jid: ANA, kind: "dm", name: "Ana", last_message_ts: ago(5), unread: true },
  { jid: BETO, kind: "dm", name: "Beto", last_message_ts: ago(72) },
  { jid: GROUP, kind: "group", name: "Familia", last_message_ts: ago(4) },
  { jid: "5213300000000@s.whatsapp.net", kind: "dm", name: "Silenciado", last_message_ts: ago(5), muted_until: -1 },
  { jid: "5213300000001@s.whatsapp.net", kind: "dm", name: "Viejo", last_message_ts: ago(24 * 40) },
];
const MESSAGES = {
  [ANA]: [msg("A2", 5, false, "¿Lo vemos mañana?")],
  [BETO]: [msg("B1", 72, true, "¿Ya tienes la cotización?")],
};

test("los seguimientos juntan WhatsApp y Gmail, el que más lleva esperando primero", async () => {
  const calls = [];
  const sources = {
    whatsapp: fakeWhatsApp({ chats: CHATS, messages: MESSAGES, calls }),
    gmailSearch: async ({ query }) =>
      query.startsWith("in:inbox")
        ? { messages: [{ account: "yo@x.com", uid: 9, from: "Carla <carla@y.com>", subject: "Propuesta", date: ago(30), unread: true }] }
        : { messages: [] },
  };
  const result = await findFollowups({ sources, policy: defaults, now: NOW });
  assert.deepEqual(result.to_answer.map((item) => item.name), ["Carla", "Ana"]);
  assert.deepEqual(result.waiting_on.map((item) => item.name), ["Beto"]);
  assert.equal(result.whatsapp.checked, 2);
  // Neither the group, the muted chat nor the old one were opened.
  const opened = calls.filter((args) => args[0] === "messages").map((args) => args[2]);
  assert.deepEqual(opened.sort(), [`--chat=${ANA}`, `--chat=${BETO}`].sort());
});

test("un área apagada se salta y dice por qué; las demás siguen", async () => {
  const policy = () => ({ ...defaults(), disabled: { ...defaults().disabled, gmail: true } });
  const sources = { whatsapp: fakeWhatsApp({ chats: CHATS, messages: MESSAGES }), gmailSearch: async () => assert.fail("Gmail is off") };
  const result = await findFollowups({ sources, policy, now: NOW });
  assert.match(result.gmail.skipped, /gmail/);
  assert.equal(result.to_answer.length, 1);

  const noRead = () => ({ ...defaults(), whatsapp: { read: false, send: true, audio: false } });
  const blocked = await findFollowups({ sources: { ...sources, gmailSearch: async () => ({ messages: [] }) }, policy: noRead, now: NOW });
  assert.match(blocked.whatsapp.skipped, /Reading WhatsApp/);
});

// Gmail

test("el asunto de la conversación ignora Re:, RV:, Fwd:, acentos y mayúsculas", () => {
  assert.equal(threadSubject("RE: Rv: Fwd:  Cotización Q4"), "cotizacion q4");
  assert.equal(threadSubject("Re[2]: Plan"), "plan");
});

test("lee nombres y direcciones de una lista de destinatarios", () => {
  assert.deepEqual(parseAddresses('"Pérez, Ana" <Ana@X.com>, beto@y.com'), [
    { name: "Pérez, Ana", address: "ana@x.com" },
    { name: "", address: "beto@y.com" },
  ]);
});

test("Gmail: lo recibido sin contestar espera respuesta; lo contestado y los robots no", () => {
  const received = [
    { account: "a", uid: 1, from: "Ana <ana@x.com>", subject: "Plan", date: ago(30) },
    { account: "a", uid: 2, from: "Beto <beto@x.com>", subject: "Factura", date: ago(30) },
    { account: "a", uid: 3, from: "no-reply@banco.com", subject: "Estado de cuenta", date: ago(30) },
  ];
  const sent = [{ account: "a", uid: 50, to: "beto@x.com", subject: "RE: Factura", date: ago(10) }];
  const items = classifyEmail(received, sent, OPTS);
  assert.deepEqual(items.map((item) => [item.kind, item.name]), [["to_answer", "Ana"]]);
});

test("Gmail: lo que la persona mandó y nadie contestó en días queda esperando", () => {
  const sent = [{ account: "a", uid: 7, to: "Carla <carla@y.com>", subject: "Propuesta", date: ago(80) }];
  const received = [{ account: "a", uid: 8, from: "Carla <carla@y.com>", subject: "Re: Propuesta", date: ago(90) }];
  const [item] = classifyEmail(received, sent, OPTS);
  assert.equal(item.kind, "waiting_on");
  assert.equal(item.name, "Carla");
  assert.equal(item.key, "fu:gm:a:7");
});

// Follow-ups into tasks

function taskSource(path) {
  const store = createTaskStore({ path, now: () => NOW });
  return (op, args) => store[op](args);
}

const scanSources = (tasks) => ({
  whatsapp: fakeWhatsApp({ chats: CHATS, messages: MESSAGES }),
  gmailSearch: async () => ({ messages: [] }),
  tasks,
});

test("la tarea va en el idioma de la app, con la fuente y la marca del seguimiento", () => {
  const item = { source: "whatsapp", key: "fu:wa:A2", chat: ANA, name: "Ana", last_at: ago(5), preview: ["¿Lo vemos\nmañana?"] };
  const task = followupTask(item, "to_answer", { language: "es", now: NOW });
  assert.equal(task.name, "Contestar a Ana");
  assert.equal(task.planned, "2026-11-09");
  assert.equal(task.for_claude, false);
  assert.match(task.note, /> ¿Lo vemos mañana\?/);
  assert.match(task.note, new RegExp(`${FOLLOWUP_MARKER} fu:wa:A2`));
  assert.match(task.note, /Fuente: WhatsApp 5215512345678@s\.whatsapp\.net$/);
  const waiting = followupTask({ ...item, name: "Beto" }, "waiting_on", { language: "en" });
  assert.equal(waiting.name, "Follow up with Beto");
  assert.equal(waiting.waiting_for, "Beto");
  assert.equal(waiting.planned, undefined);
});

test("cada seguimiento se vuelve tarea una sola vez, aunque se corra todos los días", async () => {
  const path = join(dir, "tasks-once.json");
  const tasks = taskSource(path);
  const first = await followupsToTasks({ sources: scanSources(tasks), policy: defaults, language: "es", now: NOW });
  assert.deepEqual(first.created.map((item) => item.name).sort(), ["Contestar a Ana", "Dar seguimiento a Beto"]);

  const second = await followupsToTasks({ sources: scanSources(taskSource(path)), policy: defaults, language: "es", now: NOW });
  assert.equal(second.created.length, 0);
  assert.equal(second.already_tasks.length, 2);

  const saved = createTaskStore({ path, now: () => NOW });
  const beto = saved.search({ query: "Beto" }).tareas[0];
  assert.ok(beto.tags.some((tag) => tag === "Beto"), "Beto goes under Waiting for");
});

test("un mensaje nuevo de alguien con tarea abierta se agrega a su nota en vez de duplicarla", async () => {
  const path = join(dir, "tasks-twin.json");
  const store = createTaskStore({ path, now: () => NOW });
  const open = store.create({ name: "Contestar a Ana", note: "de antes" });
  const result = await followupsToTasks({ sources: scanSources(taskSource(path)), policy: defaults, language: "es", now: NOW, keys: ["fu:wa:A2"] });
  assert.equal(result.created.length, 0);
  assert.deepEqual(result.added_to_existing.map((item) => item.id), [open.id]);
  const note = createTaskStore({ path, now: () => NOW }).search({ query: "fu:wa:A2" }).tareas;
  assert.equal(note.length, 1);
});

test("solo los seguimientos pedidos por key, y avisa cuáles ya no están", async () => {
  const path = join(dir, "tasks-keys.json");
  const result = await followupsToTasks({ sources: scanSources(taskSource(path)), policy: defaults, now: NOW, keys: ["fu:wa:B1", "fu:wa:nope"] });
  assert.deepEqual(result.created.map((item) => item.key), ["fu:wa:B1"]);
  assert.deepEqual(result.not_found, ["fu:wa:nope"]);
});

test("en solo lectura o con Tareas apagado no se crea nada", async () => {
  const tasks = () => assert.fail("must not touch tasks");
  await assert.rejects(followupsToTasks({ sources: scanSources(tasks), policy: () => ({ ...defaults(), readOnly: true }), now: NOW }), /read-only/);
  await assert.rejects(
    followupsToTasks({ sources: scanSources(tasks), policy: () => ({ ...defaults(), disabled: { ...defaults().disabled, tasks: true } }), now: NOW }),
    /tasks/,
  );
});

// People

test("people_lookup junta contacto, chat, correos, notas y tareas de una persona", async () => {
  const sources = {
    whatsapp: async (args) =>
      args[0] === "contacts"
        ? [{ jid: ANA, name: "Ana", alias: "Ana Pérez", phone: "+5215512345678" }]
        : [{ jid: ANA, kind: "dm", name: "Ana", last_message_ts: ago(2), unread_count: 3 }, { jid: GROUP, kind: "group", name: "Ana y Beto", last_message_ts: ago(9) }],
    gmailSearch: async ({ query }) => {
      assert.equal(query, '{from:"Ana Pérez" to:"Ana Pérez" cc:"Ana Pérez"}');
      return {
        messages: [
          { account: "yo@x.com", uid: 3, from: "Ana Pérez <ana@x.com>", to: "yo@x.com", subject: "Plan", date: ago(5) },
          { account: "yo@x.com", uid: 2, from: "yo@x.com", to: "Ana Perez <ana@x.com>, beto@x.com", subject: "Re: Plan", date: ago(20) },
        ],
      };
    },
    notesSearch: async () => [{ vault: "Brain", path: "personas/Ana Pérez.md" }],
    tasks: async (op, args) => ({ total: 1, tareas: [{ id: "t1", name: `Llamar a ${args.query}` }] }),
  };
  const result = await lookupPerson({ query: 'Ana "Pérez"', sources, policy: defaults });
  assert.equal(result.query, "Ana Pérez");
  assert.deepEqual(result.whatsapp.matches.map((m) => [m.jid, m.kind]), [[ANA, "person"], [GROUP, "group"]]);
  assert.equal(result.whatsapp.matches[0].name, "Ana Pérez");
  assert.equal(result.whatsapp.matches[0].unread, 3);
  // Only Ana's address, not the account itself nor Beto, and accents do not matter.
  assert.deepEqual(result.email.addresses.map((a) => [a.address, a.messages]), [["ana@x.com", 2]]);
  assert.equal(result.notes[0].path, "personas/Ana Pérez.md");
  assert.equal(result.tasks.tareas[0].name, "Llamar a Ana Pérez");
});

test("people_lookup respeta cada permiso por separado", async () => {
  const policy = () => ({ ...defaults(), disabled: { ...defaults().disabled, notes: true, whatsapp: true } });
  const sources = {
    whatsapp: async () => assert.fail("off"),
    notesSearch: async () => assert.fail("off"),
    gmailSearch: async () => ({ messages: [] }),
    tasks: async () => ({ total: 0, tareas: [] }),
  };
  const result = await lookupPerson({ query: "Ana", sources, policy });
  assert.match(result.whatsapp.skipped, /whatsapp/);
  assert.match(result.notes.skipped, /notes/);
  assert.deepEqual(result.email.addresses, []);
  await assert.rejects(lookupPerson({ query: ' "" ', sources, policy }), /name/);
});

test("las herramientas se registran con sus anotaciones y devuelven datos externos marcados", async () => {
  const tools = {};
  registerPeople(
    { registerTool: (name, config, handler) => (tools[name] = { config, handler }) },
    { sources: scanSources(async () => ({ total: 0, tareas: [] })), policy: defaults, now: NOW },
  );
  assert.deepEqual(Object.keys(tools).sort(), ["followups_list", "followups_to_tasks", "people_lookup"]);
  assert.equal(tools.people_lookup.config.annotations.readOnlyHint, true);
  assert.equal(tools.followups_list.config.annotations.readOnlyHint, true);
  assert.equal(tools.followups_to_tasks.config.annotations.readOnlyHint, false);
  const result = await tools.followups_list.handler({ days: 14, answer_after_hours: 3, wait_days: 2, limit: 30 });
  assert.equal(JSON.parse(result.content[0].text)._untrusted_external, true);
});
