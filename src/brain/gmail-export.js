// Gmail as notes: each account's mail goes into the vault as one Markdown file per day, in the exact
// layout the vault's older day files already have, so an existing folder is continued and never
// duplicated. Nothing here touches the network: the mail comes from anything with exportSince().
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { defaultMailLabel, rawFolder } from "./config.js";

const MAX_BODY_CHARS = 2500;
const DEFAULT_LOOKBACK_DAYS = 2;
const MAX_LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const MARKER = /<!-- gmail:[0-9a-f]+ -->/;
const MARKERS = /<!-- gmail:([0-9a-f]+) -->/g;
const CLIPPED = "\n…[recortado]";
const QUOTED_OMITTED = "\n[…hilo citado omitido]";

// Where a reply starts quoting the thread: the Spanish and English attribution lines, and the
// "De: … / Enviado:" block Outlook writes.
const QUOTED_THREAD = /\n\s*(?:El [^\n]{5,160}?escribi[oó]:|On [^\n]{5,160}?wrote:|De: [^\n]{3,120}\n\s*Enviado)/u;

// Word edges are spelled out because \b only knows ASCII letters, and subjects are often not ASCII.
const EDGE_BEFORE = "(?<![\\p{L}\\p{N}_])";
const EDGE_AFTER = "(?![\\p{L}\\p{N}_])";
// Sign-in codes, passwords and security alerts must never reach the notes.
const SKIP_SUBJECT = new RegExp(
  [
    "c[oó]digo",
    `code${EDGE_AFTER}`,
    "verificaci[oó]n",
    "verification",
    "contrase[ñn]a",
    "password",
    `${EDGE_BEFORE}OTP${EDGE_AFTER}`,
    `${EDGE_BEFORE}NIP${EDGE_AFTER}`,
    "token",
    "inicio de sesi[oó]n",
    "sign[- ]in",
    "security alert",
    "alerta de seguridad",
    "2fa",
    "autenticaci[oó]n",
    "credenciales",
  ].join("|"),
  "iu",
);

// Named character references: Latin-1 in code point order from U+00A0, then typography and common
// symbols as name:hex. A name that is not here stays as written.
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo " +
  "frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve " +
  "Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute " +
  "ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const OTHER_NAMES =
  "apos:27 OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2c6 tilde:2dc ensp:2002 emsp:2003 thinsp:2009 zwnj:200c zwj:200d lrm:200e " +
  "rlm:200f ndash:2013 mdash:2014 lsquo:2018 rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 bull:2022 hellip:2026 " +
  "permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a oline:203e frasl:2044 euro:20ac trade:2122 larr:2190 uarr:2191 rarr:2192 darr:2193 " +
  "harr:2194 crarr:21b5 lArr:21d0 uArr:21d1 rArr:21d2 dArr:21d3 hArr:21d4 minus:2212 lowast:2217 radic:221a infin:221e asymp:2248 ne:2260 equiv:2261 " +
  "le:2264 ge:2265 loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666";
// Old HTML also writes these, and the Latin-1 names, without the closing semicolon ("&copy 2026").
const LEGACY = { amp: "&", lt: "<", gt: ">", quot: '"', AMP: "&", LT: "<", GT: ">", QUOT: '"', COPY: "\u00a9", REG: "\u00ae" };
const ENTITIES = new Map();
for (const [name, char] of [...Object.entries(LEGACY), ...LATIN1_NAMES.split(" ").map((name, index) => [name, String.fromCodePoint(0xa0 + index)])]) {
  ENTITIES.set(name, char).set(`${name};`, char);
}
for (const pair of OTHER_NAMES.split(" ")) {
  const [name, hex] = pair.split(":");
  ENTITIES.set(`${name};`, String.fromCodePoint(parseInt(hex, 16)));
}
// &#128; to &#159; mean Windows-1252 in practice, the way browsers read them.
const WINDOWS_1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

function numericReference(code) {
  if (code === 0) return "\ufffd";
  if (code === 0x0d) return "\r";
  if (code >= 0x80 && code <= 0x9f) return WINDOWS_1252[code - 0x80];
  if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return "\ufffd";
  const control = (code >= 0x01 && code <= 0x08) || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
  if (control || (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xfffe) === 0xfffe) return "";
  return String.fromCodePoint(code);
}

/** Character references to text, by the HTML rules: a known name also counts as the start of a longer word. */
function unescapeHtml(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return numericReference(Number(hex ? `0x${body.slice(2).replace(";", "")}` : body.slice(1).replace(";", "")));
    }
    if (ENTITIES.has(body)) return ENTITIES.get(body);
    for (let length = body.length - 1; length > 1; length--) {
      if (ENTITIES.has(body.slice(0, length))) return ENTITIES.get(body.slice(0, length)) + body.slice(length);
    }
    return whole;
  });
}

