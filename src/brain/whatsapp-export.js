import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  INDEX_NAME,
  assertInsideFolder,
  buildIndex,
  createLocalClock,
  frontMatter,
  indexExistingNotes,
  isQuarantined,
  normalizeKind,
  normalizeMessages,
  noteRelPath,
  parseStamp,
  parseWatermark,
  rememberIds,
  renderBlock,
  renderLine,
  tailLines,
  watermarkText,
} from "./whatsapp-notes.js";
import { compareInstants, isCombining, isPyAlnum, isPySpace, isoUtc, pyDigits, pyRound1, pySplit, pyStrip } from "./whatsapp-pytext.js";
import { createSqlite, queryRows, snapshotStore, sqlLiteral } from "./whatsapp-store.js";

/**
 * Writes the WhatsApp chats of the wacli store into the vault as Markdown notes, one per chat,
 * appending only what is new. It replaces a pair of reference scripts that did the same job, and
 * its output is byte for byte theirs: the vault already holds hundreds of notes written by them.
 *
 * Living next to the reference scripts. They keep their own state and aliases files inside the
 * vault; this exporter keeps its own outside it and never writes to theirs. At the start of every
 * run the two are merged in memory:
 *   - state: per chat, the entry with the later watermark (`last_ts`) wins, and a chat only the
 *     other file knows is taken as it is. Chats keep the order of this exporter's own file and
 *     the ones only the seed has go last, in the seed's order, because the index lists chats with
 *     the same watermark in the order of the state.
 *   - aliases: the union of both, and where they disagree the seed wins, since it is the file a
 *     person edits by hand.
 * The merged result is what gets saved to this exporter's files, so they stay complete on their
 * own once the reference scripts and their files are gone.
 */

const DEFAULT_FOLDER = "raw/Personal/whatsapp";
const LAST_SECOND = 253402300799; // 9999-12-31T23:59:59Z, the last moment a note can show

/** Chats that are not conversations: status updates, broadcast lists and newsletters. */
const SKIPPED_KINDS = new Set(["broadcast", "newsletter", "unknown"]);
const SKIPPED_JID_MARKERS = ["@newsletter", "@broadcast", "status@"];

/** The folder inside the vault, cleaned: relative, under raw/, with no way out of it. */
export function validateFolder(folder) {
  const text = String(folder ?? "");
  if (!text || text.includes("\0")) throw new Error("The WhatsApp folder is missing.");
  if (isAbsolute(text) || /^[\\/]|^[A-Za-z]:/.test(text)) throw new Error("The WhatsApp folder must be a path inside the vault, not an absolute one.");
  if (text.includes("..")) throw new Error('The WhatsApp folder cannot contain "..".');
  const parts = text.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (parts[0] !== "raw" || parts.length < 2) throw new Error('The WhatsApp folder must start with "raw/".');
  return parts.join("/");
}

async function readJson(path, what) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`${what} at ${path} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} at ${path} is not valid JSON.`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function chatEntries(state) {
  return isRecord(state?.chats) ? Object.entries(state.chats).filter(([, entry]) => isRecord(entry)) : [];
}

/**
 * This exporter's state with the seed merged in, as described at the top of the file. Returns the
 * top-level fields and the chats as a Map, which keeps the order of insertion for every key.
 */
export function mergeSeedState(own, seed) {
  const top = isRecord(own) ? { ...own } : { version: 1, source: "smcp", last_run: null };
  const chats = new Map(chatEntries(own).map(([jid, entry]) => [jid, structuredClone(entry)]));
  for (const [jid, entry] of chatEntries(seed)) {
    const mine = chats.get(jid);
    const theirs = parseStamp(entry.last_ts);
    const ours = mine ? parseStamp(mine.last_ts) : null;
    if (!mine || (theirs && (!ours || compareInstants(theirs, ours) > 0))) chats.set(jid, structuredClone(entry));
  }
  delete top.chats;
  return { top, chats };
}

/** Both alias maps together; the seed wins a disagreement. Only text to text pairs are kept. */
export function mergeSeedAliases(own, seed) {
  const merged = new Map();
  for (const source of [own, seed]) {
    if (!isRecord(source?.aliases)) continue;
    for (const [jid, canonical] of Object.entries(source.aliases)) {
      if (typeof canonical === "string" && canonical) merged.set(jid, canonical);
    }
  }
  return merged;
}

