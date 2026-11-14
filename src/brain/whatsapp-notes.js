import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  PY_SPACE_CLASS,
  asciiDigits,
  compareCodePoints,
  isoUtc,
  parseIsoDateTime,
  pyCollapseSpaces,
  pySplitlines,
  pyStr,
  pyStrip,
  sliceCodePoints,
} from "./whatsapp-pytext.js";

/**
 * The note format of the WhatsApp folder in the vault: file names, front matter, day headers,
 * message lines, the duplicate lock and the index. Every rule here reproduces what the reference
 * scripts wrote, quirks included, because the existing notes are appended to and never rewritten.
 */

export const GROUPS_FOLDER = "Grupos";
export const PERSONAL_FOLDER = "Personales";
export const DISCARDED_FOLDER = "_descartados";
export const INDEX_NAME = "_Conversation Index.md";

const MEDIA_LABELS = new Map([
  ["audio", "[audio]"], ["ptt", "[nota de voz]"], ["voice", "[nota de voz]"], ["image", "[imagen]"],
  ["photo", "[imagen]"], ["video", "[video]"], ["sticker", "[sticker]"], ["document", "[documento]"],
  ["gif", "[gif]"], ["location", "[ubicación]"], ["contact", "[contacto]"], ["vcard", "[contacto]"],
]);

/** The store writes its own marker where a media message has no words, in two styles: "[Audio]" and "Sent document". */
const BRACKET_PLACEHOLDER = /^\[[A-Za-zÁÉÍÓÚáéíóúñÑ ]{2,20}\]$/;
/** Python's case-insensitive "i" also takes the dotted and the dotless Turkish letters; JavaScript's does not. */
const PROSE_PLACEHOLDER = /^Sent (document|[i\u{130}\u{131}]mage|v[i\u{130}\u{131}]deo|aud[i\u{130}\u{131}]o|st[i\u{130}\u{131}]cker|g[i\u{130}\u{131}]f|photo)$/iu;

/** A message line already in a note. Python's \d takes every decimal digit, not only 0 to 9. */
const MESSAGE_LINE = /^\*\*\p{Nd}{2}:\p{Nd}{2}\*\* — /u;

/**
 * The chat id in the front matter. Written without the multiline flag because in JavaScript that
 * flag also starts a line after U+2028, and in Python only after a line feed.
 */
const FRONT_MATTER_CHAT_ID = new RegExp(`(?<![^\\n])chat_id:[${PY_SPACE_CLASS}]*"?([^"\\n]+)"?[${PY_SPACE_CLASS}]*(?![^\\n])`);

const TAIL_BYTES = 60000;
const HEAD_CHARS = 600;
const SEEN_IDS_KEPT = 300;

