import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { auditEntry, clearAudit, readAudit, recordCall } from "../src/audit.js";
import { bufferText, documentKind, documentText } from "../src/documents.js";
import { createEventKit, friendlyEventKitError, REMINDERS } from "../src/eventkit.js";
import { denialFor, readPolicy, toolGroup } from "../src/policy.js";
import { buildBrief, unwrap } from "../src/tools/brief.js";
import { formatLocal, freeSlots, parseWhen, range, registerCalendar } from "../src/tools/calendar.js";
import { createClipboard } from "../src/tools/clipboard.js";
import { textResult } from "../src/util.js";

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-features-"));
});
after(() => rm(dir, { recursive: true, force: true }));

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const payload = (result) => {
  const data = JSON.parse(result.content[0].text);
  return data._untrusted_external ? data.data : data;
};

function fakeServer() {
  const tools = {};
  return { tools, registerTool: (name, config, handler) => (tools[name] = { config, handler }) };
}

// Activity log

test("el registro solo guarda nombre, origen, cliente, resultado y duración", () => {
  const entry = auditEntry({ tool: "whatsapp_send", source: "remote", client: "claude", outcome: "ok", ms: 12.4, message: "secreto", to: "+52" }, 0);
  assert.deepEqual(entry, { at: "1970-01-01T00:00:00.000Z", tool: "whatsapp_send", source: "remote", client: "claude", outcome: "ok", ms: 12 });
  assert.equal(auditEntry({ tool: "x", source: "otro", outcome: "raro" }).source, "local");
  assert.equal(auditEntry({ tool: "x", outcome: "raro" }).outcome, "failed");
});

test("el registro se lee del más nuevo al más viejo, ignora líneas dañadas y se puede borrar", async () => {
  const path = join(dir, "audit.jsonl");
  recordCall({ tool: "uno", outcome: "ok" }, path);
  recordCall({ tool: "dos", outcome: "denied" }, path);
  await writeFile(path, `${await readFile(path, "utf8")}{dañado\n`);
  recordCall({ tool: "tres", outcome: "error" }, path);
  assert.deepEqual(readAudit({ path }).map((entry) => entry.tool), ["tres", "dos", "uno"]);
  assert.equal(readAudit({ path, limit: 1 }).length, 1);
  clearAudit(path);
  assert.deepEqual(readAudit({ path }), []);
});

test("un registro imposible de escribir no rompe la herramienta", async () => {
  const blocker = join(dir, "es-un-archivo");
  await writeFile(blocker, "x");
  assert.doesNotThrow(() => recordCall({ tool: "x", outcome: "ok" }, join(blocker, "audit.jsonl")));
});

// Permissions

test("las áreas nuevas tienen su permiso, y portapapeles y Notas de Apple empiezan apagados", () => {
  assert.equal(toolGroup("calendar_list_events"), "calendar");
  assert.equal(toolGroup("reminders_create"), "reminders");
  assert.equal(toolGroup("applenotes_read"), "applenotes");
  assert.equal(toolGroup("clipboard_read"), "clipboard");
  assert.equal(toolGroup("screen_read_text"), "apps");
  const policy = readPolicy(join(dir, "no-existe.json"));
  assert.equal(policy.disabled.clipboard, true);
  assert.equal(policy.disabled.applenotes, true);
  assert.equal(policy.disabled.calendar, false);
  assert.match(denialFor("clipboard_read", { readOnlyHint: true }, policy), /clipboard/);
  assert.equal(denialFor("calendar_list_events", { readOnlyHint: true }, policy), null);
});

test("el resumen del día no tiene permiso propio, pero respeta la pausa", () => {
  const policy = readPolicy(join(dir, "no-existe.json"));
  assert.equal(denialFor("daily_brief", { readOnlyHint: true }, policy), null);
  assert.match(denialFor("daily_brief", { readOnlyHint: true }, { ...policy, paused: true }), /paused/);
});

test("crear borradores y eventos queda bloqueado en modo solo lectura", () => {
  const policy = { ...readPolicy(join(dir, "no-existe.json")), readOnly: true };
  assert.match(denialFor("gmail_draft", { readOnlyHint: false }, policy), /read-only/);
  assert.match(denialFor("calendar_create_event", { readOnlyHint: false, destructiveHint: true }, policy), /read-only/);
  assert.match(denialFor("whatsapp_send_file", { readOnlyHint: false, destructiveHint: true }, { ...policy, readOnly: false }), /Writing on WhatsApp is off/);
  assert.equal(denialFor("whatsapp_chat_digest", { readOnlyHint: true }, policy), null);
});

// Calendar