/**
 * A name reduced to what two spellings of it share: no accents, no punctuation, single spaces,
 * lower case. Only used to recognise one person behind two ids.
 */
export function normName(name) {
  let out = "";
  for (const char of String(name ?? "").normalize("NFKD")) {
    if (isCombining(char)) continue;
    out += isPyAlnum(char) || isPySpace(char) ? char : " ";
  }
  return pySplit(out).join(" ").toLowerCase();
}

/** Python's truth of a value from the store: nothing, zero and empty text are false. */
const truthy = (value) => value !== null && value !== undefined && value !== 0 && value !== "";
const textOf = (value) => (truthy(value) ? String(value) : "");

/**
 * The same contact shows up as a phone id, with a device suffix (":12@") or as an opaque "@lid"
 * id. All the forms are tried before giving up on a name.
 */
export function jidVariants(jid) {
  if (!jid) return [];
  const pieces = jid.split("@");
  const local = pieces[0];
  const bare = local.split(":")[0];
  const out = [jid];
  if (local.includes(":")) out.push(`${bare}@${pieces.length > 1 ? pieces[1] : ""}`);
  out.push(`${bare}@s.whatsapp.net`, `${bare}@lid`);
  return [...new Set(out)];
}

/** jid to the best name the address book has: a hand-written alias, then full, system, business and push name, then the phone. */
function buildContactIndex(aliasRows, contactRows) {
  const names = new Map();
  for (const { jid, alias } of aliasRows) {
    const name = pyStrip(textOf(alias));
    if (name) names.set(jid, name);
  }
  for (const row of contactRows) {
    if (names.has(row.jid)) continue;
    const name = [row.full_name, row.system_name, row.business_name, row.push_name].map((value) => pyStrip(textOf(value))).find(Boolean);
    if (name) {
      names.set(row.jid, name);
      continue;
    }
    // 8 to 15 digits is a plausible phone; groups get pseudo-contacts whose "phone" is longer.
    const digits = Array.from(pyDigits(textOf(row.phone)));
    if (digits.length >= 8 && digits.length <= 15 && !textOf(row.jid).endsWith("@g.us")) names.set(row.jid, `+${digits.join("")}`);
  }
  return names;
}

function lookupContact(jid, contacts) {
  for (const candidate of jidVariants(jid)) if (contacts.has(candidate)) return contacts.get(candidate);
  return undefined;
}

/** "+52…" for a chat with no name. The store sometimes leaves the whole id as the name. */
function readableNumber(jid) {
  const digits = pyDigits((jid || "").split("@")[0].split(":")[0]);
  return digits ? `+${digits}` : jid || "chat";
}

function chatDisplayName(jid, kind, chatName, groupName, contacts) {
  if (kind === "group") return pyStrip(textOf(groupName) || textOf(chatName) || jid.split("@")[0]);
  const known = lookupContact(jid, contacts);
  if (known !== undefined) return known;
  const name = pyStrip(textOf(chatName));
  return !name || name.includes("@") ? readableNumber(jid) : name;
}

/**
 * The owner's messages in a group come with the group's id as the sender and "me" as the name, so
 * own messages are settled first and a group id is never looked up as a contact.
 */
function resolveSender(row, contacts, chatJid, ownName) {
  if (truthy(row.from_me)) return ownName;
  const senderJid = pyStrip(textOf(row.sender_jid));
  if (senderJid && !senderJid.endsWith("@g.us") && senderJid !== chatJid) {
    const known = lookupContact(senderJid, contacts);
    if (known !== undefined) return known;
  }
  const name = pyStrip(textOf(row.sender_name));
  return name.toLowerCase() === "me" ? "" : name;
}

/** A watermark as whole seconds since 1970, cut toward zero. Here any year counts; only the note writer ignores the early ones. */
function watermarkSeconds(entry) {
  const instant = parseStamp(entry.last_ts);
  return instant ? Math.trunc(instant.sec + instant.micro / 1e6) : undefined;
}

