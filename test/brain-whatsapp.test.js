// The WhatsApp exporter must write the vault exactly as the reference scripts it replaces did:
// the notes already there are appended to, and one different byte in a file name or a line
// duplicates a chat. The golden files under fixtures/brain-whatsapp were produced by running
// those scripts on an invented store; the last test runs them live when they are available.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { exportWhatsApp, jidVariants, mergeSeedAliases, mergeSeedState, normName, validateFolder } from "../src/brain/whatsapp-export.js";
import {
  buildIndex,
  createLocalClock,
  fnv1a36,
  frontMatter,
  indexExistingNotes,
  messageText,
  normalizeKind,
  normalizeMessages,
  renderBlock,
  sanitizeName,
  senderLabel,
  tailLines,
  yamlQuote,
} from "../src/brain/whatsapp-notes.js";
import { compareCodePoints, isoUtc, parseIsoDateTime, pyRound1, pySplit, pySplitlines, pyStrip } from "../src/brain/whatsapp-pytext.js";
import { createSqlite, queryRows, snapshotStore, sqlLiteral } from "../src/brain/whatsapp-store.js";
import { REFERENCE_SCRIPTS, WA_FOLDER, comparableChats, expectedResult, findCommand, loadSql, readTree, runReference, writeTree } from "./fixtures/brain-whatsapp/harness.mjs";
import { SCHEMA, buildScenario, hash36 } from "./fixtures/brain-whatsapp/scenario.mjs";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "brain-whatsapp", "golden");
const WA = WA_FOLDER.split("/");

const storeSkip =
  process.platform === "win32"
    ? "the tests that read a store are not run on Windows"
    : findCommand(["sqlite3"], "-version")
      ? false
      : "the sqlite3 command-line tool is not installed";