test("las fechas sueltas son medianoche local, y `to` incluye todo ese día", () => {
  assert.equal(parseWhen("2026-11-10"), local(2026, 11, 10));
  assert.equal(parseWhen("2026-11-10", { endOfDay: true }), local(2026, 11, 11));
  assert.equal(parseWhen("2026-12-31", { endOfDay: true }), local(2027, 1, 1));
  assert.throws(() => parseWhen("2026-02-30"), /valid date/);
  assert.throws(() => parseWhen("mañana"), /valid date/);
  assert.equal(parseWhen("2026-11-10T10:00:00Z"), Date.UTC(2026, 10, 10, 10));
  assert.throws(() => range({ from: "2026-11-10", to: "2026-11-09" }), /after/);
  assert.throws(() => range({ from: "2026-01-01", to: "2026-12-31" }), /at most/);
});

test("la hora local se muestra con su desfase", () => {
  assert.match(formatLocal(local(2026, 11, 10, 9, 5)), /^2026-11-10T09:05:00[+-]\d{2}:\d{2}$/);
});

test("los huecos libres respetan el horario, ignoran eventos de todo el día y los fines de semana", () => {
  // Tuesday 10 and Wednesday 11 of November 2026, plus a Saturday.
  const events = [
    { start: local(2026, 11, 10, 10), end: local(2026, 11, 10, 11), allDay: false },
    { start: local(2026, 11, 10, 10, 30), end: local(2026, 11, 10, 12), allDay: false },
    { start: local(2026, 11, 10, 17, 45), end: local(2026, 11, 10, 19), allDay: false },
    { start: local(2026, 11, 10), end: local(2026, 11, 11), allDay: true },
  ];
  const slots = freeSlots(events, { start: local(2026, 11, 10), end: local(2026, 11, 11), now: 0 });
  assert.deepEqual(
    slots.map((slot) => [slot.start.slice(11, 16), slot.end.slice(11, 16), slot.minutes]),
    [
      ["09:00", "10:00", 60],
      ["12:00", "17:45", 345],
    ],
  );
  const short = freeSlots([], { start: local(2026, 11, 10), end: local(2026, 11, 11), dayStart: "09:00", dayEnd: "09:20", minMinutes: 30, now: 0 });
  assert.deepEqual(short, []);
  const weekend = freeSlots([], { start: local(2026, 11, 14), end: local(2026, 11, 16), now: 0 });
  assert.deepEqual(weekend, []);
  assert.equal(freeSlots([], { start: local(2026, 11, 14), end: local(2026, 11, 15), weekends: true, now: 0 }).length, 1);
});

test("los huecos no empiezan en el pasado", () => {
  const slots = freeSlots([], { start: local(2026, 11, 10), end: local(2026, 11, 11), now: local(2026, 11, 10, 15, 0) });
  assert.equal(slots[0].start.slice(11, 16), "15:00");
});

test("las herramientas de calendario filtran, ordenan y arman bien el evento", async () => {
  const calls = [];
  const call = async (op, args) => {
    calls.push({ op, args });
    if (op === "events") {
      return {
        events: [
          { id: "b", title: "Comida", calendar: "Casa", start: local(2026, 11, 10, 14), end: local(2026, 11, 10, 15), allDay: false, location: "", notes: "" },
          { id: "a", title: "Junta con Ana", calendar: "Trabajo", start: local(2026, 11, 10, 9), end: local(2026, 11, 10, 10), allDay: false, location: "Oficina", notes: "" },
        ],
      };
    }
    return { id: "nuevo" };
  };
  const server = fakeServer();
  registerCalendar(server, { call });
  const listed = payload(await server.tools.calendar_list_events.handler({ from: "2026-11-10", to: "2026-11-10" }));
  assert.deepEqual(listed.events.map((event) => event.id), ["a", "b"]);
  const filtered = payload(await server.tools.calendar_list_events.handler({ from: "2026-11-10", query: "oficina" }));
  assert.deepEqual(filtered.events.map((event) => event.id), ["a"]);

  await server.tools.calendar_create_event.handler({ title: "Vacaciones", start: "2026-12-20", end: "2026-12-22" });
  const allDay = calls.at(-1);
  assert.equal(allDay.op, "createEvent");
  assert.equal(allDay.args.allDay, true);
  assert.equal(allDay.args.start, local(2026, 12, 20));
  assert.equal(allDay.args.end, local(2026, 12, 23) - 1000);

  await server.tools.calendar_create_event.handler({ title: "Café", start: "2026-12-20T10:00:00-06:00" });
  assert.equal(calls.at(-1).args.end - calls.at(-1).args.start, 60 * 60 * 1000);
  const bad = await server.tools.calendar_create_event.handler({ title: "Mal", start: "2026-12-20T10:00:00Z", end: "2026-12-20T09:00:00Z" });
  assert.equal(bad.isError, true);
});