/**
 * Some people are known by an opaque "@lid" id in the notes written long ago and by their phone
 * in the store: one conversation with two keys. Without joining them the phone chat would look
 * new, get the whole backfill and a second note with the history repeated. The conditions are
 * narrow on purpose, because joining two different conversations in one file cannot be undone:
 *   1. the store's chat is a 1-to-1 with a phone id, and the known chat is an "@lid";
 *   2. the cleaned name matches exactly one known chat;
 *   3. the known id is not a chat of its own in the store (then they are two chats, not one).
 * Groups are never joined: different groups with the same name are common. A name that matches
 * two known chats joins nothing and is reported for a person to settle.
 */
function reconcileIdentities({ chatRows, marks, stateChats, contacts, aliases }) {
  const knownByName = new Map();
  for (const [jid, entry] of stateChats) {
    const key = normName(textOf(entry.name));
    if (!knownByName.has(key)) knownByName.set(key, []);
    knownByName.get(key).push(jid);
  }
  const inStore = new Set(chatRows.map((row) => row.jid));
  const taken = new Set(aliases.values());
  const merged = [];
  const ambiguous = [];
  for (const row of chatRows) {
    const jid = row.jid;
    if (typeof jid !== "string" || stateChats.has(jid) || aliases.has(jid)) continue;
    if (textOf(row.kind).toLowerCase() !== "dm" || !jid.endsWith("@s.whatsapp.net")) continue;
    const name = chatDisplayName(jid, "dm", row.name, null, contacts);
    const candidates = (knownByName.get(normName(name)) ?? []).filter((known) => known.endsWith("@lid") && !taken.has(known) && !inStore.has(known));
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      ambiguous.push({ wacliJid: jid, name, candidates });
      continue;
    }
    const canonicalJid = candidates[0];
    const mark = marks.get(canonicalJid);
    const sameLastMessage = Boolean(mark) && truthy(row.last_message_ts) && Math.abs(mark - row.last_message_ts) <= 1;
    aliases.set(jid, canonicalJid);
    taken.add(canonicalJid);
    merged.push({ wacliJid: jid, canonicalJid, name, evidence: sameLastMessage ? "unique name and same last message" : "unique name" });
  }
  return { merged, ambiguous };
}

