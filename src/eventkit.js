// Calendar and Reminders through EventKit, which already merges every account and expands repeats.
// macOS ties the permission to the app that asks, so only SMCP.app runs these.
import { runJxa, WAIT_FOR } from "./jxa.js";

export const EVENTS = 0;
export const REMINDERS = 1;
const MAX_EVENTS = 2000;
const MAX_NOTES_CHARS = 1000;
/** One event read on its own returns its whole notes, so a marker at the end is never cut off. */
const MAX_EVENT_NOTES_CHARS = 5000;
/** EKSpan: this event only, or this one and the ones after it. */
export const SPAN_THIS = 0;
export const SPAN_FUTURE = 1;

const PRELUDE = `
ObjC.import("Foundation");
ObjC.import("EventKit");
const FULL_ACCESS = 3;
${WAIT_FOR}
const status = (type) => Number($.EKEventStore.authorizationStatusForEntityType(type));
function request(type) {
  const store = $.EKEventStore.alloc.init;
  let finished = false;
  const done = () => { finished = true; };
  if (type === 0) store.requestFullAccessToEventsWithCompletion(done);
  else store.requestFullAccessToRemindersWithCompletion(done);
  waitFor(() => finished, 60);
  return status(type);
}
/** Asks the first time; afterwards macOS remembers the answer and never asks again. */
function open(type) {
  const current = status(type) === 0 ? request(type) : status(type);
  if (current !== FULL_ACCESS) throw new Error("NO_ACCESS:" + current);
  return $.EKEventStore.alloc.init;
}
const str = (value) => (value && !value.isNil() ? value.js : "");
const ms = (date) => (date && !date.isNil() ? Number(date.timeIntervalSince1970) * 1000 : null);
const nsDate = (value) => $.NSDate.dateWithTimeIntervalSince1970(value / 1000);
function calendarsFor(store, type, ids) {
  const all = store.calendarsForEntityType(type);
  const out = [];
  for (let i = 0; i < all.count; i++) {
    const c = all.objectAtIndex(i);
    if (!ids || !ids.length || ids.includes(str(c.calendarIdentifier))) out.push(c);
  }
  return out;
}
function describeCalendar(c) {
  return { id: str(c.calendarIdentifier), title: str(c.title), account: str(c.source.title), writable: Boolean(c.allowsContentModifications) };
}
function pick(store, type, id) {
  if (!id) return type === 0 ? store.defaultCalendarForNewEvents : store.defaultCalendarForNewReminders;
  const found = calendarsFor(store, type, [id]);
  if (!found.length) throw new Error("NO_CALENDAR");
  return found[0];
}
function save(fn) {
  const error = Ref();
  if (!fn(error)) throw new Error("SAVE_FAILED:" + (error[0] && !error[0].isNil() ? error[0].localizedDescription.js : ""));
}
function describeEvent(e, notesChars) {
  return {
    id: str(e.eventIdentifier),
    title: str(e.title),
    calendar: str(e.calendar.title),
    calendarId: str(e.calendar.calendarIdentifier),
    start: ms(e.startDate),
    end: ms(e.endDate),
    allDay: Boolean(e.allDay),
    location: str(e.location),
    notes: str(e.notes).slice(0, notesChars),
    recurring: Boolean(e.hasRecurrenceRules),
  };
}
// Every repeat of an event shares one id, and asking by id alone returns the first of them.
// With "at" (the start of one repeat) the search returns exactly that one.
function findEvent(store, id, at) {
  if (typeof at === "number") {
    const found = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(nsDate(at - 1000), nsDate(at + 86400000), $()));
    for (let i = 0; found && !found.isNil() && i < found.count; i++) {
      const e = found.objectAtIndex(i);
      if (str(e.eventIdentifier) === id && Math.abs(ms(e.startDate) - at) < 1000) return e;
    }
    throw new Error("NO_OCCURRENCE");
  }
  const e = store.eventWithIdentifier(id);
  if (!e || e.isNil()) throw new Error("NO_EVENT");
  return e;
}
function findReminder(store, id) {
  const r = store.calendarItemWithIdentifier(id);
  if (!r || r.isNil() || !r.isKindOfClass($.EKReminder)) throw new Error("NO_REMINDER");
  return r;
}
function describeReminder(r, notesChars) {
  const parts = r.dueDateComponents;
  const due = parts && !parts.isNil() ? $.NSCalendar.currentCalendar.dateFromComponents(parts) : null;
  return {
    id: str(r.calendarItemIdentifier),
    title: str(r.title),
    list: str(r.calendar.title),
    completed: Boolean(r.completed),
    due: ms(due),
    dueHasTime: Boolean(parts && !parts.isNil() && Number(parts.hour) >= 0 && Number(parts.hour) < 24),
    priority: Number(r.priority),
    notes: str(r.notes).slice(0, notesChars),
  };
}
/** Year, month and day; with a time, hour and minute too. */
function dueComponents(due, hasTime) {
  return $.NSCalendar.currentCalendar.componentsFromDate(hasTime ? 4 | 8 | 16 | 32 | 64 : 4 | 8 | 16, nsDate(due));
}
`;