test("un recordatorio con hora guarda la hora; con fecha sola, solo el día", async () => {
  const calls = [];
  const server = fakeServer();
  registerCalendar(server, { call: async (op, args) => (calls.push(args), {}) });
  await server.tools.reminders_create.handler({ title: "Pagar luz", due: "2026-11-15" });
  assert.equal(calls[0].dueHasTime, false);
  assert.equal(calls[0].due, local(2026, 11, 15));
  await server.tools.reminders_create.handler({ title: "Llamar", due: "2026-11-15T16:30:00-06:00" });
  assert.equal(calls[1].dueHasTime, true);
  await server.tools.reminders_create.handler({ title: "Sin fecha" });
  assert.equal(calls[2].due, null);
});

test("EventKit traduce sus códigos a frases y pasa los parámetros como datos", async () => {
  assert.match(friendlyEventKitError(new Error("NO_ACCESS:2")), /Privacy & Security > Calendar/);
  assert.match(friendlyEventKitError(new Error("NO_ACCESS:2"), REMINDERS), /Reminders/);
  assert.match(friendlyEventKitError(new Error("NO_CALENDAR")), /calendar_list_calendars/);
  const seen = [];
  const kit = createEventKit({
    jxa: async (prelude, script, params) => {
      seen.push(params);
      if (params.title === "falla") throw new Error("NO_ACCESS:2");
      return { status: 3, events: [] };
    },
  });
  assert.deepEqual(await kit.events({ from: 1, to: 2 }), { status: "granted", events: [] });
  assert.equal(seen[0].passive, false);
  await assert.rejects(kit.createEvent({ title: "falla" }), /System Settings/);
});

// Daily brief

test("el resumen junta cada sección, salta las apagadas y no se cae por una que falla", async () => {
  const policy = () => ({ ...readPolicy(join(dir, "no-existe.json")), disabled: { ...readPolicy(join(dir, "no-existe.json")).disabled, gmail: true } });
  const seen = {};
  const brief = await buildBrief({
    date: "2026-11-10",
    policy,
    timeoutMs: 50,
    sections: {
      calendar: { tool: "calendar_list_events", load: ({ start, end }) => ((seen.range = [start, end]), [{ title: "Junta" }]) },
      tasks: { tool: "tasks_available", load: async () => ({ available: 3 }) },
      whatsapp: { tool: "whatsapp_list_chats", load: async () => { throw new Error("WhatsApp is not linked."); } },
      gmail: { tool: "gmail_search", load: async () => ({ unread: [] }) },
      slow: { tool: "reminders_list", load: () => new Promise(() => {}) },
    },
  });
  assert.equal(brief.date, "2026-11-10");
  assert.deepEqual(seen.range, [local(2026, 11, 10), local(2026, 11, 11)]);
  assert.deepEqual(brief.calendar, [{ title: "Junta" }]);
  assert.deepEqual(brief.tasks, { available: 3 });
  assert.deepEqual(brief.whatsapp, { error: "WhatsApp is not linked." });
  assert.match(brief.gmail.skipped, /gmail/);
  assert.match(brief.slow.error, /too long/);
});

test("unwrap devuelve los datos de un resultado y lanza el texto de un error", () => {
  assert.deepEqual(unwrap(textResult({ _untrusted_external: true, data: [1] })), [1]);
  assert.throws(() => unwrap({ isError: true, content: [{ type: "text", text: "no" }] }), /no/);
});

// Clipboard and documents

test("el portapapeles pasa el texto como dato, nunca dentro del script", async () => {
  const seen = [];
  const clipboard = createClipboard({ jxa: async (prelude, script, params) => (seen.push({ script, params }), { written: true }) });
  await clipboard.write({ text: '"); doShellScript("rm -rf ~' });
  assert.ok(!seen[0].script.includes("doShellScript"));
  assert.equal(seen[0].params.text, '"); doShellScript("rm -rf ~');
});

test("reconoce qué documentos puede convertir en texto", async () => {
  assert.equal(documentKind("Reporte.PDF"), "pdf");
  assert.equal(documentKind("carta.docx"), "textutil");
  assert.equal(documentKind("datos.csv"), "plain");
  assert.equal(documentKind("foto.jpg"), null);
  assert.deepEqual(await bufferText("notas.txt", Buffer.from("hola ñ")), { text: "hola ñ" });
  await assert.rejects(bufferText("foto.jpg", Buffer.from("x")), /cannot be turned into text/);
  const calls = [];
  const exec = async (file, args) => (calls.push([file, args]), { code: 0, stdout: "texto de Word", stderr: "" });
  assert.deepEqual(await documentText("/tmp/-x.docx", { exec }), { text: "texto de Word" });
  assert.deepEqual(calls[0], ["/usr/bin/textutil", ["-convert", "txt", "-stdout", "--", "/tmp/-x.docx"]]);
  await assert.rejects(documentText("/tmp/x.pdf", { jxa: async () => { throw new Error("LOCKED"); } }), /password/);
});
