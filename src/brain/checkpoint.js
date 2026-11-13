// The heartbeat of each exporter. Every run is written here, including the ones that found nothing,
// so "there was nothing new" and "it did not run" never look the same. A journal next to it lists
// every file a run changed, which is what brain_inbox reads instead of sweeping folders.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brainStateDir } from "./config.js";

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;

const checkpointsPath = (dir) => join(dir, "checkpoints.json");
const journalPath = (dir) => join(dir, "journal.jsonl");
const inboxPath = (dir) => join(dir, "inbox.json");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function readCheckpoints(dir = brainStateDir()) {
  const saved = readJson(checkpointsPath(dir), {});
  return saved && typeof saved === "object" ? saved : {};
}

/**
 * Records one run of a source. `ok` runs carry what they wrote; failed ones carry why.
 * `files` are vault-relative paths that changed, each with how many items were added when known.
 */
export function recordRun(source, { ok, startedAt, finishedAt = Date.now(), summary = null, error = null, files = [] }, dir = brainStateDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const all = readCheckpoints(dir);
  const previous = all[source] ?? {};
  const at = new Date(finishedAt).toISOString();
  all[source] = {
    lastRunAt: at,
    lastStartedAt: new Date(startedAt ?? finishedAt).toISOString(),
    lastOkAt: ok ? at : (previous.lastOkAt ?? null),
    ok: Boolean(ok),
    failures: ok ? 0 : (previous.failures ?? 0) + 1,
    error: ok ? null : String(error ?? "It failed.").slice(0, MAX_ERROR_CHARS),
    summary: ok ? summary : (previous.summary ?? null),
    lastChangeAt: ok && files.length ? at : (previous.lastChangeAt ?? null),
  };
  writeJson(checkpointsPath(dir), all);
  if (ok && files.length) {
    const path = journalPath(dir);
    try {
      // The older half is kept, so the journal stays small without losing recent changes.
      if (statSync(path).size > MAX_JOURNAL_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No journal yet.
    }
    const lines = files.map((file) => JSON.stringify({ at, source, path: typeof file === "string" ? file : file.path, ...(file.added ? { added: file.added } : {}) }));
    appendFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  }
  return all[source];
}

/** How a source is doing: ok, failed, late (it should have run by now), never, or off. */
export function sourceHealth(checkpoint, { enabled, everyMinutes, now = Date.now() }) {
  if (!enabled) return "off";
  if (!checkpoint?.lastRunAt) return "never";
  if (!checkpoint.ok) return "failed";
  // Two missed turns and a margin: one slow run is not a problem, a silent source is.
  if (now - Date.parse(checkpoint.lastRunAt) > everyMinutes * 60_000 * 2 + 10 * 60_000) return "late";
  return "ok";
}

/** Journal lines after `since` (ms), oldest first. Damaged lines are skipped. */
export function readJournal({ since = 0, dir = brainStateDir() } = {}) {
  const entries = [];
  for (const path of [`${journalPath(dir)}.1`, journalPath(dir)]) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.path === "string" && Date.parse(entry.at) > since) entries.push(entry);
      } catch {
        // Skip it.
      }
    }
  }
  return entries;
}

/** Until when the raw files have been interpreted, as the AI last said. Null before the first time. */
export function readInboxMark(dir = brainStateDir()) {
  const at = readJson(inboxPath(dir), {})?.interpretedThrough;
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}

export function writeInboxMark(through, dir = brainStateDir()) {
  const time = Date.parse(through);
  if (Number.isNaN(time)) throw new Error("`through` must be a date and time, for example the `now` that brain_inbox returned.");
  if (time > Date.now() + 60_000) throw new Error("`through` cannot be in the future.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = new Date(time).toISOString();
  writeJson(inboxPath(dir), { interpretedThrough: at, markedAt: new Date().toISOString() });
  return at;
}