const SCRIPTS = {
  status: `function main(a) { return { status: status(a.type) }; }`,
  request: `function main(a) { return { status: request(a.type) }; }`,
  calendars: `
function main(a) {
  const store = open(a.type);
  return calendarsFor(store, a.type).map(describeCalendar);
}`,
  defaultCalendar: `
function main(a) {
  const store = open(a.type);
  const c = a.type === 0 ? store.defaultCalendarForNewEvents : store.defaultCalendarForNewReminders;
  if (!c || c.isNil()) throw new Error("NO_DEFAULT");
  return describeCalendar(c);
}`,
  events: `
function main(a) {
  if (a.passive && status(0) !== FULL_ACCESS) return { status: status(0), events: [] };
  const store = open(0);
  const calendars = a.calendars && a.calendars.length ? $(calendarsFor(store, 0, a.calendars)) : $();
  const found = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(nsDate(a.from), nsDate(a.to), calendars));
  const wanted = typeof a.notesContains === "string" ? a.notesContains : "";
  const events = [];
  for (let i = 0; found && !found.isNil() && i < found.count && events.length < a.max; i++) {
    const e = found.objectAtIndex(i);
    // The whole notes are searched, not just the part that is returned.
    if (wanted && str(e.notes).indexOf(wanted) < 0) continue;
    events.push(describeEvent(e, a.notesChars));
  }
  return { status: status(0), events };
}`,
  getEvent: `
function main(a) {
  const store = open(0);
  return describeEvent(findEvent(store, a.id, a.occurrence), a.notesChars);
}`,
  createEvent: `
function main(a) {
  const store = open(0);
  const e = $.EKEvent.eventWithEventStore(store);
  e.setTitle($(a.title));
  e.setStartDate(nsDate(a.start));
  e.setEndDate(nsDate(a.end));
  e.setAllDay(Boolean(a.allDay));
  if (a.location) e.setLocation($(a.location));
  if (a.notes) e.setNotes($(a.notes));
  e.setCalendar(pick(store, 0, a.calendar));
  save((error) => store.saveEventSpanCommitError(e, 0, true, error));
  return { id: str(e.eventIdentifier), calendar: str(e.calendar.title) };
}`,
  updateEvent: `
function main(a) {
  const store = open(0);
  const e = findEvent(store, a.id, a.occurrence);
  if (typeof a.title === "string") e.setTitle($(a.title));
  if (typeof a.allDay === "boolean") e.setAllDay(a.allDay);
  if (typeof a.start === "number") e.setStartDate(nsDate(a.start));
  if (typeof a.end === "number") e.setEndDate(nsDate(a.end));
  // An empty text clears the field.
  if (typeof a.location === "string") e.setLocation($(a.location));
  if (typeof a.notes === "string") e.setNotes($(a.notes));
  if (a.calendar) e.setCalendar(pick(store, 0, a.calendar));
  save((error) => store.saveEventSpanCommitError(e, a.span === 1 ? 1 : 0, true, error));
  return describeEvent(e, a.notesChars);
}`,
  deleteEvent: `
function main(a) {
  const store = open(0);
  const e = findEvent(store, a.id, a.occurrence);
  const title = str(e.title);
  save((error) => store.removeEventSpanCommitError(e, a.span === 1 ? 1 : 0, true, error));
  return { deleted: true, id: a.id, title };
}`,
  reminders: `
function main(a) {
  const store = open(1);
  const lists = a.lists && a.lists.length ? $(calendarsFor(store, 1, a.lists)) : $();
  const predicate = a.includeCompleted
    ? store.predicateForRemindersInCalendars(lists)
    : store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars($(), $(), lists);
  let finished = false;
  const out = [];
  store.fetchRemindersMatchingPredicateCompletion(predicate, (found) => {
    for (let i = 0; found && !found.isNil() && i < found.count; i++) out.push(describeReminder(found.objectAtIndex(i), a.notesChars));
    finished = true;
  });
  waitFor(() => finished, 30);
  return out;
}`,
  createReminder: `
function main(a) {
  const store = open(1);
  const r = $.EKReminder.reminderWithEventStore(store);
  r.setTitle($(a.title));
  r.setCalendar(pick(store, 1, a.list));
  if (a.notes) r.setNotes($(a.notes));
  if (a.due !== null) r.setDueDateComponents(dueComponents(a.due, a.dueHasTime));
  save((error) => store.saveReminderCommitError(r, true, error));
  return { id: str(r.calendarItemIdentifier), list: str(r.calendar.title) };
}`,
  updateReminder: `
function main(a) {
  const store = open(1);
  const r = findReminder(store, a.id);
  if (typeof a.title === "string") r.setTitle($(a.title));
  if (typeof a.notes === "string") r.setNotes($(a.notes));
  if (a.list) r.setCalendar(pick(store, 1, a.list));
  // null takes the due date away; leaving it out keeps it.
  if (a.due === null) r.setDueDateComponents($());
  else if (typeof a.due === "number") r.setDueDateComponents(dueComponents(a.due, a.dueHasTime));
  if (typeof a.completed === "boolean") r.setCompleted(a.completed);
  save((error) => store.saveReminderCommitError(r, true, error));
  return describeReminder(r, a.notesChars);
}`,
  completeReminder: `
function main(a) {
  const store = open(1);
  const r = findReminder(store, a.id);
  r.setCompleted(true);
  save((error) => store.saveReminderCommitError(r, true, error));
  return { completed: true, id: a.id, title: str(r.title) };
}`,
  deleteReminder: `
function main(a) {
  const store = open(1);
  const r = findReminder(store, a.id);
  const title = str(r.title);
  save((error) => store.removeReminderCommitError(r, true, error));
  return { deleted: true, id: a.id, title };
}`,
};