/** Reads the snapshot and gathers, per chat, the messages after its watermark (or inside the backfill for a new chat). */
async function pullStore({ sqlite, dir, pageSize, stateChats, aliases, ownName, backfillDays, nowMs }) {
  const read = (columns, from) => queryRows({ sqlite, dir, columns, from, pageSize });
  const contacts = buildContactIndex(
    await read(["jid", "alias"], "contact_aliases"),
    await read(["jid", "phone", "push_name", "full_name", "business_name", "system_name"], "contacts"),
  );
  const marks = new Map();
  for (const [jid, entry] of stateChats) {
    const seconds = watermarkSeconds(entry);
    if (seconds !== undefined) marks.set(jid, seconds);
  }
  const floor = Math.trunc((nowMs - backfillDays * 86_400_000) / 1000);
  const groupNames = new Map((await read(["jid", "name"], "groups")).map((row) => [row.jid, row.name]));

  const scanRows = await read(["jid", "kind", "name", "last_message_ts"], "chats");
  const { merged, ambiguous } = reconcileIdentities({ chatRows: scanRows, marks, stateChats, contacts, aliases });

  // How fresh the store is, not the vault: "nobody wrote" and "the store stopped receiving" are both zero new messages.
  const [{ last: storeLast }] = await read(["max(ts) AS last"], "messages");
  const stats = {
    chatsScanned: 0,
    chatsWithNew: 0,
    messages: 0,
    skippedChats: 0,
    identitiesMerged: aliases.size,
    identitiesAmbiguous: ambiguous.length,
    storeLastMessage: truthy(storeLast) ? isoUtc(Math.floor(storeLast)) : null,
    storeHoursWithoutMessages: truthy(storeLast) ? pyRound1((nowMs / 1000 - storeLast) / 3600) : null,
  };

  const chats = [];
  const byCanonical = new Map();
  for (const chat of await read(["jid", "kind", "name", "last_message_ts"], "chats ORDER BY last_message_ts DESC")) {
    const jid = chat.jid;
    const kind = textOf(chat.kind).toLowerCase();
    stats.chatsScanned += 1;
    if (typeof jid !== "string" || SKIPPED_KINDS.has(kind) || SKIPPED_JID_MARKERS.some((marker) => jid.toLowerCase().includes(marker))) {
      stats.skippedChats += 1;
      continue;
    }
    // The chat can come under another key than the one its note already uses.
    const canonical = aliases.get(jid) ?? jid;
    const since = marks.get(canonical) ?? floor;
    if (!truthy(chat.last_message_ts) || chat.last_message_ts <= since) continue;

    const rows = await read(
      ["msg_id", "sender_jid", "sender_name", "ts", "from_me", "text", "media_caption", "media_type"],
      `messages WHERE chat_jid = ${sqlLiteral(jid)} AND ts > ${sqlLiteral(since)}` +
        " AND revoked = 0 AND deleted_for_me = 0 AND (reaction_to_id IS NULL OR reaction_to_id = '')" +
        " AND ((text IS NOT NULL AND trim(text) <> '') OR (media_caption IS NOT NULL AND trim(media_caption) <> ''))" +
        " ORDER BY ts ASC, rowid ASC",
    );
    if (rows.length === 0) continue;

    const payloadKind = kind === "group" ? "group" : "dm";
    let name = chatDisplayName(jid, payloadKind, chat.name, groupNames.get(jid), contacts);
    const messages = rows.map((row) => {
      const sec = Math.floor(Number(row.ts));
      if (!(sec <= LAST_SECOND)) throw new Error(`A message in the WhatsApp store has a time that is not a date (chat ${jid}, value ${row.ts}).`);
      return {
        id: textOf(row.msg_id),
        sec,
        fromMe: truthy(row.from_me),
        senderJid: textOf(row.sender_jid),
        senderName: resolveSender(row, contacts, jid, ownName),
        text: textOf(row.text),
        caption: textOf(row.media_caption),
        mediaType: textOf(row.media_type),
      };
    });
    // An alias keeps the name its note already has: a new name would mean a new file and a split history.
    if (canonical !== jid) name = textOf(stateChats.get(canonical)?.name) || name;

    const entry = byCanonical.get(canonical);
    if (entry) {
      // Both keys of one conversation had news: one list, by time, each side keeping its own order.
      entry.messages = entry.messages.concat(messages).sort((a, b) => a.sec - b.sec);
    } else {
      const created = { chatId: canonical, name, kind: payloadKind, messages };
      byCanonical.set(canonical, created);
      chats.push(created);
    }
    stats.messages += messages.length;
  }
  stats.chatsWithNew = chats.length;
  return { stats, chats, merged, ambiguous };
}

/** Appends what is new to each chat's note and updates the state in memory. Two locks stop repeats: the watermark with the ids already seen, and the lines already in the note. */
async function writeNotes({ payloadChats, stateChats, vault, folder, senderAliases, ownName, clock, dryRun }) {
  const root = join(vault, ...folder.split("/"));
  const existing = indexExistingNotes(vault, folder);
  const report = { chatsTouched: 0, messagesWritten: 0, notesCreated: 0, skippedChats: 0, quarantinedAppends: 0, duplicatesSkipped: 0, detail: [] };
  const files = [];

  for (const chat of payloadChats) {
    const jid = pyStrip(chat.chatId);
    const name = pyStrip(chat.name) || jid.split("@")[0];
    const kind = normalizeKind(chat.kind, jid);
    if (!jid || kind === null) {
      report.skippedChats += 1;
      continue;
    }
    let entry = stateChats.get(jid);
    if (!entry) {
      entry = { name, kind, note_path: "", last_ts: "", last_date_header: "", message_count: 0, seen_ids: [] };
      stateChats.set(jid, entry);
    }
    if (name) entry.name = name;
    entry.kind = kind;

    // Where the note lives: the one that already exists wins, even in the discard folder.
    const known = existing.get(jid);
    const rel = known ? known.rel : noteRelPath(folder, entry.name, jid, kind);
    const path = known ? known.path : join(vault, ...rel.split("/"));
    const created = !known && !existsSync(path);

    const messages = normalizeMessages(chat.messages, name, kind, senderAliases, ownName);
    const watermark = parseWatermark(entry.last_ts);
    const seen = new Set(Array.isArray(entry.seen_ids) ? entry.seen_ids : []);
    // The watermark admits its own second on purpose: old watermarks carry milliseconds and the store only seconds.
    const candidates = messages.filter((message) => (!watermark || compareInstants({ sec: message.sec, micro: 0 }, watermark) >= 0) && (!message.id || !seen.has(message.id)));
    const already = tailLines(path);
    const fresh = [];
    let duplicates = 0;
    for (const message of candidates) {
      const line = renderLine(message, clock);
      if (already.has(line)) {
        duplicates += 1;
        continue;
      }
      already.add(line);
      fresh.push(message);
    }
    report.duplicatesSkipped += duplicates;
    if (fresh.length === 0) {
      if (duplicates && !dryRun) entry.seen_ids = rememberIds(seen, candidates);
      continue;
    }

    const { chunk, header } = renderBlock(fresh, entry.last_date_header || "", clock);
    if (!dryRun) {
      assertInsideFolder(root, path);
      await mkdir(dirname(path), { recursive: true });
      if (created) await writeFile(path, frontMatter(entry.name, jid, kind) + chunk);
      else await appendFile(path, chunk);
    }

    entry.note_path = rel;
    entry.last_ts = watermarkText(fresh.at(-1));
    entry.last_date_header = header;
    entry.message_count = Math.trunc(Number(entry.message_count) || 0) + fresh.length;
    entry.seen_ids = rememberIds(seen, fresh);

    const quarantined = isQuarantined(path);
    report.chatsTouched += 1;
    report.messagesWritten += fresh.length;
    report.notesCreated += created ? 1 : 0;
    report.quarantinedAppends += quarantined ? 1 : 0;
    report.detail.push({ chat: entry.name, kind, new: fresh.length, note: rel, quarantined });
    if (!files.includes(rel)) files.push(rel);
  }
  return { report, files, root };
}