const scratch = mkdtempSync(join(tmpdir(), "smcp-brain-wa-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let boxes = 0;
const box = () => {
  const dir = join(scratch, String(++boxes));
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Where one exporter under test keeps everything: a vault, a store, and its own files outside the vault. */
function workspace(seed) {
  const root = box();
  const vault = join(root, "vault");
  mkdirSync(join(root, "store"), { recursive: true });
  if (typeof seed === "string") cpSync(seed, vault, { recursive: true });
  else writeTree(vault, seed ?? {});
  mkdirSync(vault, { recursive: true });
  return {
    root,
    vault,
    options: {
      storePath: join(root, "store", "wacli.db"),
      vault,
      statePath: join(root, "own", "state.json"),
      aliasesPath: join(root, "own", "aliases.json"),
      seedStatePath: join(vault, "scripts", ".whatsapp-mcp-state.json"),
      seedAliasesPath: join(vault, "scripts", "whatsapp-jid-aliases.json"),
      senderAliasesPath: join(vault, "scripts", "whatsapp-alias-map.json"),
      retryBaseMs: 1,
    },
  };
}

function firstDifference(actual, expected) {
  const a = actual.toString("utf8").split("\n");
  const b = expected.toString("utf8").split("\n");
  const line = a.findIndex((text, index) => text !== b[index]);
  const at = line < 0 ? a.length : line;
  return `line ${at + 1}\n  got:      ${JSON.stringify(a[at])}\n  expected: ${JSON.stringify(b[at])}`;
}

/** Same files, same bytes. Returns how many files were compared. */
function assertSameTree(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label}: the two folders do not hold the same files`);
  for (const [name, bytes] of Object.entries(expected)) {
    assert.ok(actual[name].equals(bytes), `${label}: ${name} differs at ${firstDifference(actual[name], bytes)}`);
  }
  return Object.keys(expected).length;
}

const outsideFolder = (tree) => Object.fromEntries(Object.entries(tree).filter(([name]) => !name.startsWith(`${WA_FOLDER}/`)));
/** A workspace without its store: reading a store can leave SQLite's own side files next to it. */
const withoutStore = (tree) => Object.fromEntries(Object.entries(tree).filter(([name]) => !name.startsWith("store/")));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Result, state and identities of one run against what the reference left for the same run. */
function assertSameOutcome(result, options, reference, label) {
  const expected = expectedResult(reference);
  const { storeHoursWithoutMessages, ...stats } = result.stats;
  assert.deepEqual(stats, expected.stats, `${label}: stats`);
  // The reference read its clock a moment after the one recorded for the run.
  assert.ok(Math.abs(storeHoursWithoutMessages - reference.stats.store_horas_sin_mensajes) <= 0.11, `${label}: hours without messages`);
  assert.deepEqual(result.report, expected.report, `${label}: report`);
  assert.deepEqual(result.ambiguous, expected.ambiguous, `${label}: ambiguous identities`);
  assert.deepEqual(result.files, [...new Set(reference.report.detail.map((item) => item.note))], `${label}: files`);
  assert.deepEqual(comparableChats(readJson(options.statePath).chats), comparableChats(reference.chats), `${label}: state`);
  assert.deepEqual(existsSync(options.aliasesPath) ? readJson(options.aliasesPath).aliases : {}, reference.aliases, `${label}: identities`);
}

const TINY_STORE = `${SCHEMA}
INSERT INTO chats VALUES ('5215550000001@s.whatsapp.net', 'dm', 'Ana Prueba', 1767312000);
INSERT INTO messages (chat_jid, msg_id, sender_jid, sender_name, ts, from_me, text) VALUES
  ('5215550000001@s.whatsapp.net', 'T1', '5215550000001@s.whatsapp.net', NULL, 1767311940, 0, 'hola'),
  ('5215550000001@s.whatsapp.net', 'T2', '5215550000000@s.whatsapp.net', 'me', 1767312000, 1, 'qué tal');
`;
const TINY_NOW = () => new Date("2026-01-03T12:00:00.250Z");
const TINY_NOTE = `${WA_FOLDER}/Personales/Ana Prueba 1s7g8lt.md`;

// ------------------------------------------------------------------------------- pure helpers

test("fnv1a36 gives the suffixes the reference gives", () => {
  assert.equal(fnv1a36(""), "ztntfp");
  assert.equal(fnv1a36("a"), "1r9wi7g");
  assert.equal(fnv1a36("foobar"), "1h5yxyg");
  assert.equal(fnv1a36("5215550000001@s.whatsapp.net"), "1s7g8lt");
  assert.equal(fnv1a36("99000000000021@lid"), "w6j7cz");
  assert.equal(fnv1a36("120363000000000051@g.us"), "1hd6tl3");
  // An emoji is one character for the hash, not two UTF-16 halves.
  assert.equal(fnv1a36("🎉"), "137pmlg");
  assert.equal(fnv1a36("ñandú 🎉"), "14p0jm");
  assert.equal(hash36("ñandú 🎉"), "14p0jm");
});

test("sanitizeName removes what a file name cannot hold and cuts at 80 characters", () => {
  assert.equal(sanitizeName(""), "chat");
  assert.equal(sanitizeName(null), "chat");
  assert.equal(sanitizeName("   "), "chat");
  assert.equal(sanitizeName("###"), "chat");
  assert.equal(sanitizeName("  Ana\t\n Prueba  "), "Ana Prueba");
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n'), "a b c d e f g h i j k l m n");
  assert.equal(sanitizeName(".oculto"), ".oculto");
  assert.equal(sanitizeName("x".repeat(100)), "x".repeat(80));
  // 80 characters, not 80 UTF-16 units: the emoji all stay whole.
  assert.equal(sanitizeName(`${"🎉".repeat(79)}ab`), `${"🎉".repeat(79)}a`);
  // Python's whitespace: separators and NEL collapse, the byte order mark does not.
  assert.equal(sanitizeName("a\x1cb\x85c\u{2028}d\u{feff}e"), "a b c d\u{feff}e");
  // The cut can leave a space at the end, and it stays.
  assert.equal(
    sanitizeName('Proyecto: "Súper/Largo" <2026> #1 [beta]* ¿listo? | equipo de pruebas y más pruebas 🎉🎊🎉 con cola que se corta aquí mismo'),
    "Proyecto Súper Largo 2026 1 beta ¿listo equipo de pruebas y más pruebas 🎉🎊🎉 con ",
  );
});

test("front matter quotes the chat name and the kind follows the chat id", () => {
  assert.equal(yamlQuote('El "Jefe" \\ Oficina'), '"El \\"Jefe\\" \\\\ Oficina"');
  assert.equal(
    frontMatter('El "Jefe" \\ Oficina', "5215550000097@s.whatsapp.net", "personal"),
    '---\nsource: whatsapp\nchat_id: "5215550000097@s.whatsapp.net"\nchat_name: "El \\"Jefe\\" \\\\ Oficina"\nkind: personal\n---\n\n# El "Jefe" \\ Oficina\n',
  );
  assert.equal(normalizeKind("dm", "a@s.whatsapp.net"), "personal");
  assert.equal(normalizeKind("group", "a@s.whatsapp.net"), "group");
  assert.equal(normalizeKind("dm", "a@g.us"), "group");
  assert.equal(normalizeKind("unknown", "a@lid"), "personal");
  assert.equal(normalizeKind("group", "status@g.us"), "group");
  assert.equal(normalizeKind("", "status@broadcast"), null);
  assert.equal(normalizeKind("dm", "mystatus@s.whatsapp.net"), null);
  assert.equal(normalizeKind("group", "x@BROADCAST"), null);
  assert.equal(normalizeKind("dm", ""), null);
});

test("messageText prefers a caption, then real text, then a marker for the media", () => {
  const text = (fields) => messageText({ text: "", caption: "", mediaType: "", ...fields });
  assert.equal(text({ text: "hola" }), "hola");
  assert.equal(text({ text: "  hola  ", mediaType: "image" }), "hola");
  assert.equal(text({ text: "texto", caption: "pie", mediaType: "image" }), "pie");
  assert.equal(text({ mediaType: "image" }), "[imagen]");
  assert.equal(text({ text: "\t\n" }), "");
  // The store's own markers, in both styles, are not text when there is media.
  assert.equal(text({ text: "[Audio]", caption: "[Audio]", mediaType: "audio" }), "[audio]");
  assert.equal(text({ text: "[Audio]", mediaType: "ptt" }), "[nota de voz]");
  assert.equal(text({ text: "Sent document", mediaType: "document" }), "[documento]");
  assert.equal(text({ caption: "Sent image", mediaType: "image" }), "[imagen]");
  assert.equal(text({ text: "real", caption: "[Image]", mediaType: "image" }), "real");
  assert.equal(text({ text: "SENT IMAGE", mediaType: "image" }), "[imagen]");
  assert.equal(text({ text: "Sent photo ", mediaType: "photo" }), "[imagen]");
  assert.equal(text({ text: "[Ubicación]", mediaType: "location" }), "[ubicación]");
  assert.equal(text({ text: "[nota de voz]", mediaType: "ptt" }), "[nota de voz]");
  // Unknown kinds of media get their own name, cleaned.
  assert.equal(text({ text: "[Poll]", mediaType: "poll" }), "[poll]");
  assert.equal(text({ text: "[Video]", mediaType: " Video " }), "[video]");
  assert.equal(text({ mediaType: "Weird Type" }), "[weird type]");
  // Without media the same words are a message somebody wrote.
  assert.equal(text({ text: "[Audio]" }), "[Audio]");
  assert.equal(text({ text: "Sent document" }), "Sent document");
  // What does not fit the marker's shape is kept as text.
  assert.equal(text({ text: "[Este texto es demasiado largo ya]", mediaType: "video" }), "[Este texto es demasiado largo ya]");
  assert.equal(text({ text: "[a]", mediaType: "audio" }), "[a]");
  assert.equal(text({ text: "[Audio 2]", mediaType: "audio" }), "[Audio 2]");
  assert.equal(text({ text: "sent contact", mediaType: "contact" }), "sent contact");
  assert.equal(text({ text: "x", mediaType: "vcard" }), "x");
  // Python ignores case with its own rules: the Turkish i, the long s and the Kelvin sign count.
  assert.equal(text({ text: "Sent \u{131}mage", mediaType: "image" }), "[imagen]");
  assert.equal(text({ text: "Sent \u{130}mage", mediaType: "image" }), "[imagen]");
  assert.equal(text({ text: "\u{17f}ent gif", mediaType: "gif" }), "[gif]");
  assert.equal(text({ text: "Sent stic\u{212a}er", mediaType: "sticker" }), "[sticker]");
});

test("senderLabel resolves me, a hand-written name, the store's name, the chat and the phone, in that order", () => {
  const names = { "5215550000077@s.whatsapp.net": "Tía Alias", "99000000000078@lid": "" };
  const label = (fields, chatName, kind) => senderLabel({ fromMe: false, senderJid: "", senderName: "", ...fields }, chatName, kind, names, "Santiago");
  assert.equal(label({ fromMe: true, senderName: "x" }, "Chat", "personal"), "Santiago");
  assert.equal(label({ senderJid: " 5215550000077@s.whatsapp.net ", senderName: "Otro" }, "Chat", "group"), "Tía Alias");
  assert.equal(label({ senderJid: "99000000000078@lid", senderName: "Tiene" }, "Chat", "group"), "");
  assert.equal(label({ senderJid: "a@lid", senderName: "  Pushy " }, "Chat", "group"), "Pushy");
  assert.equal(label({ senderJid: "5215550000001@s.whatsapp.net", senderName: "ME" }, "Chat", "personal"), "Chat");
  assert.equal(label({ senderJid: "5215550000001@s.whatsapp.net", senderName: "me" }, "", "personal"), "+5215550000001");
  assert.equal(label({ senderJid: "5215550000001:12@s.whatsapp.net" }, "Chat", "group"), "+5215550000001");
  assert.equal(label({ senderJid: "99000000000099@lid" }, "Chat", "group"), "Member-161itup");
  assert.equal(label({ senderJid: "120363000000000052@g.us", senderName: "me" }, "G", "group"), "Member-1vdpi53");
  assert.equal(label({ senderJid: "abc@s.whatsapp.net" }, "G", "group"), "Member-7aigaz");
  // Only 0 to 9 make a phone here; other digits do not.
  assert.equal(label({ senderJid: "٣٤٥@s.whatsapp.net" }, "G", "group"), "Member-3nw6cl");
  assert.equal(label({ senderJid: "@lid" }, "G", "group"), "Unknown");
  assert.equal(label({}, "G", "group"), "Unknown");
  assert.equal(label({}, "Chat", "personal"), "Chat");
  assert.equal(senderLabel({ fromMe: true }, "Chat", "group", {}, "Yo"), "Yo");
});

test("pyStrip, pySplit and pySplitlines follow Python's idea of whitespace and of a line", () => {
  // U+001C to U+001F and NEL are whitespace in Python and not in JavaScript.
  assert.equal(pyStrip("\x1c\x1d\x1e\x1f\x85 hola \u{a0}\u{3000}\u{2028}"), "hola");
  assert.equal("\x1chola\x85".trim(), "\x1chola\x85");
  // The byte order mark and the zero width space are the other way round.
  assert.equal(pyStrip("\u{feff}hola\u{200b}"), "\u{feff}hola\u{200b}");
  assert.equal("\u{feff}hola".trim(), "hola");
  assert.equal(pyStrip(null), "");
  assert.equal(pyStrip("   "), "");
  assert.deepEqual(pySplit("  a\x1fb\u{2003}c \u{feff}d  "), ["a", "b", "c", "\u{feff}d"]);
  assert.deepEqual(pySplit(" \t\n"), []);

  assert.deepEqual(pySplitlines(""), []);
  assert.deepEqual(pySplitlines("a"), ["a"]);
  assert.deepEqual(pySplitlines("a\n"), ["a"]);
  assert.deepEqual(pySplitlines("\n"), [""]);
  assert.deepEqual(pySplitlines("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(pySplitlines("a\r\nb\rc\n\rd"), ["a", "b", "c", "", "d"]);
  assert.deepEqual(pySplitlines("a\x0bb\x0cc\x1cd\x1de\x1ef\x85g\u{2028}h\u{2029}i"), ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  // The unit separator is whitespace but does not break a line.
  assert.deepEqual(pySplitlines("a\x1fb"), ["a\x1fb"]);
  // The text of a message: its lines joined by a space, then stripped.
  assert.equal(pyStrip(pySplitlines("\u{2028}uno\r\ndos\x1ctres\x85").join(" ")), "uno dos tres");
});

test("strings compare by character the way Python sorts them", () => {
  const ids = ["\u{ff5e}", "🎉", "b", "a", "\u{e000}", ""];
  assert.deepEqual([...ids].sort(compareCodePoints), ["", "a", "b", "\u{e000}", "\u{ff5e}", "🎉"]);
  // The default sort puts the emoji before the two characters above U+E000.
  assert.deepEqual([...ids].sort(), ["", "a", "b", "🎉", "\u{e000}", "\u{ff5e}"]);
  const sorted = normalizeMessages(
    [
      { id: "\u{ff5e}", sec: 10, text: "tercero" },
      { id: "🎉", sec: 10, text: "cuarto" },
      { id: "a", sec: 10, text: "segundo" },
      { id: "z", sec: 9, text: "primero" },
      { id: "x", sec: -1, text: "antes de 1970 no cuenta" },
      { id: "y", sec: 11, text: " " },
    ],
    "Chat",
    "personal",
    {},
    "Yo",
  );
  assert.deepEqual(sorted.map((message) => message.text), ["primero", "segundo", "tercero", "cuarto"]);
});

test("watermarks are read like Python's fromisoformat and written like its isoformat", () => {
  const seconds = Date.UTC(2026, 7, 17, 20, 26, 10) / 1000;
  assert.deepEqual(parseIsoDateTime("2026-08-17T20:26:10+00:00"), { sec: seconds, micro: 0, year: 2026, aware: true });
  assert.deepEqual(parseIsoDateTime("2026-08-17T20:26:10.459+00:00"), { sec: seconds, micro: 459000, year: 2026, aware: true });
  assert.deepEqual(parseIsoDateTime("2026-08-17T20:26:10"), { sec: seconds, micro: 0, year: 2026, aware: false });
  assert.deepEqual(parseIsoDateTime("2026-08-17T14:26:10-06:00"), { sec: seconds, micro: 0, year: 2026, aware: true });
  assert.deepEqual(parseIsoDateTime("20260817T202610"), { sec: seconds, micro: 0, year: 2026, aware: false });
  assert.deepEqual(parseIsoDateTime("2026-08-17 20:26:10.1234567"), { sec: seconds, micro: 123456, year: 2026, aware: false });
  assert.equal(parseIsoDateTime("2026-08-17").sec, Date.UTC(2026, 7, 17) / 1000);
  assert.equal(parseIsoDateTime("0001-01-01T00:00:00+00:00").year, 1);
  for (const bad of ["", "basura", "2026-08-1", "2026-02-30T00:00:00", "2026-08-17T24:00:00", "2026-08-17T10:11:60", "2026-08-17T10:11:12+24:00", "2026-08-17T10:11:12.+00:00", "2026-08-17T", "0000-01-01T00:00:00"]) {
    assert.equal(parseIsoDateTime(bad), null, bad);
  }
  // A whole second has no fraction and the offset is written as Z.
  assert.equal(isoUtc(seconds), "2026-08-17T20:26:10Z");
  assert.equal(isoUtc(seconds, 459000), "2026-08-17T20:26:10.459000Z");
  assert.equal(pyRound1(0.25), 0.2);
  assert.equal(pyRound1(0.75), 0.8);
  assert.equal(pyRound1(25.14), 25.1);
});

test("names are compared without accents, punctuation or case", () => {
  assert.equal(normName("Bruno Ejémplo!"), "bruno ejemplo");
  assert.equal(normName("  ÁNGEL   Ñandú\t(Trabajo) "), "angel nandu trabajo");
  assert.equal(normName("José–María O'Neil"), "jose maria o neil");
  assert.equal(normName("İstanbul ΣΊΣΥΦΟΣ"), "istanbul σισυφος");
  assert.equal(normName("ﬁancé № 5 ²³"), "fiance no 5 23");
  // Marks that do not stack are not dropped, they turn into a space, as in the reference.
  assert.equal(normName("क्षत्रिय"), "कषतर य");
  assert.equal(normName("ＦＵＬＬ １２"), "full 12");
  assert.equal(normName(""), "");
  assert.deepEqual(jidVariants("5215550000001:12@s.whatsapp.net"), ["5215550000001:12@s.whatsapp.net", "5215550000001@s.whatsapp.net", "5215550000001@lid"]);
  assert.deepEqual(jidVariants("99000000000011@lid"), ["99000000000011@lid", "99000000000011@s.whatsapp.net"]);
  assert.deepEqual(jidVariants("a:b@c@d"), ["a:b@c@d", "a@c", "a@s.whatsapp.net", "a@lid"]);
  assert.deepEqual(jidVariants(""), []);
});

test("local time comes from the time zone given, and a day header only when the day changes", () => {
  const monterrey = createLocalClock("America/Monterrey");
  const tokyo = createLocalClock("Asia/Tokyo");
  const second = Date.UTC(2026, 0, 2, 5, 59, 59) / 1000;
  assert.deepEqual({ ...monterrey(second) }, { day: "2026-01-01", time: "23:59", second: "59" });
  assert.deepEqual({ ...monterrey(second + 1) }, { day: "2026-01-02", time: "00:00", second: "00" });
  assert.equal(tokyo(second).day, "2026-01-02");
  assert.equal(tokyo(second).time, "14:59");
  assert.throws(() => createLocalClock("Marte/Olimpo"), /not a time zone/);

  const messages = [
    { sec: second, sender: "Ana", text: "uno" },
    { sec: second + 1, sender: "Ana", text: "dos" },
    { sec: second + 2, sender: "Yo", text: "tres" },
  ];
  assert.deepEqual(renderBlock(messages, "2026-01-01", monterrey), {
    chunk: "**23:59** — Ana: uno\n\n\n## 2026-01-02\n\n**00:00** — Ana: dos\n\n**00:00** — Yo: tres\n\n",
    header: "2026-01-02",
  });
  assert.equal(renderBlock(messages.slice(0, 1), "", monterrey).chunk, "\n## 2026-01-01\n\n**23:59** — Ana: uno\n\n");
});

test("the index keeps the reference's text, order and quirks", () => {
  const chats = new Map([
    ["a@s.whatsapp.net", { name: "Ana", kind: "personal", note_path: "raw/Personal/whatsapp/Personales/Ana 1.md", last_ts: "2026-08-17T20:26:10Z", message_count: 12 }],
    ["b@lid", { name: "notas.md de Beto", kind: "personal", note_path: "", last_ts: "2026-08-17T20:26:10Z", message_count: 3 }],
    ["g@g.us", { name: "Grupo", kind: "group", note_path: "raw/Personal/whatsapp/Grupos/Grupo x.md.md", last_ts: "2026-09-01T00:00:00.5Z", message_count: 7 }],
    ["c@lid", { name: "Sin Campos" }],
    ["d@lid", { name: null, kind: null, message_count: null, last_ts: null }],
  ]);
  assert.equal(
    buildIndex(chats, WA_FOLDER),
    "# WhatsApp — Conversation Index\n\n" +
      "_5 conversation(s). Regenerado en cada corrida de `whatsapp-ingest-diario` (pull vía LMCP)._\n\n" +
      "## Personal (4)\n\n" +
      "- [[raw/Personal/whatsapp/Personales/Ana 1|Ana]] — 12 msgs · 2026-08-17\n" +
      // Every ".md" is removed from the link, also the one inside a name.
      "- [[raw/Personal/whatsapp/Personales/notas de Beto 1wpo4z0|notas.md de Beto]] — 3 msgs · 2026-08-17\n" +
      "- [[raw/Personal/whatsapp/Personales/Sin Campos t65swj|Sin Campos]] — 0 msgs · \n" +
      "- [[raw/Personal/whatsapp/Personales/chat lfpoqa|None]] — None msgs · \n\n" +
      "## Groups (1)\n\n" +
      "- [[raw/Personal/whatsapp/Grupos/Grupo x|Grupo]] — 7 msgs · 2026-09-01\n",
  );
});

test("the tail of a note is read by bytes and its first, cut line is dropped", () => {
  const dir = box();
  const short = join(dir, "short.md");
  writeFileSync(short, "# Ana\n\n## 2026-01-01\n\n**09:15** — Ana: hola  \r\n\r\n**９:15** — no es una línea\n**１２:３４** — Ana: dígitos anchos\u{2028}**10:00** — Ana: tras un separador\n");
  assert.deepEqual([...tailLines(short)], ["**09:15** — Ana: hola", "**１２:３４** — Ana: dígitos anchos", "**10:00** — Ana: tras un separador"]);

  // 60,000 bytes from the end falls inside the second emoji of the first line.
  const long = join(dir, "long.md");
  const filler = "**10:00** — Ana: relleno\n".repeat(2400);
  const start = `**08:00** — Ana: ${"🎉".repeat(10)} cortada\n**08:01** — Ana: entera\n`;
  const bytes = Buffer.from(start + filler, "utf8");
  const head = Buffer.concat([Buffer.from("**07:00** — Ana: lejos\n"), Buffer.alloc(bytes.length > 60000 ? 0 : 60000 - bytes.length, "x")]);
  writeFileSync(long, Buffer.concat([head, bytes]));
  const all = Buffer.concat([head, bytes]);
  const cut = all.length - 60000;
  assert.ok(all.length > 60000 && cut > 0);
  const lines = tailLines(long);
  const firstWhole = all.subarray(all.indexOf("\n", cut) + 1).toString("utf8").split("\n")[0];
  assert.ok(lines.has(firstWhole));
  assert.ok(lines.has("**10:00** — Ana: relleno"));
  assert.ok(!lines.has("**07:00** — Ana: lejos"), "a line before the last 60,000 bytes is not seen");
  for (const line of lines) assert.ok(!line.includes("\u{fffd}"), "the cut line is dropped, not kept half decoded");

  assert.deepEqual([...tailLines(join(dir, "missing.md"))], []);
  assert.deepEqual([...tailLines(dir)], []);
});

test("existing notes are found by chat id: first match wins, hidden names and late ids are not seen", () => {
  const vault = box();
  const note = (id) => `---\nsource: whatsapp\nchat_id: "${id}"\n---\n`;
  writeTree(vault, {
    [`${WA_FOLDER}/Personales/renombrada.md`]: note("a@lid"),
    [`${WA_FOLDER}/Grupos/también a.md`]: note("a@lid"),
    [`${WA_FOLDER}/_descartados/otra a.md`]: note("a@lid"),
    [`${WA_FOLDER}/_descartados/arriba.md`]: note("b@lid"),
    [`${WA_FOLDER}/_descartados/2025/x/abajo.md`]: note("b@lid"),
    [`${WA_FOLDER}/_descartados/2025/x/solo abajo.md`]: note("c@lid"),
    [`${WA_FOLDER}/_descartados/.oculta/nota.md`]: note("d@lid"),
    [`${WA_FOLDER}/Personales/.oculta.md`]: note("e@lid"),
    [`${WA_FOLDER}/Personales/mayúsculas.MD`]: note("f@lid"),
    [`${WA_FOLDER}/Personales/sub/anidada.md`]: note("g@lid"),
    [`${WA_FOLDER}/Personales/carpeta.md/dentro.txt`]: "x",
    [`${WA_FOLDER}/Personales/tarde.md`]: `---\nnotas: "${"x".repeat(600)}"\nchat_id: "h@lid"\n---\n`,
    [`${WA_FOLDER}/Personales/justo.md`]: `---\nn: "${"🎉".repeat(560)}"\nchat_id: "i@lid"\n---\n`,
    [`${WA_FOLDER}/Personales/windows.md`]: "\u{feff}---\r\nchat_id: j@lid  \r\nkind: personal\r\n---\r\n",
    [`${WA_FOLDER}/Personales/separador.md`]: `---\nnombre: x\u{2028}chat_id: "k@lid"\n---\n`,
    [`${WA_FOLDER}/Personales/comilla.md`]: '---\nchat_id: "l@lid" sobra\n---\n',
    [`${WA_FOLDER}/suelta.md`]: note("m@lid"),
  });
  const found = indexExistingNotes(vault, WA_FOLDER);
  assert.deepEqual(
    Object.fromEntries([...found].map(([id, { rel }]) => [id, rel.normalize("NFC")]).sort(([a], [b]) => (a < b ? -1 : 1))),
    {
      "a@lid": `${WA_FOLDER}/Personales/renombrada.md`,
      "b@lid": `${WA_FOLDER}/_descartados/arriba.md`,
      "c@lid": `${WA_FOLDER}/_descartados/2025/x/solo abajo.md`,
      // 600 characters are read, not 600 bytes: the id after 560 emoji is still inside.
      "i@lid": `${WA_FOLDER}/Personales/justo.md`,
      "j@lid": `${WA_FOLDER}/Personales/windows.md`,
    },
  );
  assert.equal(found.get("a@lid").path, join(vault, ...WA, "Personales", "renombrada.md"));
});

test("the folder must stay inside the vault, under raw/", () => {
  assert.equal(validateFolder("raw/Personal/whatsapp"), "raw/Personal/whatsapp");
  assert.equal(validateFolder("raw/Personal/whatsapp/"), "raw/Personal/whatsapp");
  assert.equal(validateFolder("raw\\Personal\\whatsapp"), "raw/Personal/whatsapp");
  assert.equal(validateFolder("raw/./x"), "raw/x");
  for (const bad of ["", null, "/raw/x", "\\raw\\x", "C:\\raw\\x", "c:/raw/x", "raw/../x", "raw/x/..", "../raw/x", "raw/a..b", "raw", "raw/", "notes/whatsapp", "Raw/x", "rawx/y", "raw/x\0y"]) {
    assert.throws(() => validateFolder(bad), /WhatsApp folder/, String(bad));
  }
});

test("the reference's state is merged per chat: the later watermark wins and the order is kept", () => {
  const own = {
    version: 1,
    source: "smcp",
    last_run: "x",
    chats: {
      "b@lid": { name: "B mío", last_ts: "2026-08-17T20:26:10Z" },
      "a@lid": { name: "A mío", last_ts: "2026-08-17T20:26:10.500Z" },
      "c@lid": { name: "C mío", last_ts: "" },
      "e@lid": { name: "E mío", last_ts: "2026-08-17T20:26:10Z" },
    },
  };
  const seed = {
    source: "lmcp",
    seeded_at: "y",
    chats: {
      "d@lid": { name: "D suyo", last_ts: "2026-01-01T00:00:00Z" },
      "a@lid": { name: "A suyo", last_ts: "2026-08-17T20:26:10Z" },
      "b@lid": { name: "B suyo", last_ts: "2026-08-17T14:26:11-06:00" },
      "c@lid": { name: "C suyo", last_ts: "2020-01-01T00:00:00Z" },
      "e@lid": { name: "E suyo", last_ts: "2026-08-17T20:26:10+00:00" },
      "f@lid": "no es una entrada",
    },
  };
  const merged = mergeSeedState(own, seed);
  assert.deepEqual([...merged.chats].map(([jid, entry]) => [jid, entry.name]), [
    ["b@lid", "B suyo"],
    ["a@lid", "A mío"],
    ["c@lid", "C suyo"],
    ["e@lid", "E mío"],
    ["d@lid", "D suyo"],
  ]);
  assert.deepEqual(merged.top, { version: 1, source: "smcp", last_run: "x" });
  merged.chats.get("d@lid").name = "cambiado";
  assert.equal(seed.chats["d@lid"].name, "D suyo", "the seed is copied, never shared");

  const fresh = mergeSeedState(undefined, seed);
  assert.deepEqual([...fresh.chats.keys()], ["d@lid", "a@lid", "b@lid", "c@lid", "e@lid"]);
  assert.deepEqual(fresh.top, { version: 1, source: "smcp", last_run: null });
  assert.equal(mergeSeedState(undefined, undefined).chats.size, 0);

  const aliases = mergeSeedAliases({ aliases: { "1@s.whatsapp.net": "x@lid", "2@s.whatsapp.net": "y@lid" } }, { aliases: { "2@s.whatsapp.net": "z@lid", "3@s.whatsapp.net": "w@lid", "4@s.whatsapp.net": 5 } });
  assert.deepEqual(Object.fromEntries(aliases), { "1@s.whatsapp.net": "x@lid", "2@s.whatsapp.net": "z@lid", "3@s.whatsapp.net": "w@lid" });
  assert.equal(mergeSeedAliases(undefined, undefined).size, 0);
});

// ------------------------------------------------------------------------- the sqlite3 tool

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false });
const hex = (text) => Buffer.from(text, "utf8").toString("hex");

test("a computer without sqlite3 gets a plain message, with no retries", async () => {
  const dir = box();
  writeFileSync(join(dir, "wacli.db"), "x");
  let calls = 0;
  const sqlite = createSqlite({
    platform: "linux",
    runner: async () => {
      calls += 1;
      return { code: null, stdout: "", stderr: "", spawnError: Object.assign(new Error("spawn sqlite3 ENOENT"), { code: "ENOENT" }) };
    },
  });
  await assert.rejects(snapshotStore({ sqlite, storePath: join(dir, "wacli.db"), retryBaseMs: 1 }), /^Error: sqlite3 was not found on this computer\.$/);
  assert.equal(calls, 1);

  const used = [];
  const runner = async (file) => {
    used.push(file);
    return ok();
  };
  await createSqlite({ platform: "darwin", exists: () => true, runner })(["-version"]);
  await createSqlite({ platform: "darwin", exists: () => false, runner })(["-version"]);
  await createSqlite({ platform: "linux", exists: () => true, runner })(["-version"]);
  assert.deepEqual(used, ["/usr/bin/sqlite3", "sqlite3", "sqlite3"]);
});

test("the copy of the store is retried with a growing wait and a store that never reads throws", async () => {
  const dir = box();
  const storePath = join(dir, "wacli.db");
  writeFileSync(storePath, "x");
  const waits = [];
  const sleep = async (ms) => void waits.push(ms);
  const calls = [];
  let failures = 4; // each attempt tries the backup and then the plain copy, which is checked too
  const flaky = async (args, options) => {
    calls.push(args.at(-1));
    assert.ok(existsSync(options.cwd), "sqlite3 runs inside the temporary folder");
    if (failures > 0) {
      failures -= 1;
      return { code: 1, stdout: "", stderr: "Error: database is locked\n", truncated: false, timedOut: false };
    }
    return ok();
  };
  const snapshot = await snapshotStore({ sqlite: flaky, storePath, attempts: 4, retryBaseMs: 3000, sleep });
  assert.equal(snapshot.attempt, 3);
  assert.deepEqual(waits, [3000, 6000]);
  assert.equal(calls[0], ".backup wacli.db");
  assert.match(calls.at(-1), /count\(\*\) FROM messages.*FROM chats.*FROM contacts/);
  rmSync(snapshot.dir, { recursive: true, force: true });

  waits.length = 0;
  const dead = async () => ({ code: 1, stdout: "", stderr: "Error: file is not a database\n", truncated: false, timedOut: false });
  await assert.rejects(snapshotStore({ sqlite: dead, storePath, attempts: 4, retryBaseMs: 10, sleep }), (error) => {
    assert.match(error.message, /could not be read after 4 attempts\. Last error: Error: file is not a database/);
    return true;
  });
  assert.deepEqual(waits, [10, 20, 40]);
  await assert.rejects(snapshotStore({ sqlite: dead, storePath: join(dir, "no-such.db"), sleep }), /was not found at/);
});

test("rows are read in pages and a page that was cut off is asked for again, smaller", async () => {
  const table = Array.from({ length: 11 }, (_, index) => [`jid-${index}`, index]);
  const asked = [];
  const sqlite = async (args) => {
    const sql = args.at(-1);
    const [, limit, offset] = /LIMIT (\d+) OFFSET (\d+)$/.exec(sql).map(Number);
    asked.push([limit, offset]);
    if (limit > 3) return { ...ok(), truncated: true };
    const page = table.slice(offset, offset + limit).map(([jid, n]) => `text|${hex(jid)}|integer|${hex(String(n))}|null|`);
    return ok(page.length ? `${page.join("\n")}\n` : "");
  };
  const rows = await queryRows({ sqlite, dir: "/tmp", columns: ["jid", "n", "max(ts) AS last"], from: "chats", pageSize: 12 });
  assert.deepEqual(rows, table.map(([jid, n]) => ({ jid, n, last: null })));
  assert.deepEqual(asked, [[12, 0], [6, 0], [3, 0], [3, 3], [3, 6], [3, 9]]);

  const tooBig = async () => ({ ...ok(), truncated: true });
  await assert.rejects(queryRows({ sqlite: tooBig, dir: "/tmp", columns: ["jid"], from: "chats", pageSize: 2 }), /too large/);
  const broken = async () => ({ code: 1, stdout: "", stderr: "Parse error: no such table: chats\n", truncated: false, timedOut: false });
  await assert.rejects(queryRows({ sqlite: broken, dir: "/tmp", columns: ["jid"], from: "chats" }), /could not be queried: Parse error: no such table: chats/);

  assert.equal(sqlLiteral("o'neil@lid"), "'o''neil@lid'");
  assert.equal(sqlLiteral(1767312000), "1767312000");
  assert.equal(sqlLiteral(null), "NULL");
});

test("text comes back from the store byte for byte, control characters included", { skip: storeSkip }, async () => {
  const dir = box();
  const storePath = join(dir, "wacli.db");
  const nasty = "a\x01\x1c\x1f\x7f\x85\ttab\r\nfin|barra\\ \"comillas\" 'simple' \u{2028}🎉\u{feff}";
  loadSql(storePath, `${SCHEMA}\nINSERT INTO chats VALUES (CAST(X'${hex(nasty)}' AS TEXT), 'dm', NULL, 12345678901);\nINSERT INTO chats VALUES ('b', '', '', 1.5);`);
  const sqlite = createSqlite();
  const snapshot = await snapshotStore({ sqlite, storePath, retryBaseMs: 1 });
  try {
    for (const pageSize of [1, 2000]) {
      assert.deepEqual(await queryRows({ sqlite, dir: snapshot.dir, columns: ["jid", "kind", "name", "last_message_ts"], from: "chats ORDER BY rowid", pageSize }), [
        { jid: nasty, kind: "dm", name: null, last_message_ts: 12345678901 },
        { jid: "b", kind: "", name: "", last_message_ts: 1.5 },
      ]);
    }
    assert.deepEqual(await queryRows({ sqlite, dir: snapshot.dir, columns: ["jid"], from: `chats WHERE jid = ${sqlLiteral(nasty)}` }), [{ jid: nasty }]);
    assert.deepEqual(await queryRows({ sqlite, dir: snapshot.dir, columns: ["max(ts) AS last"], from: "messages" }), [{ last: null }]);
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
});

test("the real store is only ever opened read-only, and its copy never is", { skip: storeSkip }, async () => {
  const dir = box();
  const storePath = join(dir, "wacli.db");
  loadSql(storePath, `${SCHEMA}\nINSERT INTO chats VALUES ('a', 'dm', 'Ana', 1);`);
  const real = createSqlite();
  const calls = [];
  const sqlite = (args, options) => {
    calls.push(args);
    return real(args, options);
  };
  const snapshot = await snapshotStore({ sqlite, storePath, retryBaseMs: 1 });
  try {
    await queryRows({ sqlite, dir: snapshot.dir, columns: ["jid"], from: "chats" });
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
  // macOS's sqlite3 cannot open a copy that keeps a write-ahead log read-only, so the copy is opened
  // normally; the store itself must never be opened any other way than read-only.
  const onStore = calls.filter((args) => args.includes(storePath));
  const onCopy = calls.filter((args) => !args.includes(storePath));
  assert.ok(onStore.length >= 1 && onCopy.length >= 2);
  for (const args of onStore) assert.ok(args.includes("-readonly"), args.join(" "));
  for (const args of onCopy) assert.ok(!args.includes("-readonly"), args.join(" "));
});

test("while another process holds the store open, what is still in its write-ahead log is read too", { skip: storeSkip }, async () => {
  const dir = box();
  const storePath = join(dir, "wacli.db");
  loadSql(storePath, `${SCHEMA}\nINSERT INTO chats VALUES ('first', 'dm', 'Ana', 1);`);
  // A stand-in for the live sync: a connection that stays open with a row it has not checkpointed.
  const holder = spawn("sqlite3", [storePath], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    const held = new Promise((resolve, reject) => {
      holder.stdout.on("data", (chunk) => String(chunk).includes("held") && resolve());
      holder.on("exit", () => reject(new Error("the holder stopped early")));
    });
    holder.stdin.write("PRAGMA wal_autocheckpoint=0;\nINSERT INTO chats VALUES ('in-the-log', 'dm', 'Beto', 2);\nSELECT 'held';\n");
    await held;
    assert.ok(existsSync(`${storePath}-wal`), "the row is still in the log");
    const sqlite = createSqlite();
    const snapshot = await snapshotStore({ sqlite, storePath, retryBaseMs: 1 });
    try {
      const rows = await queryRows({ sqlite, dir: snapshot.dir, columns: ["jid"], from: "chats ORDER BY rowid" });
      assert.deepEqual(rows, [{ jid: "first" }, { jid: "in-the-log" }]);
    } finally {
      rmSync(snapshot.dir, { recursive: true, force: true });
    }
  } finally {
    holder.removeAllListeners("exit");
    holder.stdin.end(".quit\n");
    await new Promise((resolve) => holder.on("close", resolve));
  }
});

// ------------------------------------------------------------------------- the whole export

test("a first run writes notes, state and index; a second run with nothing new still saves the state", { skip: storeSkip }, async () => {
  const { vault, options } = workspace();
  loadSql(options.storePath, TINY_STORE);
  const first = await exportWhatsApp({ ...options, now: TINY_NOW });
  assert.deepEqual(first.files, [TINY_NOTE]);
  assert.deepEqual(first.report, {
    chatsTouched: 1,
    messagesWritten: 2,
    notesCreated: 1,
    skippedChats: 0,
    quarantinedAppends: 0,
    duplicatesSkipped: 0,
    detail: [{ chat: "Ana Prueba", kind: "personal", new: 2, note: TINY_NOTE, quarantined: false }],
  });
  assert.deepEqual(first.stats, {
    chatsScanned: 1,
    chatsWithNew: 1,
    messages: 2,
    skippedChats: 0,
    identitiesMerged: 0,
    identitiesAmbiguous: 0,
    storeLastMessage: "2026-01-02T00:00:00Z",
    storeHoursWithoutMessages: 36,
  });
  assert.deepEqual(first.ambiguous, []);
  assert.equal(
    readFileSync(join(vault, ...TINY_NOTE.split("/")), "utf8"),
    '---\nsource: whatsapp\nchat_id: "5215550000001@s.whatsapp.net"\nchat_name: "Ana Prueba"\nkind: personal\n---\n\n# Ana Prueba\n\n## 2026-01-01\n\n**17:59** — Ana Prueba: hola\n\n**18:00** — Santiago: qué tal\n\n',
  );
  const state = readJson(options.statePath);
  assert.deepEqual(state, {
    version: 1,
    source: "smcp",
    last_run: "2026-01-03T06:00:00.250000-06:00",
    chats: {
      "5215550000001@s.whatsapp.net": {
        name: "Ana Prueba",
        kind: "personal",
        note_path: TINY_NOTE,
        last_ts: "2026-01-02T00:00:00Z",
        last_date_header: "2026-01-01",
        message_count: 2,
        seen_ids: ["T1", "T2"],
      },
    },
  });
  assert.equal(existsSync(options.aliasesPath), false, "no identities were joined, so no file is written");
  const tree = readTree(vault);
  assert.deepEqual(Object.keys(tree), [TINY_NOTE, `${WA_FOLDER}/_Conversation Index.md`]);

  // Nothing new: the vault does not change, and `last_run` moves anyway. It is the heartbeat.
  const second = await exportWhatsApp({ ...options, now: () => new Date("2026-01-03T15:00:00Z") });
  assert.equal(second.report.messagesWritten, 0);
  assert.deepEqual(second.files, []);
  assert.equal(second.stats.chatsWithNew, 0);
  assertSameTree(readTree(vault), tree, "second run");
  assert.deepEqual(readJson(options.statePath), { ...state, last_run: "2026-01-03T09:00:00-06:00" });
});

test("a dry run reports the same and writes nothing at all", { skip: storeSkip }, async () => {
  const { root, vault, options } = workspace(join(GOLDEN, "seed"));
  loadSql(options.storePath, readFileSync(join(GOLDEN, "run1.sql"), "utf8"));
  const reference = readJson(join(GOLDEN, "reference-1.json"));
  const before = withoutStore(readTree(root));
  const result = await exportWhatsApp({ ...options, now: () => new Date(reference.now), dryRun: true });
  const expected = expectedResult(reference);
  assert.deepEqual(result.report, expected.report);
  assert.deepEqual(result.ambiguous, expected.ambiguous);
  assert.equal(result.merged.length, 1);
  assertSameTree(withoutStore(readTree(root)), before, "dry run");
  assert.equal(existsSync(options.statePath), false);
  assert.equal(existsSync(options.aliasesPath), false);
});

test("a store that cannot be read throws and leaves the vault and the state alone", { skip: storeSkip }, async () => {
  const { root, options } = workspace();
  loadSql(options.storePath, TINY_STORE);
  await exportWhatsApp({ ...options, now: TINY_NOW });
  const before = withoutStore(readTree(root));

  for (const suffix of ["-wal", "-shm"]) rmSync(options.storePath + suffix, { force: true });
  writeFileSync(options.storePath, "this is not a database, and it is long enough to have a header to distrust");
  await assert.rejects(exportWhatsApp({ ...options, now: TINY_NOW, snapshotAttempts: 2 }), /The WhatsApp store at .* could not be read after 2 attempts\. Last error: /);
  rmSync(options.storePath);
  await assert.rejects(exportWhatsApp({ ...options, now: TINY_NOW }), /The WhatsApp store was not found at /);
  // A store with the wrong tables is not a store either.
  loadSql(options.storePath, "CREATE TABLE otra (x);");
  await assert.rejects(exportWhatsApp({ ...options, now: TINY_NOW, snapshotAttempts: 1 }), /could not be read after 1 attempts\. Last error: .*no such table/);
  assertSameTree(withoutStore(readTree(root)), before, "after the failures");

  const missing = createSqlite({ runner: async () => ({ code: null, stdout: "", stderr: "", spawnError: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }) });
  await assert.rejects(exportWhatsApp({ ...options, sqlite: missing }), /^Error: sqlite3 was not found on this computer\.$/);
});

test("bad settings are refused before anything is read or written", async () => {
  const { root, vault, options } = workspace();
  const never = async () => assert.fail("the store must not be touched");
  const run = (changes) => exportWhatsApp({ ...options, sqlite: never, ...changes });
  await assert.rejects(run({ folder: "../fuera" }), /WhatsApp folder/);
  await assert.rejects(run({ folder: "/tmp/fuera" }), /WhatsApp folder/);
  await assert.rejects(run({ folder: "notas/whatsapp" }), /must start with "raw\/"/);
  await assert.rejects(run({ vault: "relativa/vault" }), /absolute path/);
  await assert.rejects(run({ vault: join(root, "no-such-vault") }), /vault was not found/);
  await assert.rejects(run({ storePath: "" }), /store is missing/);
  await assert.rejects(run({ statePath: undefined }), /state and aliases files are missing/);
  await assert.rejects(run({ statePath: options.seedStatePath }), /only read/);
  await assert.rejects(run({ aliasesPath: options.seedAliasesPath }), /only read/);
  await assert.rejects(run({ timeZone: "Marte/Olimpo" }), /not a time zone/);
  writeTree(vault, { "scripts/.whatsapp-mcp-state.json": "{ esto no es JSON" });
  await assert.rejects(run({}), /reference WhatsApp state at .* is not valid JSON/);
  assert.deepEqual(Object.keys(readTree(root)), ["vault/scripts/.whatsapp-mcp-state.json"]);
});

test("own name, time zone and folder are settings, and everything written stays in the folder", { skip: storeSkip }, async () => {
  const { root, vault, options } = workspace({ "scripts/whatsapp-alias-map.json": "{ roto", "raw/otra/nota.md": "intacta\n" });
  loadSql(options.storePath, TINY_STORE);
  const result = await exportWhatsApp({ ...options, now: TINY_NOW, folder: "raw/Trabajo/wa/", ownName: "Yo Misma", timeZone: "Asia/Tokyo", backfillDays: 2, pageSize: 1 });
  const note = "raw/Trabajo/wa/Personales/Ana Prueba 1s7g8lt.md";
  assert.deepEqual(result.files, [note]);
  assert.equal(readFileSync(join(vault, ...note.split("/")), "utf8").split("# Ana Prueba\n")[1], "\n## 2026-01-02\n\n**08:59** — Ana Prueba: hola\n\n**09:00** — Yo Misma: qué tal\n\n");
  assert.deepEqual(Object.keys(withoutStore(readTree(root))), [
    "own/state.json",
    "vault/raw/Trabajo/wa/Personales/Ana Prueba 1s7g8lt.md",
    "vault/raw/Trabajo/wa/_Conversation Index.md",
    "vault/raw/otra/nota.md",
    "vault/scripts/whatsapp-alias-map.json",
  ]);
  assert.equal(readJson(options.statePath).last_run, "2026-01-03T21:00:00.250000+09:00");
  assert.match(readFileSync(join(vault, "raw", "Trabajo", "wa", "_Conversation Index.md"), "utf8"), /- \[\[raw\/Trabajo\/wa\/Personales\/Ana Prueba 1s7g8lt\|Ana Prueba\]\] — 2 msgs · 2026-01-02\n/);

  // A backfill of one day leaves both messages out for a chat that was never exported.
  const other = workspace();
  loadSql(other.options.storePath, TINY_STORE);
  const short = await exportWhatsApp({ ...other.options, now: TINY_NOW, backfillDays: 1 });
  assert.equal(short.report.messagesWritten, 0);
  assert.equal(short.stats.chatsScanned, 1);
});

test("a note that is a link to somewhere outside the folder is refused, and what was already written is remembered", { skip: storeSkip }, async () => {
  const { root, vault, options } = workspace();
  const group = "120363000000000001@g.us";
  loadSql(
    options.storePath,
    `${TINY_STORE}
INSERT INTO chats VALUES ('${group}', 'group', 'Grupo Prueba', 1767311000);
INSERT INTO messages (chat_jid, msg_id, sender_jid, sender_name, ts, from_me, text) VALUES ('${group}', 'G1', '5215550000001@s.whatsapp.net', 'anita', 1767311000, 0, 'en el grupo');`,
  );
  const outside = join(root, "fuera");
  const link = join(vault, ...WA, "Grupos");
  mkdirSync(outside);
  mkdirSync(join(vault, ...WA), { recursive: true });
  symlinkSync(outside, link, "dir");
  await assert.rejects(exportWhatsApp({ ...options, now: TINY_NOW }), /Refusing to write a WhatsApp note outside its folder/);
  assert.deepEqual(readTree(outside), {});
  // The 1-to-1 chat came first and was written; its watermark is saved, and `last_run` is not.
  const state = readJson(options.statePath);
  assert.equal(state.last_run, null);
  assert.equal(state.chats["5215550000001@s.whatsapp.net"].last_ts, "2026-01-02T00:00:00Z");
  assert.equal(state.chats[group].last_ts, "");

  rmSync(link);
  const again = await exportWhatsApp({ ...options, now: TINY_NOW });
  assert.deepEqual(again.report.detail.map((item) => [item.chat, item.new]), [["Grupo Prueba", 1]]);
  assert.equal(again.report.duplicatesSkipped, 0);
  assert.equal(readFileSync(join(vault, ...TINY_NOTE.split("/")), "utf8").match(/qué tal/g).length, 1);
  assert.equal(readJson(options.statePath).last_run, "2026-01-03T06:00:00.250000-06:00");
});

test("two runs asked for at once take turns", { skip: storeSkip }, async () => {
  const { vault, options } = workspace();
  loadSql(options.storePath, TINY_STORE);
  const [first, second] = await Promise.all([exportWhatsApp({ ...options, now: TINY_NOW }), exportWhatsApp({ ...options, now: TINY_NOW })]);
  assert.equal(first.report.messagesWritten, 2);
  assert.equal(second.report.messagesWritten, 0);
  assert.equal(readFileSync(join(vault, ...TINY_NOTE.split("/")), "utf8").match(/qué tal/g).length, 1);
});

// --------------------------------------------------------------------------------- parity

test("golden files: the vault matches the reference byte for byte over two runs and a quiet third", { skip: storeSkip }, async () => {
  const seedDir = join(GOLDEN, "seed");
  const { vault, options } = workspace(seedDir);
  const untouched = outsideFolder(readTree(seedDir));
  let compared = 0;

  for (const run of [1, 2]) {
    loadSql(options.storePath, readFileSync(join(GOLDEN, `run${run}.sql`), "utf8"));
    const reference = readJson(join(GOLDEN, `reference-${run}.json`));
    const result = await exportWhatsApp({ ...options, now: () => new Date(reference.now) });
    compared += assertSameTree(readTree(join(vault, ...WA)), readTree(join(GOLDEN, `expected-${run}`)), `run ${run}`);
    assertSameOutcome(result, options, reference, `run ${run}`);
    // The reference's own files and everything else in the vault are only read.
    assertSameTree(outsideFolder(readTree(vault)), untouched, `run ${run}, outside the folder`);
  }
  assert.ok(compared >= 60, `only ${compared} files were compared`);

  // The scenario really went down the paths it was built for.
  const [first, second] = [1, 2].map((run) => readJson(join(GOLDEN, `reference-${run}.json`)));
  assert.equal(first.report.notes_created, 17);
  assert.equal(first.report.duplicates_skipped, 5);
  assert.equal(first.report.quarantined_appends, 1);
  assert.equal(first.report.skipped_chats, 1);
  assert.equal(first.stats.skipped_chats, 4);
  assert.equal(first.ambiguous.length, 1);
  assert.deepEqual(first.aliases, { "5215550000081@s.whatsapp.net": "99000000000081@lid", "5215550000021@s.whatsapp.net": "99000000000021@lid" });
  assert.equal(second.report.duplicates_skipped, 1);
  assert.equal(second.report.notes_created, 1);

  const quiet = await exportWhatsApp({ ...options, now: () => new Date(Date.parse(second.now) + 60_000) });
  assert.equal(quiet.report.messagesWritten, 0);
  assert.equal(quiet.report.chatsTouched, 0);
  assert.deepEqual(quiet.files, []);
  assertSameTree(readTree(join(vault, ...WA)), readTree(join(GOLDEN, "expected-2")), "quiet run");
  assert.deepEqual(comparableChats(readJson(options.statePath).chats), comparableChats(second.chats));
});

test("golden files: reading the store one row at a time gives the same vault", { skip: storeSkip }, async () => {
  const { vault, options } = workspace(join(GOLDEN, "seed"));
  loadSql(options.storePath, readFileSync(join(GOLDEN, "run1.sql"), "utf8"));
  const reference = readJson(join(GOLDEN, "reference-1.json"));
  const result = await exportWhatsApp({ ...options, now: () => new Date(reference.now), pageSize: 1 });
  assertSameTree(readTree(join(vault, ...WA)), readTree(join(GOLDEN, "expected-1")), "one row per page");
  assertSameOutcome(result, options, reference, "one row per page");
});

const scriptsDir = process.env.SMCP_BRAIN_SCRIPTS;
const python = scriptsDir ? findCommand(["python3", "python"], "--version") : null;
const liveSkip = !scriptsDir
  ? "set SMCP_BRAIN_SCRIPTS to the folder with the reference scripts to compare against them live"
  : !REFERENCE_SCRIPTS.every((name) => existsSync(join(scriptsDir, name)))
    ? `SMCP_BRAIN_SCRIPTS does not hold ${REFERENCE_SCRIPTS.join(" and ")}`
    : !python
      ? "python3 is not installed"
      : storeSkip;

test("live: the reference scripts and the exporter write the same vault, run after run", { skip: liveSkip }, async () => {
  // Built as of now: the reference reads the real clock for its 90-day window.
  const scenario = buildScenario(new Date());
  const theirs = workspace(scenario.seed);
  const ours = workspace(scenario.seed);
  const seedState = scenario.seed["scripts/.whatsapp-mcp-state.json"];
  let compared = 0;

  const steps = [
    ["first run", () => loadSql(theirs.options.storePath, scenario.run1)],
    ["second run", () => loadSql(theirs.options.storePath, scenario.run2)],
    ["quiet run", () => {}],
    // The state is lost on both sides: only the lines already in the notes stop the repeats.
    ["run after losing the state", () => {
      writeTree(theirs.vault, { "scripts/.whatsapp-mcp-state.json": seedState });
      rmSync(ours.options.statePath);
    }],
  ];
  for (const [label, prepare] of steps) {
    prepare();
    const reference = runReference({ python, scriptsDir, vault: theirs.vault, storePath: theirs.options.storePath });
    const result = await exportWhatsApp({ ...ours.options, storePath: theirs.options.storePath });
    compared += assertSameTree(readTree(join(ours.vault, ...WA)), readTree(join(theirs.vault, ...WA)), label);
    assertSameOutcome(result, ours.options, reference, label);
  }
  assert.ok(compared >= 120, `only ${compared} files were compared`);
});