const ACCESS = { 0: "ask", 1: "restricted", 2: "denied", 3: "granted", 4: "writeOnly" };
export const describeAccess = (code) => ACCESS[code] ?? "ask";

const CODES = ["NO_ACCESS", "NO_CALENDAR", "NO_DEFAULT", "NO_EVENT", "NO_OCCURRENCE", "NO_REMINDER", "SAVE_FAILED"];

/** The script's short code, so callers can tell "it is gone" from "it failed" without reading the sentence. */
export function eventKitErrorCode(error) {
  const message = String(error?.message ?? "");
  return CODES.find((code) => message.includes(code)) ?? null;
}

/** Turns the script's short codes into sentences a person can act on. */
export function friendlyEventKitError(error, type = EVENTS) {
  const what = type === EVENTS ? "Calendar" : "Reminders";
  const message = String(error?.message ?? "");
  if (/NO_ACCESS/.test(message)) {
    return `SMCP cannot use your ${what}. Allow it in System Settings > Privacy & Security > ${what}, and turn on SMCP.`;
  }
  if (/NO_CALENDAR/.test(message)) return type === EVENTS ? "No calendar has that id. Use calendar_list_calendars." : "No list has that id. Use reminders_list_lists.";
  if (/NO_DEFAULT/.test(message)) return type === EVENTS ? "This Mac has no default calendar. Pass `calendar`, from calendar_list_calendars." : "This Mac has no default list. Pass `list`, from reminders_list_lists.";
  if (/NO_EVENT/.test(message)) return "That event no longer exists.";
  if (/NO_OCCURRENCE/.test(message)) return "That event has no repeat starting then. Use the id and start that calendar_list_events shows.";
  if (/NO_REMINDER/.test(message)) return "That reminder no longer exists.";
  if (/SAVE_FAILED/.test(message)) return `${what} did not save the change: ${message.split("SAVE_FAILED:")[1] || "unknown reason"}.`;
  return `Could not read this Mac's ${what}.`;
}