/** The moment of a run as local time with its offset, the way the reference wrote `last_run`. */
function localStamp(date, timeZone) {
  const format = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = {};
  for (const { type, value } of format.formatToParts(date)) parts[type] = value;
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const ms = ((date.getTime() % 1000) + 1000) % 1000;
  const offset = Math.round((wall - (date.getTime() - ms)) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const two = (value) => String(Math.abs(value)).padStart(2, "0");
  const fraction = ms ? `.${String(ms).padStart(3, "0")}000` : "";
  return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${sign}${two(Math.trunc(offset / 60))}:${two(offset % 60)}`;
}

function samePath(a, b) {
  return Boolean(a) && Boolean(b) && resolve(a) === resolve(b);
}

async function runExport({
  storePath,
  vault,
  folder = DEFAULT_FOLDER,
  statePath,
  aliasesPath,
  seedStatePath,
  seedAliasesPath,
  senderAliasesPath,
  ownName = "Santiago",
  timeZone = "America/Monterrey",
  backfillDays = 90,
  now = () => new Date(),
  dryRun = false,
  sqlite = createSqlite(),
  snapshotAttempts = 4,
  retryBaseMs = 3000,
  pageSize = 2000,
} = {}) {
  if (!storePath) throw new Error("The path of the WhatsApp store is missing.");
  if (!vault || !isAbsolute(vault)) throw new Error("The vault must be an absolute path.");
  if (!existsSync(vault) || !statSync(vault).isDirectory()) throw new Error(`The vault was not found at ${vault}.`);
  if (!statePath || !aliasesPath) throw new Error("The paths of the exporter's state and aliases files are missing.");
  if (samePath(statePath, seedStatePath) || samePath(aliasesPath, seedAliasesPath)) {
    throw new Error("The exporter's own files cannot be the reference files: those are only read.");
  }
  const cleanFolder = validateFolder(folder);
  const clock = createLocalClock(timeZone);

  const ownState = await readJson(statePath, "The WhatsApp export state");
  const seedState = seedStatePath ? await readJson(seedStatePath, "The reference WhatsApp state") : undefined;
  const { top, chats: stateChats } = mergeSeedState(ownState, seedState);
  const ownAliases = await readJson(aliasesPath, "The WhatsApp identities file");
  const seedAliases = seedAliasesPath ? await readJson(seedAliasesPath, "The reference WhatsApp identities file") : undefined;
  const aliases = mergeSeedAliases(ownAliases, seedAliases);
  // The map of sender names is hand-written and only changes a label, so a broken one is ignored, as the reference did.
  const senderAliases = senderAliasesPath ? await readJson(senderAliasesPath, "The sender names file").catch(() => undefined) : undefined;

  const { dir } = await snapshotStore({ sqlite, storePath, attempts: snapshotAttempts, retryBaseMs });
  let pulled;
  try {
    pulled = await pullStore({ sqlite, dir, pageSize, stateChats, aliases, ownName, backfillDays, nowMs: now().getTime() });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const savedAliases = isRecord(ownAliases?.aliases) ? ownAliases.aliases : {};
  const aliasesChanged = aliases.size !== Object.keys(savedAliases).length || [...aliases].some(([jid, canonical]) => savedAliases[jid] !== canonical);
  if (!dryRun && aliasesChanged) {
    await writeJson(aliasesPath, {
      comment: "Chat id in the WhatsApp store to the id its note in the vault already uses. Written by the SMCP exporter.",
      updated: isoUtc(Math.floor(now().getTime() / 1000)),
      aliases: Object.fromEntries(aliases),
    });
  }

  const saveState = (lastRun) => writeJson(statePath, { ...top, last_run: lastRun, chats: Object.fromEntries(stateChats) });
  let written;
  try {
    written = await writeNotes({
      payloadChats: pulled.chats,
      stateChats,
      vault,
      folder: cleanFolder,
      senderAliases: isRecord(senderAliases) ? senderAliases : {},
      ownName,
      clock,
      dryRun,
    });
  } catch (error) {
    // Some notes may already be written. Their watermarks are saved so the next run does not
    // lean only on the lines at the end of each note; `last_run` stays, the run did not finish.
    if (!dryRun) await saveState(top.last_run ?? null).catch(() => {});
    throw error;
  }
  const { report, files, root } = written;

  if (!dryRun) {
    // Saved on every run, also with nothing new: `last_run` is the heartbeat that says the export is alive.
    await saveState(localStamp(now(), timeZone));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, INDEX_NAME), buildIndex(stateChats, cleanFolder));
  }
  return { stats: pulled.stats, report, files, ambiguous: pulled.ambiguous, merged: pulled.merged };
}

const running = new Map();

/**
 * Exports what is new in the WhatsApp store to the vault.
 *
 * Writes notes and the index only inside `<vault>/<folder>`, and its own state and aliases to
 * `statePath` and `aliasesPath`. The seed paths and `senderAliasesPath` are only read. Throws when
 * the store cannot be read after the retries, so a failure never looks like "nothing new".
 * Two calls with the same state file run one after the other, never at once.
 *
 * @param {object} options
 * @param {string} options.storePath  The wacli database.
 * @param {string} options.vault  Absolute path of the vault.
 * @param {string} [options.folder]  Folder for the notes, relative to the vault and under raw/.
 * @param {string} options.statePath  This exporter's state file, outside the vault.
 * @param {string} options.aliasesPath  This exporter's identities file, outside the vault.
 * @param {string} [options.seedStatePath]  The reference scripts' state, read only.
 * @param {string} [options.seedAliasesPath]  The reference scripts' identities, read only.
 * @param {string} [options.senderAliasesPath]  Hand-written sender names `{ jid: name }`, read only.
 * @param {string} [options.ownName]  The name written for the owner's own messages.
 * @param {string} [options.timeZone]  IANA time zone for the days and times in the notes.
 * @param {number} [options.backfillDays]  How far back to go for a chat that was never exported.
 * @param {() => Date} [options.now]
 * @param {boolean} [options.dryRun]  Report what would be written and write nothing.
 * @param {(args: string[], options: object) => Promise<object>} [options.sqlite]  The sqlite3 tool, see createSqlite.
 * @param {number} [options.snapshotAttempts]  Tries at copying the store, 4 by default.
 * @param {number} [options.retryBaseMs]  Wait before the second try; it doubles each time.
 * @param {number} [options.pageSize]  Rows asked from the store per call.
 *
 * Returns `{ stats, report, files, ambiguous, merged }`: what the store had, what was written,
 * the notes created or appended (paths relative to the vault), the names that matched more than
 * one known chat and were left alone, and the identities joined in this run.
 */
export function exportWhatsApp(options = {}) {
  const key = resolve(String(options.statePath ?? ""));
  const turn = (running.get(key) ?? Promise.resolve()).then(() => runExport(options));
  const settled = turn.catch(() => {});
  running.set(key, settled);
  settled.then(() => {
    if (running.get(key) === settled) running.delete(key);
  });
  return turn;
}