/** The text of an HTML-only email: tags out, line breaks where blocks end, entities decoded. */
export function stripHtml(html) {
  const text = String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return unescapeHtml(text)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Gmail's message id as IMAP gives it (X-GM-MSGID, decimal) → the id the Gmail API uses (hex).
 * The markers already in the vault are hex, and matching them is what prevents duplicates.
 */
export function gmailIdToHex(decimal) {
  const text = String(decimal ?? "").trim();
  if (!/^\d{1,20}$/.test(text)) throw new Error("That is not a Gmail message id.");
  return BigInt(text).toString(16);
}

/** True for mail that must stay out of the notes: codes, passwords, sign-in and security alerts. */
export function skipSubject(subject) {
  return SKIP_SUBJECT.test(String(subject ?? ""));
}

/** `raw/Personal/gmail` → "personal"; `raw/Acme/gmail` → "de Acme". The label is part of each day file's title. */
export const defaultLabel = defaultMailLabel;

/** The top of a new day file. An existing file keeps whatever top it already has. */
export function dayFileHeader({ label, email, day }) {
  return `---\nfuente: gmail ${label} (${email})\nfecha: ${day}\n---\n\n# Correo ${label} · ${day}\n\n`;
}

/** A clock for one time zone. Made per run, so a computer that changes zone is not stuck with the old one. */
function zoneClock(timeZone) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (ms) => {
    const date = new Date(ms);
    if (ms === null || ms === undefined || Number.isNaN(date.getTime())) throw new Error("A message has no valid date.");
    const part = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
    return { day: `${part.year}-${part.month}-${part.day}`, time: `${part.hour}:${part.minute}`, part };
  };
}

/** The instant a local day starts in a zone. The offset is looked up twice so a clock change that night is absorbed. */
function dayStart(day, clock) {
  const [year, month, date] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date);
  let instant = wall;
  for (let pass = 0; pass < 2; pass++) {
    const { part } = clock(instant);
    const shown = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(part.hour), Number(part.minute));
    instant = wall - (shown - Math.floor(instant / 60_000) * 60_000);
  }
  return instant;
}

// A header value can never be allowed to start a new line: that line could pose as a heading or a marker.
const oneLine = (value) => String(value ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim();

function bodyText(message) {
  let text = String(message.text ?? "").replace(/\r\n/g, "\n").trim() || stripHtml(message.html);
  const quoted = text.search(QUOTED_THREAD);
  if (quoted !== -1) text = text.slice(0, quoted).trimEnd() + QUOTED_OMITTED;
  text = text.replace(/\n{3,}/g, "\n\n");
  if (text.length > MAX_BODY_CHARS) {
    // Counted in characters, not UTF-16 units, so an emoji is never cut in half.
    const chars = Array.from(text);
    if (chars.length > MAX_BODY_CHARS) text = chars.slice(0, MAX_BODY_CHARS).join("") + CLIPPED;
  }
  return text;
}

function blockAt(message, time) {
  const id = String(message.id ?? "");
  if (!/^[0-9a-f]+$/.test(id)) throw new Error("A message has no valid Gmail id.");
  const who = message.sent ? `yo → ${oneLine(message.to)}` : oneLine(message.from);
  const files = (message.attachments ?? []).map(
    ({ filename, contentType, size }) => `${oneLine(filename)} (${oneLine(contentType)}, ${Math.floor((Number(size) || 0) / 1024)} KB)`,
  );
  const attached = files.length ? `Adjuntos: ${files.join("; ")}\n` : "";
  return `## ${time} · ${who} — ${oneLine(message.subject) || "(sin asunto)"}\n<!-- gmail:${id} -->\n${attached}\n${bodyText(message)}\n`;
}

/**
 * One email as it is written in a day file: a heading with the local time, the id marker that
 * prevents duplicates, the attachment list when there is one, and the text. `message` is one item of
 * exportSince(); `html` is only read when `text` is empty.
 */
export function formatMailBlock(message, { timeZone } = {}) {
  return blockAt(message, zoneClock(timeZone)(message.date).time);
}

/**
 * Adds to a day file the blocks whose marker is not in it yet. Returns `{ text, added }`; the existing
 * part is kept byte for byte, apart from the line breaks at its very end.
 */
export function mergeDayFile(existing, header, blocks) {
  const base = String(existing ?? "").trim() ? existing : header;
  const seen = new Set();
  const fresh = [];
  for (const block of blocks ?? []) {
    const marker = String(block).match(MARKER)?.[0];
    if (!marker) throw new Error("A mail block has no gmail marker.");
    if (seen.has(marker) || base.includes(marker)) continue;
    seen.add(marker);
    fresh.push(block);
  }
  if (!fresh.length) return { text: base, added: 0 };
  return { text: `${base.replace(/\n+$/, "")}\n\n${fresh.join("\n")}`, added: fresh.length };
}

/** The folder as vault-relative segments, or an error: relative, under raw/, with no way out. */
/** The one rule for where an exporter may write lives with the settings, so both always agree. */
const folderParts = (folder) => rawFolder(folder).split("/");

function instant(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error("The start date is not valid.");
  return ms;
}

/** The days that already have a file in the folder, oldest first. */
async function writtenDays(dir) {
  const names = await readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw new Error(`Could not read the folder ${dir}: ${error.message}`, { cause: error });
  });
  return names
    .map((name) => name.match(DAY_FILE)?.[1])
    .filter(Boolean)
    .sort();
}

