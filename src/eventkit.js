// Calendar and Reminders through EventKit, which already merges every account and expands repeats.
// macOS ties the permission to the app that asks, so only SMCP.app runs these.
import { runJxa, WAIT_FOR } from "./jxa.js";

export const EVENTS = 0;
export const REMINDERS = 1;
const MAX_EVENTS = 2000;
const MAX_NOTES_CHARS = 1000;

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
`;

const SCRIPTS = {
  status: `function main(a) { return { status: status(a.type) }; }`,
  request: `function main(a) { return { status: request(a.type) }; }`,
  calendars: `
function main(a) {
  const store = open(a.type);
  return calendarsFor(store, a.type).map(describeCalendar);
}`,
  events: `
function main(a) {
  if (a.passive && status(0) !== FULL_ACCESS) return { status: status(0), events: [] };
  const store = open(0);
  const calendars = a.calendars && a.calendars.length ? $(calendarsFor(store, 0, a.calendars)) : $();
  const found = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(nsDate(a.from), nsDate(a.to), calendars));
  const events = [];
  for (let i = 0; i < found.count && events.length < a.max; i++) {
    const e = found.objectAtIndex(i);
    events.push({
      id: str(e.eventIdentifier),
      title: str(e.title),
      calendar: str(e.calendar.title),
      start: ms(e.startDate),
      end: ms(e.endDate),
      allDay: Boolean(e.allDay),
      location: str(e.location),
      notes: str(e.notes).slice(0, a.notesChars),
    });
  }
  return { status: status(0), events };
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
    for (let i = 0; found && !found.isNil() && i < found.count; i++) {
      const r = found.objectAtIndex(i);
      const parts = r.dueDateComponents;
      const due = parts && !parts.isNil() ? $.NSCalendar.currentCalendar.dateFromComponents(parts) : null;
      out.push({
        id: str(r.calendarItemIdentifier),
        title: str(r.title),
        list: str(r.calendar.title),
        completed: Boolean(r.completed),
        due: ms(due),
        dueHasTime: Boolean(parts && !parts.isNil() && Number(parts.hour) >= 0 && Number(parts.hour) < 24),
        priority: Number(r.priority),
        notes: str(r.notes).slice(0, a.notesChars),
      });
    }
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
  if (a.due !== null) {
    // Year, month and day; with a time, hour and minute too.
    const units = a.dueHasTime ? 4 | 8 | 16 | 32 | 64 : 4 | 8 | 16;
    r.setDueDateComponents($.NSCalendar.currentCalendar.componentsFromDate(units, nsDate(a.due)));
  }
  save((error) => store.saveReminderCommitError(r, true, error));
  return { id: str(r.calendarItemIdentifier), list: str(r.calendar.title) };
}`,
  completeReminder: `
function main(a) {
  const store = open(1);
  const r = store.calendarItemWithIdentifier(a.id);
  if (!r || r.isNil() || !r.isKindOfClass($.EKReminder)) throw new Error("NO_REMINDER");
  r.setCompleted(true);
  save((error) => store.saveReminderCommitError(r, true, error));
  return { completed: true, id: a.id, title: str(r.title) };
}`,
};

const ACCESS = { 0: "ask", 1: "restricted", 2: "denied", 3: "granted", 4: "writeOnly" };
export const describeAccess = (code) => ACCESS[code] ?? "ask";

/** Turns the script's short codes into sentences a person can act on. */
export function friendlyEventKitError(error, type = EVENTS) {
  const what = type === EVENTS ? "Calendar" : "Reminders";
  const message = String(error?.message ?? "");
  if (/NO_ACCESS/.test(message)) {
    return `SMCP cannot use your ${what}. Allow it in System Settings > Privacy & Security > ${what}, and turn on SMCP.`;
  }
  if (/NO_CALENDAR/.test(message)) return type === EVENTS ? "No calendar has that id. Use calendar_list_calendars." : "No list has that id. Use reminders_list_lists.";
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
      throw new Error(friendlyEventKitError(error, type));
    }
  };

  return {
    status: async (type = EVENTS) => describeAccess((await call("status", { type }, type)).status),
    request: async (type = EVENTS) => describeAccess((await call("request", { type }, type, 70_000)).status),
    calendars: (type = EVENTS) => call("calendars", { type }, type, 70_000),

    /** `passive` reads only if access was already granted, so the Tasks window never triggers a prompt. */
    async events({ from, to, calendars = [], passive = false }) {
      const result = await call(
        "events",
        { from: Number(from), to: Number(to), calendars, passive, max: MAX_EVENTS, notesChars: MAX_NOTES_CHARS },
        EVENTS,
        70_000,
      );
      return { status: describeAccess(result.status), events: result.events };
    },

    createEvent: (event) => call("createEvent", event, EVENTS, 70_000),
    reminders: ({ lists = [], includeCompleted = false }) =>
      call("reminders", { lists, includeCompleted, notesChars: MAX_NOTES_CHARS }, REMINDERS, 70_000),
    createReminder: (reminder) => call("createReminder", reminder, REMINDERS, 70_000),
    completeReminder: ({ id }) => call("completeReminder", { id }, REMINDERS, 70_000),
  };
}
