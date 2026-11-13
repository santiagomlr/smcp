// The calendar and reminders actions the MCP server may ask SMCP.app to run.
//
// Writing to a calendar normally opens the confirmation window. The exception is a calendar the
// person picked in Settings for unattended writing: there SMCP adds, changes and deletes events by
// itself. In exchange, every event it adds says in its notes where the plan came from, the same
// request never adds a second event, and every action is kept in a history that allows undoing it.
// Has no Electron imports so the tests can drive it with fakes.
import { createHash } from "node:crypto";
import { EVENTS, REMINDERS, SPAN_FUTURE, SPAN_THIS } from "../../src/eventkit.js";
import { formatDay, formatLocal } from "../../src/tools/calendar.js";
import { fold } from "../../src/util.js";
import { createAutoRegistry } from "./calendar-registry.js";

export { createAutoRegistry };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_CONFLICTS = 20;
const MAX_CALLER_NOTES = 2000;
/** Less than what reading one event returns (5000 characters), so the marker at the end always comes back. */
const MAX_SAVED_NOTES = 4000;
const MAX_READ_NOTES = 5000;
const MAX_CHANGE_LINES = 3;
const HEADER = "— SMCP —";
const MARKER_LINE = /^\[(smcp:[0-9a-f]{12})\]$/;
const BLOCK_LINE = /^(Source: |Changed: |")/;

export const NOT_CONFIRMED = "Not confirmed. Nothing was changed.";
export const SOURCE_NEEDED =
  "Events written without the confirmation window need `source`: where the plan was confirmed (kind, ref, date and a short quote).";

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(0, 50) : []);
const oneLine = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const sameTime = (a, b) => Math.abs(a - b) < 1000;
const clock = (time) => formatLocal(time).replace("T", " ").slice(0, 16);

