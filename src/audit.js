// The activity log: which tool ran, when, from where and how it ended. It never stores results, and it
// stores no arguments, so it holds no message text, recipients or paths. The one exception is `detail`:
// the full command of a terminal call that came from outside this computer, so the person can see
// exactly what was run while they were away.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_BYTES = 512 * 1024;
const OUTCOMES = new Set(["ok", "error", "denied", "failed", "waiting"]);
const SOURCES = new Set(["local", "remote", "peer"]);
const MAX_DETAIL_CHARS = 4000;

export function auditPath() {
  return process.env.SMCP_AUDIT || join(homedir(), ".smcp", "audit.jsonl");
}

/** Keeps only the fields the log is allowed to hold, so a caller cannot slip content into it. */
export function auditEntry({ tool, source, client, outcome, ms, detail, to }, now = Date.now()) {
  const from = SOURCES.has(source) ? source : "local";
  return {
    at: new Date(now).toISOString(),
    tool: String(tool ?? "").slice(0, 80),
    source: from,
    client: client ? String(client).slice(0, 80) : null,
    outcome: OUTCOMES.has(outcome) ? outcome : "failed",
    ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null,
    // Only what came from outside may carry a detail, so a local call can never leave its arguments here.
    ...(from !== "local" && typeof detail === "string" && detail ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}),
    // Set when the call was handed to the person's server computer instead of running here.
    ...(to === "server" ? { to } : {}),
  };
}

/** Never throws: a full disk or a damaged log must not stop a tool from answering. */
export function recordCall(call, path = auditPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      // The previous half is kept, so the log stays small without losing the most recent calls.
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${JSON.stringify(auditEntry(call))}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Logging is best effort.
  }
}

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

/**
 * Most recent first. Damaged lines are skipped. `away` keeps only what came from outside this computer
 * (the remote connector or another of the person's computers), and `since` only what is that recent.
 */
export function readAudit({ limit = 200, path = auditPath(), away = false, since = 0 } = {}) {
  const lines = [...readLines(`${path}.1`), ...readLines(path)];
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    if (!lines[i].trim()) continue;
    try {
      const saved = JSON.parse(lines[i]);
      const at = Date.parse(saved.at);
      if (at < since) break;
      const entry = auditEntry(saved, at);
      if (away && entry.source === "local") continue;
      entries.push(entry);
    } catch {
      // Skip it.
    }
  }
  return entries;
}

export function clearAudit(path = auditPath()) {
  rmSync(path, { force: true });
  rmSync(`${path}.1`, { force: true });
}
