// What SMCP wrote to the calendar without the confirmation window: one line per action, never
// rewritten. It answers two questions: "did I already create this event?" (so the same request never
// adds it twice) and "what did SMCP do while nobody was looking?" (with the values from before, so
// any of it can be undone). Calendars travel between computers through iCloud; this file does not.
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ACTIONS = new Set(["create", "update", "delete"]);
const MAX_HISTORY = 500;

export function autoRegistryPath() {
  return process.env.SMCP_CALENDAR_AUTO || join(homedir(), ".smcp", "calendar-auto.jsonl");
}

const textOrNull = (value, max) => (typeof value === "string" && value ? value.slice(0, max) : null);
const timeOrNull = (value) => (Number.isFinite(value) ? value : null);

/** Keeps only the fields a line may hold, in one order, so every line reads the same. */
function line(entry, now) {
  const at = Number.isFinite(Date.parse(entry.at)) ? new Date(Date.parse(entry.at)).toISOString() : new Date(now).toISOString();
  return {
    at,
    action: entry.action,
    marker: textOrNull(entry.marker, 40),
    eventId: textOrNull(entry.eventId, 300),
    calendarId: textOrNull(entry.calendarId, 300),
    calendar: textOrNull(entry.calendar, 300),
    title: textOrNull(entry.title, 300),
    start: timeOrNull(entry.start),
    end: timeOrNull(entry.end),
    allDay: entry.allDay === true,
    source: entry.source && typeof entry.source === "object" ? entry.source : null,
    ...(entry.before && typeof entry.before === "object" ? { before: entry.before } : {}),
    // Set when the person approved this change in the window; kept so the latest state stays right.
    ...(entry.confirmed === true ? { confirmed: true } : {}),
  };
}

export function createAutoRegistry({ path = autoRegistryPath() } = {}) {
  /** Oldest first. A damaged line is skipped, and a missing file is an empty history. */
  const read = () => {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const entries = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === "object" && ACTIONS.has(saved.action) && Number.isFinite(Date.parse(saved.at))) entries.push(saved);
      } catch {
        // Skip it.
      }
    }
    return entries;
  };

  return {
    path,

    /** Returns whether the line was saved. Never throws: the event is already written by now. */
    record(entry, now = Date.now()) {
      if (!ACTIONS.has(entry?.action)) return false;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(line(entry, now))}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
      } catch {
        return false;
      }
    },

    /** The latest state of the event with that marker, or null if it was never created or was deleted. */
    find(marker) {
      if (typeof marker !== "string" || !marker) return null;
      let latest = null;
      for (const entry of read()) if (entry.marker === marker) latest = entry;
      return latest && latest.action !== "delete" ? latest : null;
    },

    /** Newest first. `since` is a time in milliseconds or an ISO date. */
    history({ limit = 50, since } = {}) {
      const from = typeof since === "string" ? Date.parse(since) : Number(since);
      const size = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), MAX_HISTORY);
      const entries = read().filter((entry) => !Number.isFinite(from) || Date.parse(entry.at) >= from);
      return entries.reverse().slice(0, size);
    },
  };
}