/**
 * Without a start date the export resumes from the newest day file: from the start of that day, so a
 * day that was written halfway is completed, and the markers keep the rest from repeating.
 */
function resumePoint(days, nowMs, clock) {
  const today = clock(nowMs).day;
  // A file dated after today would push the start into the future and hide every new email.
  const newest = days.filter((day) => day <= today).at(-1);
  const start = newest ? dayStart(newest, clock) : nowMs - DEFAULT_LOOKBACK_DAYS * DAY_MS;
  return Math.max(start, nowMs - MAX_LOOKBACK_DAYS * DAY_MS);
}

/** The ids already written in these day files. Their mail does not need to be downloaded again. */
async function writtenIds(dir, days) {
  const ids = new Set();
  for (const day of days) {
    const text = await readFile(join(dir, `${day}.md`), "utf8").catch((error) => {
      throw new Error(`Could not read ${day}.md: ${error.message}`, { cause: error });
    });
    for (const [, id] of text.matchAll(MARKERS)) ids.add(id);
  }
  return ids;
}

/** Temp file and rename in the same folder, so a reader or a sync never sees half a day. */
async function writeAtomic(dir, name, text) {
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, join(dir, name));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Writes one account's mail since `since` into `<vault>/<folder>/YYYY-MM-DD.md`, split by local day.
 * Returns what changed. Any failure throws: a run that could not read the mail must never look like
 * a day without mail. It only writes inside that folder and never runs git.
 */
export async function exportGmailAccount({ gmail, account, vault, folder, label, since, now = () => new Date(), timeZone, limit }) {
  const parts = folderParts(folder);
  const relative = parts.join("/");
  if (typeof vault !== "string" || !isAbsolute(vault)) throw new Error("The vault must be a full folder path.");
  if (!(await stat(vault).catch(() => null))?.isDirectory()) throw new Error(`The vault folder was not found: ${vault}`);
  const dir = join(vault, ...parts);
  const title = oneLine(label) || defaultLabel(relative);
  const clock = zoneClock(timeZone);
  const startedAt = instant(now());
  const days = await writtenDays(dir);
  const from = since === undefined || since === null ? resumePoint(days, startedAt, clock) : instant(since);
  // One day earlier than the start as well: after a change of time zone an email can sit in the file before.
  const dayBefore = clock(from - DAY_MS).day;
  const known = await writtenIds(dir, days.filter((day) => day >= dayBefore));

  let result;
  try {
    result = await gmail.exportSince({ account, since: new Date(from), known, ...(limit === undefined ? {} : { limit }) });
  } catch (error) {
    throw new Error(`Could not export the mail of ${account}: ${error?.message ?? error}`, { cause: error });
  }
  if (!result?.account || !Array.isArray(result.messages)) throw new Error(`Could not export the mail of ${account}: Gmail gave no message list.`);

  const byDay = new Map();
  let skipped = 0;
  for (const message of [...result.messages].sort((a, b) => a.date - b.date)) {
    if (message.draft) continue;
    if (skipSubject(message.subject)) {
      skipped++;
      continue;
    }
    const { day, time } = clock(message.date);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(blockAt(message, time));
  }

  let written = 0;
  const files = [];
  for (const day of [...byDay.keys()].sort()) {
    const name = `${day}.md`;
    try {
      const existing = await readFile(join(dir, name), "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const merged = mergeDayFile(existing, dayFileHeader({ label: title, email: result.account, day }), byDay.get(day));
      if (!merged.added) continue;
      await mkdir(dir, { recursive: true });
      await writeAtomic(dir, name, merged.text);
      written += merged.added;
      files.push(`${relative}/${name}`);
    } catch (error) {
      throw new Error(`Could not write ${relative}/${name}: ${error.message}`, { cause: error });
    }
  }
  return {
    account: result.account,
    folder: relative,
    written,
    days: byDay.size,
    skipped,
    files,
    startedAt: new Date(startedAt).toISOString(),
    since: new Date(from).toISOString(),
    // More mail matched than one run takes. The oldest came first, so the next run continues from there.
    truncated: Number(result.total) > result.messages.length,
  };
}