/** 32-bit FNV-1a in base 36: the suffix of every note's file name. It walks characters, not UTF-16 units. */
export function fnv1a36(text) {
  let hash = 2166136261;
  for (const char of String(text ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

/** What cannot go in an Obsidian file name becomes a space; then one space between words and 80 characters at most. */
export function sanitizeName(name) {
  const cleaned = pyStrip(pyCollapseSpaces(String(name ?? "").replace(/[\\/:*?"<>|#^[\]]/g, " ")));
  return sliceCodePoints(cleaned, 80) || "chat";
}

export function yamlQuote(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** group, personal, or null for what is not a conversation (status and broadcast lists). */
export function normalizeKind(kind, jid) {
  if (!jid) return null;
  if (jid.endsWith("@g.us")) return "group";
  const low = jid.toLowerCase();
  if (low.includes("status") || low.includes("broadcast")) return null;
  return kind === "group" ? "group" : "personal";
}

export function noteFilename(name, jid) {
  return `${sanitizeName(name)} ${fnv1a36(jid)}.md`;
}

/** Path of a chat's note relative to the vault, always with forward slashes. */
export function noteRelPath(folder, name, jid, kind) {
  return `${folder}/${kind === "group" ? GROUPS_FOLDER : PERSONAL_FOLDER}/${noteFilename(name, jid)}`;
}

export function frontMatter(name, jid, kind) {
  return `---\nsource: whatsapp\nchat_id: ${yamlQuote(jid)}\nchat_name: ${yamlQuote(name)}\nkind: ${kind}\n---\n\n# ${name}\n`;
}

/**
 * Turns seconds since 1970 into the day and the time on the wall in `timeZone`, 24 hours and zero
 * padded, which is what the notes show.
 */
export function createLocalClock(timeZone) {
  let format;
  try {
    format = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    throw new Error(`"${timeZone}" is not a time zone this computer knows.`);
  }
  return (sec) => {
    const parts = {};
    for (const { type, value } of format.formatToParts(new Date(sec * 1000))) parts[type] = value;
    return {
      day: `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`,
      second: parts.second,
    };
  };
}

/** A stored watermark as an instant, or null when it is empty or not a date. */
export function parseStamp(raw) {
  if (!raw) return null;
  return parseIsoDateTime(String(raw).replaceAll("Z", "+00:00"));
}

/** The same for the note writer, where a year before 1970 is how the store says "no value". */
export function parseWatermark(raw) {
  const parsed = parseStamp(raw);
  return parsed && parsed.year >= 1970 ? parsed : null;
}

function phoneFromJid(jid) {
  const local = jid.split("@")[0].split(":")[0];
  const digits = asciiDigits(local);
  if (digits && jid.includes("@s.whatsapp.net")) return `+${digits}`;
  return local ? `Member-${fnv1a36(local)}` : "Unknown";
}

/** Who a line is attributed to: me, a hand-written alias, the name from the store, the chat's own name in a 1-to-1, the phone. */
export function senderLabel(message, chatName, kind, senderAliases, ownName) {
  if (message.fromMe) return ownName;
  const senderJid = pyStrip(message.senderJid);
  if (senderJid && Object.hasOwn(senderAliases, senderJid)) return pyStr(senderAliases[senderJid]);
  const name = pyStrip(message.senderName);
  if (name && name.toLowerCase() !== "me") return name;
  if (kind === "personal" && chatName) return chatName;
  return senderJid ? phoneFromJid(senderJid) : "Unknown";
}

function isPlaceholder(text) {
  return BRACKET_PLACEHOLDER.test(text) || PROSE_PLACEHOLDER.test(text);
}

/** A caption wins over the media marker and real text wins over everything; the store's own marker counts as no text. */
export function messageText(message) {
  const media = pyStrip(message.mediaType).toLowerCase();
  const caption = pyStrip(message.caption);
  if (caption && !(media && isPlaceholder(caption))) return caption;
  const text = pyStrip(message.text);
  if (text && !(media && isPlaceholder(text))) return text;
  if (media) return MEDIA_LABELS.get(media) ?? `[${media}]`;
  return "";
}

/**
 * Raw rows to what gets written: one line per message, ordered by time and then by id.
 * Times before 1970 are how the store says "no value", and those rows are dropped.
 */
export function normalizeMessages(rawMessages, chatName, kind, senderAliases, ownName) {
  const out = [];
  for (const message of rawMessages ?? []) {
    const text = messageText(message);
    if (!text || message.sec < 0) continue;
    out.push({
      sec: message.sec,
      id: pyStrip(message.id),
      sender: senderLabel(message, chatName, kind, senderAliases, ownName),
      text: pyStrip(pySplitlines(text).join(" ")),
    });
  }
  return out.sort((a, b) => a.sec - b.sec || compareCodePoints(a.id, b.id));
}

export function renderLine(message, clock) {
  return `**${clock(message.sec).time}** — ${message.sender}: ${message.text}`;
}

/** The text to append and the last day header written: a header only when the day changes. */
export function renderBlock(messages, lastDateHeader, clock) {
  let chunk = "";
  let header = lastDateHeader;
  for (const message of messages) {
    const { day } = clock(message.sec);
    if (day !== header) {
      chunk += `\n## ${day}\n\n`;
      header = day;
    }
    chunk += `${renderLine(message, clock)}\n\n`;
  }
  return { chunk, header };
}

function readBytes(path, start, length) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const from = start < 0 ? Math.max(0, size + start) : start;
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - from)));
    let done = 0;
    while (done < buffer.length) {
      const read = readSync(fd, buffer, done, buffer.length - done, from + done);
      if (read === 0) break;
      done += read;
    }
    return { size, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(buffer.subarray(0, done)) };
  } finally {
    closeSync(fd);
  }
}

/**
 * The message lines in the last 60,000 bytes of a note. This is the real lock against writing a
 * message twice: a line that renders exactly like one already there is not written again. The
 * cut is in bytes and can land inside a line or a character, so the first piece is thrown away.
 */
export function tailLines(path) {
  let blob;
  try {
    const { size, text } = readBytes(path, -TAIL_BYTES, TAIL_BYTES);
    blob = text;
    if (size > TAIL_BYTES) {
      const end = blob.search(/[\n\r]/);
      blob = end < 0 ? "" : blob.slice(end + (blob.startsWith("\r\n", end) ? 2 : 1));
    }
  } catch {
    return new Set();
  }
  const lines = new Set();
  for (const line of pySplitlines(blob)) if (MESSAGE_LINE.test(line)) lines.add(pyStrip(line));
  return lines;
}

function listing(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  } catch {
    return [];
  }
}

function isDirectory(dir, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds the note of every chat already in the vault by the chat id in its front matter, so a note
 * that was renamed or moved to the discard folder keeps receiving its messages instead of getting
 * a second note. The order matters, the first note found for a chat wins: personal, groups, then
 * the discard folder from the top down. Names starting with a dot are not looked at, and only the
 * first 600 characters of each note are read.
 */
export function indexExistingNotes(vault, folder) {
  const found = new Map();
  const scan = (dir, rel) => {
    for (const entry of listing(dir)) {
      if (!entry.name.endsWith(".md")) continue;
      let head;
      try {
        head = readBytes(join(dir, entry.name), 0, 4096).text;
      } catch {
        continue;
      }
      const match = FRONT_MATTER_CHAT_ID.exec(sliceCodePoints(head.replace(/\r\n?/g, "\n"), HEAD_CHARS));
      const chatId = match ? pyStrip(match[1]) : "";
      if (match && !found.has(chatId)) found.set(chatId, { path: join(dir, entry.name), rel: `${rel}/${entry.name}` });
    }
  };
  const walk = (dir, rel, depth) => {
    scan(dir, rel);
    if (depth > 40) return;
    for (const entry of listing(dir)) {
      if (isDirectory(dir, entry)) walk(join(dir, entry.name), `${rel}/${entry.name}`, depth + 1);
    }
  };
  const root = join(vault, ...folder.split("/"));
  scan(join(root, PERSONAL_FOLDER), `${folder}/${PERSONAL_FOLDER}`);
  scan(join(root, GROUPS_FOLDER), `${folder}/${GROUPS_FOLDER}`);
  walk(join(root, DISCARDED_FOLDER), `${folder}/${DISCARDED_FOLDER}`, 0);
  return found;
}

export function isQuarantined(path) {
  return path.includes(`${sep}${DISCARDED_FOLDER}${sep}`);
}

/** Refuses a note whose real location, after following links, is outside the WhatsApp folder. */
export function assertInsideFolder(root, target) {
  const inside = (base, path) => path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
  let existing = dirname(target);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let base = root;
  while (!existsSync(base) && dirname(base) !== base) base = dirname(base);
  const realBase = realpathSync(base) + root.slice(base.length);
  const realDir = realpathSync(existing) + dirname(target).slice(existing.length);
  if (!inside(realBase, realDir) || (existsSync(target) && !inside(realBase, realpathSync(target)))) {
    throw new Error(`Refusing to write a WhatsApp note outside its folder: ${target}`);
  }
}

/** The ids remembered per chat: the ones already known plus the new ones, the newest 300. */
export function rememberIds(seen, messages) {
  return [...seen, ...messages.filter((message) => message.id).map((message) => message.id)].slice(-SEEN_IDS_KEPT);
}

/** Last message of a block as the watermark text the state keeps. */
export function watermarkText(message) {
  return isoUtc(message.sec);
}

/**
 * The text of the conversation index. It is the reference scripts' text, word for word, subtitle
 * included, so the file does not change when the exporter changes hands. Chats come in the order
 * of the state, newest watermark first, and chats with the same watermark keep the state's order.
 */
export function buildIndex(chats, folder) {
  const rows = [];
  for (const [jid, entry] of chats) {
    const kind = entry.kind ?? "personal";
    let note = String(entry.note_path || "").replaceAll(".md", "");
    if (!note) note = noteRelPath(folder, entry.name ?? "", jid, kind).replaceAll(".md", "");
    rows.push({
      name: "name" in entry ? pyStr(entry.name) : "",
      kind,
      note,
      count: "message_count" in entry ? pyStr(entry.message_count) : "0",
      last: sliceCodePoints(String(entry.last_ts || ""), 10),
      sort: String(entry.last_ts || ""),
    });
  }
  rows.sort((a, b) => compareCodePoints(b.sort, a.sort));
  const line = (row) => `- [[${row.note}|${row.name}]] — ${row.count} msgs · ${row.last}`;
  const groups = rows.filter((row) => row.kind === "group");
  const personal = rows.filter((row) => row.kind !== "group");
  return (
    "# WhatsApp — Conversation Index\n\n" +
    `_${rows.length} conversation(s). Regenerado en cada corrida de \`whatsapp-ingest-diario\` (pull vía LMCP)._\n\n` +
    `## Personal (${personal.length})\n\n${personal.map(line).join("\n")}\n\n` +
    `## Groups (${groups.length})\n\n${groups.map(line).join("\n")}\n`
  );
}