/** Dependencies are injectable so tests never touch a real calendar. */
export function createEventKit({ jxa = runJxa } = {}) {
  const call = async (name, params, type, timeoutMs = 30_000) => {
    try {
      return await jxa(PRELUDE, SCRIPTS[name], params, { timeoutMs, failure: "" });
    } catch (error) {
      const friendly = new Error(friendlyEventKitError(error, type));
      friendly.code = eventKitErrorCode(error);
      throw friendly;
    }
  };
  const given = (values) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  /** `occurrence` is the start of one repeat of a repeating event; without it, the first one. */
  const target = ({ id, occurrence }) => ({ id: String(id ?? ""), ...(Number.isFinite(occurrence) ? { occurrence: Number(occurrence) } : {}) });

  return {
    status: async (type = EVENTS) => describeAccess((await call("status", { type }, type)).status),
    request: async (type = EVENTS) => describeAccess((await call("request", { type }, type, 70_000)).status),
    calendars: (type = EVENTS) => call("calendars", { type }, type, 70_000),

    /** The calendar or list macOS uses when none is named. */
    defaultCalendar: (type = EVENTS) => call("defaultCalendar", { type }, type, 70_000),

    /**
     * `passive` reads only if access was already granted, so the Tasks window never triggers a prompt.
     * `notesContains` keeps only events whose notes hold that exact text, filtered inside the script.
     */
    async events({ from, to, calendars = [], passive = false, notesContains }) {
      const result = await call(
        "events",
        { from: Number(from), to: Number(to), calendars, passive, max: MAX_EVENTS, notesChars: MAX_NOTES_CHARS, ...(notesContains ? { notesContains: String(notesContains) } : {}) },
        EVENTS,
        70_000,
      );
      return { status: describeAccess(result.status), events: result.events };
    },

    getEvent: (event) => call("getEvent", { ...target(event), notesChars: MAX_EVENT_NOTES_CHARS }, EVENTS, 70_000),
    createEvent: (event) => call("createEvent", event, EVENTS, 70_000),
    /** Only the fields given change. Empty `location` or `notes` clear them; `calendar` moves the event. */
    updateEvent: ({ id, occurrence, title, start, end, allDay, location, notes, calendar, span = SPAN_THIS }) =>
      call(
        "updateEvent",
        { ...target({ id, occurrence }), ...given({ title, start, end, allDay, location, notes, calendar }), span: span === SPAN_FUTURE ? SPAN_FUTURE : SPAN_THIS, notesChars: MAX_EVENT_NOTES_CHARS },
        EVENTS,
        70_000,
      ),
    deleteEvent: ({ id, occurrence, span = SPAN_THIS }) =>
      call("deleteEvent", { ...target({ id, occurrence }), span: span === SPAN_FUTURE ? SPAN_FUTURE : SPAN_THIS }, EVENTS, 70_000),
    reminders: ({ lists = [], includeCompleted = false }) =>
      call("reminders", { lists, includeCompleted, notesChars: MAX_NOTES_CHARS }, REMINDERS, 70_000),
    createReminder: (reminder) => call("createReminder", reminder, REMINDERS, 70_000),
    /** Only the fields given change. `due: null` takes the due date away; `completed: false` re-opens it. */
    updateReminder: ({ id, title, notes, due, dueHasTime, list, completed }) =>
      call(
        "updateReminder",
        { id: String(id ?? ""), ...given({ title, notes, due, list, completed }), dueHasTime: dueHasTime === true, notesChars: MAX_NOTES_CHARS },
        REMINDERS,
        70_000,
      ),
    completeReminder: ({ id }) => call("completeReminder", { id }, REMINDERS, 70_000),
    deleteReminder: ({ id }) => call("deleteReminder", { id: String(id ?? "") }, REMINDERS, 70_000),
  };
}
