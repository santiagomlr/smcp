// What is new in the vault's raw/ folder since the AI last interpreted it: an exact list from the
// exporters' journal, plus anything else that changed there, and how each source is doing.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readCheckpoints, readInboxMark, readJournal, sourceHealth } from "./checkpoint.js";
import { brainStateDir, readBrainConfig } from "./config.js";

const MAX_WALK = 50_000;
const MAX_OTHER = 300;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Files under raw/ modified after `since`, skipping hidden folders. Bounded, so a huge vault cannot stall it. */
export function changedRawFiles(vault, since, { skip = new Set(), max = MAX_OTHER } = {}) {
  const found = [];
  const pending = ["raw"];
  let seen = 0;
  let complete = true;
  while (pending.length) {
    const relative = pending.pop();
    let entries;
    try {
      entries = readdirSync(join(vault, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      seen += 1;
      if (seen > MAX_WALK) {
        complete = false;
        break;
      }
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && !skip.has(path)) {
        try {
          const modified = statSync(join(vault, path)).mtimeMs;
          if (modified > since) found.push({ path, modified: new Date(modified).toISOString() });
        } catch {
          // It disappeared between listing and reading.
        }
      }
    }
    if (!complete) break;
  }
  found.sort((a, b) => b.modified.localeCompare(a.modified));
  return { files: found.slice(0, max), complete: complete && found.length <= max };
}

/** One line per source, so a silent source cannot pass for one with no news. */
export function describeSources(config, checkpoints, now = Date.now()) {
  const describe = (id, enabled, everyMinutes, extra) => {
    const checkpoint = checkpoints[id] ?? null;
    return {
      source: id,
      ...extra,
      status: sourceHealth(checkpoint, { enabled, everyMinutes, now }),
      every_minutes: everyMinutes,
      last_run: checkpoint?.lastRunAt ?? null,
      last_ok: checkpoint?.lastOkAt ?? null,
      last_change: checkpoint?.lastChangeAt ?? null,
      ...(checkpoint && !checkpoint.ok ? { error: checkpoint.error, failures_in_a_row: checkpoint.failures } : {}),
      ...(checkpoint?.summary ? { last_result: checkpoint.summary } : {}),
    };
  };
  const ready = Boolean(config.vault);
  return [
    describe("whatsapp", ready && config.whatsapp.enabled, config.whatsapp.everyMinutes, { folder: config.whatsapp.folder }),
    ...Object.entries(config.gmail.accounts).map(([email, entry]) =>
      describe(`gmail:${email}`, ready && config.gmail.enabled, config.gmail.everyMinutes, { folder: entry.folder, account: email }),
    ),
  ];
}

export function brainInbox({ config = readBrainConfig(), dir = brainStateDir(), now = Date.now(), since } = {}) {
  if (!config.vault) {
    throw new Error("No vault is chosen for the raw exports yet. The person can choose it in SMCP, under Settings > Brain.");
  }
  const mark = since ?? readInboxMark(dir);
  const from = mark ? Date.parse(mark) : now - WEEK_MS;
  const byPath = new Map();
  for (const entry of readJournal({ since: from, dir })) {
    const item = byPath.get(entry.path) ?? { path: entry.path, source: entry.source, runs: 0, added: 0, last_change: entry.at };
    item.runs += 1;
    item.added += Number(entry.added) || 0;
    item.last_change = entry.at;
    byPath.set(entry.path, item);
  }
  const changed = [...byPath.values()].sort((a, b) => b.last_change.localeCompare(a.last_change));
  const other = changedRawFiles(config.vault, from, { skip: new Set(byPath.keys()) });
  const sources = describeSources(config, readCheckpoints(dir), now);
  const troubled = sources.filter((source) => ["failed", "late", "never"].includes(source.status));
  return {
    vault: config.vault,
    now: new Date(now).toISOString(),
    interpreted_through: mark,
    ...(mark ? {} : { note_first_time: "Nothing has been marked as interpreted yet, so this lists the last 7 days." }),
    sources,
    ...(troubled.length
      ? { warning: `These sources are not up to date: ${troubled.map((source) => `${source.source} (${source.status})`).join(", ")}. Missing files there mean the export did not run, not that nothing happened.` }
      : {}),
    changed,
    other_changed: other.files,
    ...(other.complete ? {} : { other_changed_incomplete: true }),
    next: "Read each changed file with notes_read or file_read. When you have interpreted them, call brain_inbox_mark with this `now` so the next call starts from here.",
  };
}