/** Text from outside must never read as SMCP's own block, or one event could pass for another. */
const defuse = (value) => value.replace(/\[smcp:/gi, "[smcp ").replace(/^[ \t]*— SMCP —[ \t]*$/gm, "- SMCP -");

/** Where a plan was confirmed: `kind` is required; the rest is optional and always one short line each. */
export function cleanSource(value) {
  if (!value || typeof value !== "object") return null;
  const kind = defuse(oneLine(value.kind, 40));
  if (!kind) return null;
  const source = { kind };
  for (const [name, max] of [["ref", 200], ["date", 40], ["quote", 300]]) {
    const part = defuse(oneLine(value[name], max));
    if (part) source[name] = part;
  }
  return source;
}

const describeSource = (source) => [source.kind, source.ref, source.date].filter(Boolean).join(" · ");

/**
 * The same plan always gets the same marker, which is how a second request finds the first event.
 * With `key` (a message id, for example) the marker follows the key; without it, it follows the
 * calendar, the title without accents or case, and the exact start and end.
 */
export function markerFor({ key, calendarId, title, start, end }) {
  const basis = key ? `key\n${key}` : ["event", calendarId, fold(title).replace(/\s+/g, " ").trim(), start, end].join("\n");
  return `smcp:${createHash("sha256").update(basis).digest("hex").slice(0, 12)}`;
}

/** The lines SMCP adds under the notes of an event it wrote by itself. The marker is always last. */
export function provenanceBlock(source, marker) {
  return [HEADER, `Source: ${describeSource(source)}`, ...(source.quote ? [`"${source.quote}"`] : []), `[${marker}]`];
}

/**
 * Splits an event's notes into what a person wrote and SMCP's block. Tolerant of edits made in
 * Calendar: text typed after the block stays with the notes, and a marker whose header was removed
 * still counts.
 */
export function splitNotes(notes) {
  const lines = String(notes ?? "").replace(/\r\n/g, "\n").split("\n");
  const isMarker = (line) => MARKER_LINE.test(line.trim());
  let from = lines.findLastIndex((line) => line.trim() === HEADER);
  let to = from;
  if (from >= 0) {
    for (let i = from + 1; i < lines.length && (BLOCK_LINE.test(lines[i].trim()) || isMarker(lines[i])); i++) {
      to = i;
      if (isMarker(lines[i])) break;
    }
  } else {
    from = to = lines.findIndex(isMarker);
  }
  if (from < 0) return { body: lines.join("\n").trim(), block: [], marker: null };
  const block = lines.slice(from, to + 1).map((line) => line.trim());
  const marker = MARKER_LINE.exec(block.at(-1))?.[1] ?? null;
  const around = [lines.slice(0, from), lines.slice(to + 1)].map((part) => part.join("\n").trim());
  return { body: around.filter(Boolean).join("\n\n"), block, marker };
}

function joinNotes(body, block) {
  const tail = block.join("\n");
  return body && tail ? `${body}\n\n${tail}` : body || tail;
}

/** Notes the caller sent, cut so that SMCP's block always fits after them. */
function capNotes(body, block) {
  const room = MAX_SAVED_NOTES - block.join("\n").length - 2;
  return body.slice(0, Math.max(0, Math.min(MAX_CALLER_NOTES, room))).trim();
}

/** Adds a "Changed:" line above the marker and keeps only the latest few, so the block cannot grow forever. */
function withChange(block, source, at) {
  const lines = block.length ? [...block] : [HEADER];
  const marker = MARKER_LINE.test(lines.at(-1)) ? lines.pop() : null;
  lines.push(`Changed: ${formatDay(at)} · ${describeSource(source)}${source.quote ? ` · "${source.quote}"` : ""}`);
  let extra = lines.filter((line) => line.startsWith("Changed: ")).length - MAX_CHANGE_LINES;
  const kept = lines.filter((line) => !(line.startsWith("Changed: ") && extra-- > 0));
  return marker ? [...kept, marker] : kept;
}

/**
 * Builds the table of operations. `confirm` shows the person a text and resolves to whether they
 * accepted; its title and button arrive as English keys, like the body's labels pass through `tr`.
 * `autoCalendars` is read on every call, so a change in Settings applies at once.
 */
export function createCalendarOps({ eventKit, confirm, tr = (s) => s, autoCalendars = () => [], registry = createAutoRegistry(), now = Date.now }) {
  /** If the setting cannot be read, nothing is unattended: the window is the safe side. */
  const unattended = () => {
    try {
      const list = autoCalendars();
      return new Set(Array.isArray(list) ? list.filter((id) => typeof id === "string" && id) : []);
    } catch {
      return new Set();
    }
  };

  const label = (calendar) => `${calendar.title} (${calendar.account})`;
  const spanName = (span) => (span === SPAN_FUTURE ? "future" : "this");

  function whenText({ start, end, allDay }) {
    if (!allDay) return `${clock(start)} → ${clock(end)}`;
    const [first, last] = [formatDay(start), formatDay(end - 1)];
    return `${first === last ? first : `${first} → ${last}`} (${tr("all day")})`;
  }

  const repeatLines = (event, span) =>
    event.recurring ? [`${tr("Repeats")}: ${span === SPAN_FUTURE ? tr("this and future events") : tr("only this event")}`] : [];

  const remember = (entry) => registry.record({ at: new Date(now()).toISOString(), ...entry });
  const unsaved = (saved) => (saved ? {} : { history_saved: false });

  /** One unattended creation at a time, so two identical requests arriving together cannot both pass the duplicate check. */
  let queue = Promise.resolve();
  const oneAtATime = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };

  /** Timed events from every calendar that overlap the slot. They never stop a write: the caller decides what to say. */
  async function conflictsFor({ start, end, exceptId }) {
    const { events } = await eventKit.events({ from: start, to: end });
    return events
      .filter((event) => !event.allDay && event.id !== exceptId && event.start < end && event.end > start)
      .sort((a, b) => a.start - b.start)
      .slice(0, MAX_CONFLICTS)
      .map((event) => ({ id: event.id, title: event.title, calendar: event.calendar, start: event.start, end: event.end }));
  }

  /**
   * The event already written for this marker, if any. The history knows it on this computer; the
   * marker in the notes finds it when the history was lost or lives on another computer.
   */
  async function findExisting(marker, { calendarId, start, end }) {
    const known = registry.find(marker);
    if (known?.eventId) {
      try {
        return { event: await eventKit.getEvent({ id: known.eventId }), removedByHand: false };
      } catch (error) {
        if (error.code !== "NO_EVENT") throw error;
      }
    }
    const { events } = await eventKit.events({ from: start - DAY_MS, to: Math.max(start, end) + DAY_MS, calendars: [calendarId], notesContains: `[${marker}]` });
    return { event: events[0] ?? null, removedByHand: Boolean(known?.eventId) };
  }

  async function createEvent(args) {
    const title = text(args.title, 200);
    const start = Number(args.start);
    const end = Number(args.end);
    if (!title?.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(tr("The event is not valid."));
    const allDay = args.allDay === true;
    const calendars = await eventKit.calendars(EVENTS);
    const named = args.calendar ? calendars.find((item) => item.id === args.calendar) : null;
    if (args.calendar && !named) throw new Error("No calendar has that id. Use calendar_list_calendars.");
    const target = named ?? (await eventKit.defaultCalendar(EVENTS));
    if (!target.writable) throw new Error("That calendar cannot be written.");
    const auto = unattended().has(target.id);
    const checkOnly = args.checkOnly === true;
    const location = text(args.location, 300);
    const notes = text(args.notes, MAX_CALLER_NOTES);

    if (auto) {
      const source = cleanSource(args.source);
      if (!source && !checkOnly) throw new Error(SOURCE_NEEDED);
      const marker = markerFor({ key: text(args.key, 200)?.trim(), calendarId: target.id, title, start, end });
      return oneAtATime(async () => {
        const { event: existing, removedByHand } = await findExisting(marker, { calendarId: target.id, start, end });
        const conflicts = await conflictsFor({ start, end, exceptId: existing?.id });
        if (existing) return { created: false, duplicate: true, ...(checkOnly ? { check_only: true } : {}), auto, marker, event: existing, conflicts };
        if (checkOnly) return { created: false, check_only: true, auto, conflicts, ...(removedByHand ? { removed_by_person: true } : {}) };
        // SMCP added this plan before and it is gone without SMCP deleting it: the person took it out.
        // A routine that reads the same message again must not bring it back by itself.
        if (removedByHand && args.recreate !== true) {
          return {
            created: false,
            removed_by_person: true,
            auto,
            marker,
            conflicts,
            note: "This event was added before and has since been removed from the calendar by hand, so it was not added again. Pass `recreate: true` only if the person asks for it back.",
          };
        }
        const block = provenanceBlock(source, marker);
        const saved = await eventKit.createEvent({
          title,
          start,
          end,
          allDay,
          calendar: target.id,
          location,
          notes: joinNotes(capNotes(defuse(notes ?? ""), block), block),
        });
        const logged = remember({ action: "create", marker, eventId: saved.id, calendarId: target.id, calendar: target.title, title, start, end, allDay, source });
        return {
          created: true,
          auto,
          ...saved,
          calendarId: target.id,
          marker,
          conflicts,
          // The history says an earlier event for this plan existed and is gone, without SMCP deleting it.
          ...(removedByHand ? { recreated: true } : {}),
          ...unsaved(logged),
        };
      });
    }

    const conflicts = await conflictsFor({ start, end });
    if (checkOnly) return { created: false, check_only: true, auto, conflicts };
    // The window is built here from the values themselves, so nothing can word it differently.
    const lines = [
      `${tr("Event")}: ${title}`,
      `${tr("When")}: ${whenText({ start, end, allDay })}`,
      `${tr("Calendar")}: ${named ? label(named) : tr("default")}`,
      ...(location ? [`${tr("Where")}: ${location}`] : []),
      ...(notes ? ["", `${tr("Notes")}:`, notes] : []),
    ];
    if (!(await confirm(lines.join("\n"), "SMCP: add event", "Add"))) return { created: false, auto, reason: NOT_CONFIRMED, conflicts };
    return { created: true, auto, ...(await eventKit.createEvent({ title, start, end, allDay, calendar: target.id, location, notes })), calendarId: target.id, conflicts };
  }

  /** Which event, which of its repeats, and how far the change reaches. */
  function targetOf(args) {
    const id = typeof args.id === "string" ? args.id.trim().slice(0, 300) : "";
    if (!id) throw new Error("The event needs its id, from calendar_list_events.");
    const occurrence = args.occurrence === undefined || args.occurrence === null ? undefined : Number(args.occurrence);
    if (occurrence !== undefined && !Number.isFinite(occurrence)) throw new Error("Not a valid date.");
    if (args.span !== undefined && args.span !== "this" && args.span !== "future") throw new Error('`span` is "this" or "future".');
    return { id, ...(occurrence === undefined ? {} : { occurrence }), span: args.span === "future" ? SPAN_FUTURE : SPAN_THIS };
  }

  async function updateEvent(args) {
    const { id, occurrence, span } = targetOf(args);
    const given = ["title", "start", "end", "allDay", "calendar", "location", "notes"].filter((name) => args[name] !== undefined && args[name] !== null);
    if (!given.length) throw new Error("Nothing to change. Pass at least one of title, start, end, calendar, location or notes.");
    const current = await eventKit.getEvent({ id, occurrence });
    const calendars = await eventKit.calendars(EVENTS);
    const from = calendars.find((item) => item.id === current.calendarId);
    const to = args.calendar ? calendars.find((item) => item.id === args.calendar) : from;
    if (args.calendar && !to) throw new Error("No calendar has that id. Use calendar_list_calendars.");
    if (!from?.writable || !to.writable) throw new Error("That calendar cannot be written.");

    const changes = {};
    const before = {};
    const title = text(args.title, 200);
    if (title !== undefined && !title.trim()) throw new Error(tr("The event is not valid."));
    if (title !== undefined && title !== current.title) {
      changes.title = title;
      before.title = current.title;
    }

    // Moving the start alone keeps the length; turning an event into all-day, or back, gives it a usual one.
    const allDay = typeof args.allDay === "boolean" ? args.allDay : current.allDay;
    const start = given.includes("start") ? Number(args.start) : current.start;
    let end = current.end;
    if (given.includes("end")) end = Number(args.end);
    else if (allDay !== current.allDay) end = start + (allDay ? DAY_MS - 1000 : HOUR_MS);
    else if (given.includes("start")) end = start + (current.end - current.start);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(tr("The event is not valid."));
    const moved = !sameTime(start, current.start) || !sameTime(end, current.end) || allDay !== current.allDay;
    if (moved) {
      Object.assign(changes, { start, end, allDay });
      Object.assign(before, { start: current.start, end: current.end, allDay: current.allDay });
    }

    const location = text(args.location, 300);
    if (location !== undefined && location !== current.location) {
      changes.location = location;
      before.location = current.location;
    }
    if (to.id !== from.id) {
      changes.calendar = to.id;
      Object.assign(before, { calendarId: from.id, calendar: from.title });
    }

    // Moving an event out of an unattended calendar, or into any other, is the person's call.
    const allowed = unattended();
    const auto = allowed.has(from.id) && allowed.has(to.id);
    const source = cleanSource(args.source);

    // SMCP's block survives new notes; an unattended change with a source adds its own line to it.
    const split = splitNotes(current.notes);
    const wholeNotes = current.notes.length < MAX_READ_NOTES;
    const notes = text(args.notes, MAX_CALLER_NOTES);
    const newBody = notes === undefined ? undefined : defuse(notes).trim();
    const notesChanged = newBody !== undefined && newBody !== split.body;
    const anythingElse = Object.keys(changes).length > 0;
    if (!notesChanged && !anythingElse) return { updated: false, auto, reason: "The event already has those values.", event: current };
    let block = split.block;
    if (auto && source && (notesChanged || wholeNotes)) block = withChange(block, source, now());
    if (notesChanged) {
      changes.notes = joinNotes(capNotes(newBody, block), block);
    } else if (block !== split.block) {
      const rewritten = joinNotes(split.body, block);
      // Never cut notes a person wrote just to add a line.
      if (rewritten.length < MAX_READ_NOTES) changes.notes = rewritten;
    }
    if ("notes" in changes) before.notes = current.notes;

    const conflicts = moved ? await conflictsFor({ start, end, exceptId: current.id }) : null;
    const extras = { ...(conflicts ? { conflicts } : {}), ...(current.recurring ? { recurring: true, span: spanName(span) } : {}) };

    if (!auto) {
      const lines = [
        `${tr("Event")}: ${current.title}`,
        `${tr("When")}: ${whenText(current)}`,
        `${tr("Calendar")}: ${label(from)}`,
        ...repeatLines(current, span),
        "",
        `${tr("Changes")}:`,
        ...("title" in changes ? [`${tr("Event")}: ${current.title} → ${changes.title}`] : []),
        ...(moved ? [`${tr("When")}: ${whenText(current)} → ${whenText({ start, end, allDay })}`] : []),
        ...("calendar" in changes ? [`${tr("Calendar")}: ${label(from)} → ${label(to)}`] : []),
        ...("location" in changes ? [`${tr("Where")}: ${current.location || "—"} → ${changes.location || "—"}`] : []),
        ...(notesChanged ? ["", `${tr("Notes")}:`, newBody || "—"] : []),
      ];
      if (!(await confirm(lines.join("\n"), "SMCP: change event", "Change"))) return { updated: false, auto, reason: NOT_CONFIRMED, ...extras };
    }

    const updated = await eventKit.updateEvent({ id, occurrence, span, ...changes });
    if (updated.id !== current.id) before.eventId = current.id;
    // A confirmed change to an event SMCP created is kept too, so the history still knows where that event is.
    const logged =
      auto || split.marker
        ? remember({
            action: "update",
            marker: split.marker,
            eventId: updated.id,
            calendarId: updated.calendarId,
            calendar: updated.calendar,
            title: updated.title,
            start: updated.start,
            end: updated.end,
            allDay: updated.allDay,
            source,
            before,
            confirmed: !auto,
          })
        : true;
    return { updated: true, auto, event: updated, ...extras, ...unsaved(logged) };
  }

  async function deleteEvent(args) {
    const { id, occurrence, span } = targetOf(args);
    const current = await eventKit.getEvent({ id, occurrence });
    const calendar = (await eventKit.calendars(EVENTS)).find((item) => item.id === current.calendarId);
    if (!calendar?.writable) throw new Error("That calendar cannot be written.");
    const auto = unattended().has(calendar.id);
    const extras = current.recurring ? { recurring: true, span: spanName(span) } : {};
    if (!auto) {
      const lines = [
        `${tr("Event")}: ${current.title}`,
        `${tr("When")}: ${whenText(current)}`,
        `${tr("Calendar")}: ${label(calendar)}`,
        ...(current.location ? [`${tr("Where")}: ${current.location}`] : []),
        ...repeatLines(current, span),
      ];
      if (!(await confirm(lines.join("\n"), "SMCP: delete event", "Delete"))) return { deleted: false, auto, reason: NOT_CONFIRMED, ...extras };
    }
    await eventKit.deleteEvent({ id, occurrence, span });
    const { marker } = splitNotes(current.notes);
    // The whole event is kept, so it can be created again.
    const logged =
      auto || marker
        ? remember({
            action: "delete",
            marker,
            eventId: current.id,
            calendarId: current.calendarId,
            calendar: current.calendar,
            title: current.title,
            start: current.start,
            end: current.end,
            allDay: current.allDay,
            source: cleanSource(args.source),
            before: { ...current, ...(current.recurring ? { span: spanName(span) } : {}) },
            confirmed: !auto,
          })
        : true;
    return { deleted: true, auto, id: current.id, title: current.title, calendar: current.calendar, ...extras, ...unsaved(logged) };
  }

  function reminderId(args) {
    const id = typeof args.id === "string" ? args.id.trim().slice(0, 300) : "";
    if (!id) throw new Error("The reminder needs its id, from reminders_list.");
    return id;
  }

  /** null means "no due date"; a missing value means "leave it as it is". */
  function dueOf(value, { keep }) {
    if (value === undefined && keep) return undefined;
    if (value === null || value === undefined) return null;
    const due = Number(value);
    if (!Number.isFinite(due)) throw new Error("Not a valid date.");
    return due;
  }

  return {
    calendars: {
      name: "calendar_list_calendars",
      run: async () => {
        const allowed = unattended();
        return (await eventKit.calendars(EVENTS)).map((calendar) => ({ ...calendar, unattended: allowed.has(calendar.id) }));
      },
    },
    events: { name: "calendar_list_events", run: async (a) => eventKit.events({ from: a.from, to: a.to, calendars: ids(a.calendars) }) },
    createEvent: { name: "calendar_create_event", write: true, run: createEvent },
    updateEvent: { name: "calendar_update_event", write: true, run: updateEvent },
    deleteEvent: { name: "calendar_delete_event", write: true, run: deleteEvent },
    autoHistory: { name: "calendar_auto_history", run: async (a) => registry.history({ limit: a.limit, since: a.since }) },
    reminderLists: { name: "reminders_list_lists", run: async () => eventKit.calendars(REMINDERS) },
    reminders: { name: "reminders_list", run: async (a) => eventKit.reminders({ lists: ids(a.lists), includeCompleted: a.includeCompleted === true }) },
    createReminder: {
      name: "reminders_create",
      write: true,
      run: async (a) => {
        const title = text(a.title, 300);
        if (!title?.trim()) throw new Error("The reminder needs a title.");
        const due = dueOf(a.due, { keep: false });
        return eventKit.createReminder({ title, list: text(a.list, 200), notes: text(a.notes, 5000), due, dueHasTime: a.dueHasTime === true });
      },
    },
    updateReminder: {
      name: "reminders_update",
      write: true,
      run: async (a) => {
        const id = reminderId(a);
        const title = text(a.title, 300);
        if (title !== undefined && !title.trim()) throw new Error("The reminder needs a title.");
        const changes = {
          title,
          notes: text(a.notes, 5000),
          list: text(a.list, 200) || undefined,
          due: dueOf(a.due, { keep: true }),
          completed: typeof a.completed === "boolean" ? a.completed : undefined,
        };
        if (Object.values(changes).every((value) => value === undefined)) {
          throw new Error("Nothing to change. Pass at least one of title, notes, due, list or completed.");
        }
        return eventKit.updateReminder({ id, ...changes, dueHasTime: a.dueHasTime === true });
      },
    },
    completeReminder: { name: "reminders_complete", write: true, run: async (a) => eventKit.completeReminder({ id: String(a.id ?? "").slice(0, 300) }) },
    deleteReminder: { name: "reminders_delete", write: true, run: async (a) => eventKit.deleteReminder({ id: reminderId(a) }) },
  };
}
