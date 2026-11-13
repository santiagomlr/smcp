// The calendar and reminders operations SMCP.app runs, with the rules for writing without the
// confirmation window. EventKit is replaced by a small fake of the JavaScript for Automation bridge,
// so the real scripts in src/eventkit.js run here against calendars held in memory. That checks
// their logic and everything around them; it cannot check macOS itself.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { cleanSource, createAutoRegistry, createCalendarOps, markerFor, NOT_CONFIRMED, provenanceBlock, SOURCE_NEEDED, splitNotes } from "../app/core/calendar-ops.js";
import { createEventKit, eventKitErrorCode, friendlyEventKitError, REMINDERS } from "../src/eventkit.js";
import { scriptBody } from "../src/jxa.js";
import { formatLocal, presentEvent, registerCalendar } from "../src/tools/calendar.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = local(2026, 11, 13, 9, 30);
const clock = (time) => formatLocal(time).replace("T", " ").slice(0, 16);

const AUTO = { id: "cal-auto", title: "SMCP", account: "iCloud", type: 0 };
const HOME = { id: "cal-home", title: "Casa", account: "iCloud", type: 0 };
const WORK = { id: "cal-work", title: "Trabajo", account: "Google", type: 0 };
const LOCKED = { id: "cal-holidays", title: "Festivos", account: "Otros", type: 0, writable: false };
const LIST = { id: "list-1", title: "Pendientes", account: "iCloud", type: 1 };
const SOURCE = { kind: "whatsapp", ref: "Ana Prueba", date: "2026-11-13", quote: "nos vemos el jueves a las 5" };
const THURSDAY = { title: "Café con Ana", start: local(2026, 11, 19, 17), end: local(2026, 11, 19, 18) };

let dir;
let files = 0;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-calendar-"));
});
after(() => rm(dir, { recursive: true, force: true }));

/** What NSDateComponents holds for a part that was never set. */
const UNSET = 9223372036854775807;

/**
 * Calendars, events and reminders in memory behind the handful of Cocoa calls the scripts make.
 * Repeats of one event are separate records sharing an id, as EventKit hands them out.
 */
function fakeMac({ events = [], reminders = [], access = 3 } = {}) {
  const calendars = [AUTO, HOME, WORK, LOCKED, LIST];
  const state = { access, saves: [] };
  let nextId = 1;
  const nil = { isNil: () => true };
  const wrap = (value) => {
    if (value === undefined || value === null) return nil;
    if (typeof value === "string") return { js: value, isNil: () => false };
    if (Array.isArray(value)) return { count: value.length, objectAtIndex: (i) => value[i], items: value, isNil: () => false };
    return value;
  };
  const date = (time) => (time === null || time === undefined ? nil : { time, timeIntervalSince1970: time / 1000, isNil: () => false });
  const timeOf = (nsDate) => nsDate.time;
  const calendarObject = (calendar) =>
    calendar
      ? { raw: calendar, isNil: () => false, calendarIdentifier: wrap(calendar.id), title: wrap(calendar.title), source: { title: wrap(calendar.account) }, allowsContentModifications: calendar.writable !== false }
      : nil;
  const calendarOf = (id) => calendars.find((calendar) => calendar.id === id);
  const failure = (error, reason) => {
    error[0] = { isNil: () => false, localizedDescription: wrap(reason) };
    return false;
  };

  function eventObject(saved) {
    const draft = saved ? { ...saved } : { id: null, title: "", calendarId: null, start: 0, end: 0, allDay: false, location: "", notes: "", recurring: false };
    return {
      saved,
      draft,
      isNil: () => false,
      get eventIdentifier() { return wrap(draft.id); },
      get title() { return wrap(draft.title); },
      get calendar() { return calendarObject(calendarOf(draft.calendarId)); },
      get startDate() { return date(draft.start); },
      get endDate() { return date(draft.end); },
      get allDay() { return draft.allDay; },
      get location() { return wrap(draft.location || null); },
      get notes() { return wrap(draft.notes || null); },
      get hasRecurrenceRules() { return draft.recurring === true; },
      setTitle: (value) => { draft.title = value.js; },
      setStartDate: (value) => { draft.start = timeOf(value); },
      setEndDate: (value) => { draft.end = timeOf(value); },
      setAllDay: (value) => { draft.allDay = value; },
      setLocation: (value) => { draft.location = value.js; },
      setNotes: (value) => { draft.notes = value.js; },
      setCalendar: (value) => { draft.calendarId = value.isNil() ? null : value.raw.id; },
    };
  }

  const parts = (time, hasTime) => {
    const at = new Date(time);
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
    return { isNil: () => false, time: hasTime ? time : day, year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate(), hour: hasTime ? at.getHours() : UNSET, minute: hasTime ? at.getMinutes() : UNSET };
  };

  function reminderObject(saved) {
    const draft = saved ? { ...saved } : { id: null, title: "", listId: null, notes: "", due: null, dueHasTime: false, completed: false, priority: 0 };
    return {
      saved,
      draft,
      isNil: () => false,
      isKindOfClass: (kind) => kind === $.EKReminder,
      get calendarItemIdentifier() { return wrap(draft.id); },
      get title() { return wrap(draft.title); },
      get calendar() { return calendarObject(calendarOf(draft.listId)); },
      get completed() { return draft.completed; },
      get priority() { return draft.priority; },
      get notes() { return wrap(draft.notes || null); },
      get dueDateComponents() { return draft.due === null ? nil : parts(draft.due, draft.dueHasTime); },
      setTitle: (value) => { draft.title = value.js; },
      setNotes: (value) => { draft.notes = value.js; },
      setCalendar: (value) => { draft.listId = value.isNil() ? null : value.raw.id; },
      setCompleted: (value) => { draft.completed = value; },
      setDueDateComponents: (value) => {
        draft.due = value.isNil() ? null : value.time;
        draft.dueHasTime = !value.isNil() && value.hour !== UNSET;
      },
    };
  }

  const idsOf = (list) => (list.isNil() ? null : list.items.map((calendar) => calendar.raw.id));
  const plainId = (id) => (typeof id === "string" ? id : id.js);
  const store = {
    requestFullAccessToEventsWithCompletion: (done) => { state.access = 3; done(); },
    requestFullAccessToRemindersWithCompletion: (done) => { state.access = 3; done(); },
    calendarsForEntityType: (type) => wrap(calendars.filter((calendar) => calendar.type === type).map(calendarObject)),
    get defaultCalendarForNewEvents() { return calendarObject(state.noDefault ? null : HOME); },
    get defaultCalendarForNewReminders() { return calendarObject(LIST); },
    predicateForEventsWithStartDateEndDateCalendars: (from, to, list) => ({ from: timeOf(from), to: timeOf(to), ids: idsOf(list) }),
    // Like the real one, it answers nil, not an empty list, when nothing matches.
    eventsMatchingPredicate: ({ from, to, ids }) => {
      const found = events.filter((event) => event.start < to && event.end > from && (!ids || ids.includes(event.calendarId))).sort((a, b) => a.start - b.start);
      return found.length ? wrap(found.map(eventObject)) : nil;
    },
    eventWithIdentifier: (id) => {
      const [first] = events.filter((event) => event.id === plainId(id)).sort((a, b) => a.start - b.start);
      return first ? eventObject(first) : nil;
    },
    saveEventSpanCommitError: (event, span, commit, error) => {
      const calendar = calendarOf(event.draft.calendarId);
      if (!calendar) return failure(error, "No calendar has been set.");
      if (calendar.writable === false) return failure(error, "That calendar is read only.");
      if (event.draft.end <= event.draft.start) return failure(error, "The start date must be before the end date.");
      state.saves.push({ span });
      if (!event.saved) {
        event.draft.id = `event-${nextId++}`;
        event.saved = { ...event.draft };
        events.push(event.saved);
        return true;
      }
      // Moving to another account gives the event a new id, as happens between iCloud and Google.
      if (calendar.account !== calendarOf(event.saved.calendarId).account) event.draft.id = `event-${nextId++}`;
      Object.assign(event.saved, event.draft);
      return true;
    },
    removeEventSpanCommitError: (event, span) => {
      const doomed = events.filter((item) => item === event.saved || (span === 1 && item.id === event.saved.id && item.start > event.saved.start));
      for (const item of doomed) events.splice(events.indexOf(item), 1);
      return true;
    },
    calendarItemWithIdentifier: (id) => {
      const found = reminders.find((reminder) => reminder.id === plainId(id));
      if (found) return reminderObject(found);
      return events.some((event) => event.id === plainId(id)) ? { isNil: () => false, isKindOfClass: () => false } : nil;
    },
    predicateForRemindersInCalendars: (list) => ({ ids: idsOf(list), done: true }),
    predicateForIncompleteRemindersWithDueDateStartingEndingCalendars: (from, to, list) => ({ ids: idsOf(list), done: false }),
    fetchRemindersMatchingPredicateCompletion: ({ ids, done }, completion) => {
      completion(wrap(reminders.filter((reminder) => (done || !reminder.completed) && (!ids || ids.includes(reminder.listId))).map(reminderObject)));
    },
    saveReminderCommitError: (reminder, commit, error) => {
      if (!calendarOf(reminder.draft.listId)) return failure(error, "No list has been set.");
      if (!reminder.saved) {
        reminder.draft.id = `reminder-${nextId++}`;
        reminder.saved = { ...reminder.draft };
        reminders.push(reminder.saved);
      } else Object.assign(reminder.saved, reminder.draft);
      return true;
    },
    removeReminderCommitError: (reminder) => {
      reminders.splice(reminders.indexOf(reminder.saved), 1);
      return true;
    },
  };

  const $ = (value) => wrap(value);
  Object.assign($, {
    NSDate: { dateWithTimeIntervalSince1970: (seconds) => date(Math.round(seconds * 1000)), dateWithTimeIntervalSinceNow: () => date(Date.now()) },
    NSRunLoop: { currentRunLoop: { runUntilDate() {} } },
    NSCalendar: { currentCalendar: { componentsFromDate: (units, when) => parts(timeOf(when), Boolean(units & 32)), dateFromComponents: (value) => date(value.time) } },
    EKEventStore: { authorizationStatusForEntityType: () => state.access, alloc: { get init() { return store; } } },
    EKEvent: { eventWithEventStore: () => eventObject(null) },
    EKReminder: { reminderWithEventStore: () => reminderObject(null) },
  });

  /** Runs a script exactly as osascript would receive it: one source text and one JSON argument. */
  const jxa = async (prelude, script, params) => {
    const run = vm.runInNewContext(`${scriptBody(prelude, script)}\nrun;`, { ObjC: { import() {} }, $, Ref: () => [] });
    try {
      return JSON.parse(run([JSON.stringify(params)]));
    } catch (error) {
      throw new Error(error.message);
    }
  };
  return { jxa, events, reminders, state };
}

function setup({ auto = [AUTO.id], registryPath, ...mac } = {}) {
  const world = fakeMac(mac);
  const calls = [];
  const kit = createEventKit({ jxa: world.jxa });
  const eventKit = Object.fromEntries(Object.entries(kit).map(([name, fn]) => [name, (...args) => (calls.push(name), fn(...args))]));
  const asked = [];
  const answer = { value: true };
  const registry = createAutoRegistry({ path: registryPath ?? join(dir, `history-${files++}.jsonl`) });
  const settings = { auto };
  const ops = createCalendarOps({
    eventKit,
    confirm: async (body, title, button) => (asked.push({ body, title, button }), answer.value),
    autoCalendars: () => settings.auto,
    registry,
    now: () => NOW,
  });
  const run = (op, args = {}) => ops[op].run(args);
  const count = (name) => calls.filter((call) => call === name).length;
  return { ops, run, world, calls, count, asked, answer, registry, settings, kit };
}

const seed = (event) => ({ id: "seed", title: "Algo", calendarId: HOME.id, allDay: false, location: "", notes: "", recurring: false, ...event });

// The table

test("the table names the tool behind every operation and marks the ones that write", () => {
  const { ops } = setup();
  const table = Object.fromEntries(Object.entries(ops).map(([op, entry]) => [op, [entry.name, entry.write === true]]));
  assert.deepEqual(table, {
    calendars: ["calendar_list_calendars", false],
    events: ["calendar_list_events", false],
    createEvent: ["calendar_create_event", true],
    updateEvent: ["calendar_update_event", true],
    deleteEvent: ["calendar_delete_event", true],
    autoHistory: ["calendar_auto_history", false],
    reminderLists: ["reminders_list_lists", false],
    reminders: ["reminders_list", false],
    createReminder: ["reminders_create", true],
    updateReminder: ["reminders_update", true],
    completeReminder: ["reminders_complete", true],
    deleteReminder: ["reminders_delete", true],
  });
});

test("the list of calendars says which ones may be written without the window", async () => {
  const { run } = setup();
  const calendars = await run("calendars");
  assert.deepEqual(calendars.map((calendar) => [calendar.id, calendar.unattended, calendar.writable]), [
    [AUTO.id, true, true],
    [HOME.id, false, true],
    [WORK.id, false, true],
    [LOCKED.id, false, false],
  ]);
  assert.deepEqual((await run("reminderLists")).map((list) => list.id), [LIST.id]);
});

// Unattended: create

test("an unattended calendar gets the event at once, with where the plan came from and its marker", async () => {
  const { run, world, asked, registry } = setup();
  const result = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, location: "Centro", notes: "Llevar el contrato", source: SOURCE });
  assert.equal(asked.length, 0);
  assert.equal(result.created, true);
  assert.equal(result.auto, true);
  assert.match(result.marker, /^smcp:[0-9a-f]{12}$/);
  assert.equal(result.marker, markerFor({ calendarId: AUTO.id, ...THURSDAY }));
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.history_saved, undefined);

  assert.equal(world.events.length, 1);
  const [event] = world.events;
  assert.equal(event.id, result.id);
  assert.equal(event.calendarId, AUTO.id);
  assert.equal(
    event.notes,
    ["Llevar el contrato", "", "— SMCP —", "Source: whatsapp · Ana Prueba · 2026-11-13", '"nos vemos el jueves a las 5"', `[${result.marker}]`].join("\n"),
  );

  const [entry] = registry.history();
  assert.deepEqual(entry, {
    at: new Date(NOW).toISOString(),
    action: "create",
    marker: result.marker,
    eventId: event.id,
    calendarId: AUTO.id,
    calendar: "SMCP",
    title: "Café con Ana",
    start: THURSDAY.start,
    end: THURSDAY.end,
    allDay: false,
    source: SOURCE,
  });
  assert.equal(registry.find(result.marker).eventId, event.id);
});

test("the same request twice creates the event once", async () => {
  const { run, world, count, registry } = setup();
  const request = { ...THURSDAY, calendar: AUTO.id, source: SOURCE };
  const first = await run("createEvent", request);
  // Accents, case and spacing in the title do not make it another plan.
  const second = await run("createEvent", { ...request, title: "  CAFE  con ana " });
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event.id, first.id);
  assert.equal(second.marker, first.marker);
  assert.equal(count("createEvent"), 1);
  assert.equal(world.events.length, 1);
  assert.equal(registry.history().length, 1);
  // The event found is not reported as being in its own way.
  assert.deepEqual(second.conflicts, []);
});

test("two identical requests arriving together still create one event", async () => {
  const { run, world, count } = setup();
  const request = { ...THURSDAY, calendar: AUTO.id, source: SOURCE };
  const results = await Promise.all([run("createEvent", request), run("createEvent", request), run("createEvent", request)]);
  assert.deepEqual(results.map((result) => result.created), [true, false, false]);
  assert.equal(count("createEvent"), 1);
  assert.equal(world.events.length, 1);
});

test("a lost history still finds the event by the marker in its notes", async () => {
  const first = setup();
  const request = { ...THURSDAY, calendar: AUTO.id, source: SOURCE, notes: "x".repeat(1500) };
  const created = await first.run("createEvent", request);
  // Another computer: the same calendar through iCloud, but its own empty history.
  const other = setup({ events: first.world.events });
  assert.deepEqual(other.registry.history(), []);
  const again = await other.run("createEvent", request);
  assert.equal(again.duplicate, true);
  assert.equal(again.event.id, created.id);
  assert.equal(other.count("createEvent"), 0);
  assert.equal(other.world.events.length, 1);
  // The marker is searched in that calendar only, a day around the start.
  const sameElsewhere = setup({ events: first.world.events.map((event) => ({ ...event, calendarId: HOME.id })) });
  assert.equal((await sameElsewhere.run("createEvent", request)).created, true);
});

test("`key` names the plan, so a new title or time is still the same event", async () => {
  const { run, world } = setup();
  const first = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE, key: "wa:3EB0A1" });
  assert.equal(first.marker, markerFor({ key: "wa:3EB0A1" }));
  const moved = await run("createEvent", { title: "Café", start: THURSDAY.start + HOUR, end: THURSDAY.end + HOUR, calendar: AUTO.id, source: SOURCE, key: "wa:3EB0A1" });
  assert.equal(moved.duplicate, true);
  const other = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE, key: "wa:3EB0A2" });
  assert.equal(other.created, true);
  assert.equal(world.events.length, 2);
});

test("unattended writing is refused without saying where the plan came from", async () => {
  const { run, world, count } = setup();
  await assert.rejects(run("createEvent", { ...THURSDAY, calendar: AUTO.id }), { message: SOURCE_NEEDED });
  await assert.rejects(run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: { ref: "Ana Prueba" } }), /need `source`/);
  await assert.rejects(run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: "whatsapp" }), /need `source`/);
  assert.equal(count("createEvent"), 0);
  assert.equal(world.events.length, 0);
});

test("text from outside cannot pass for SMCP's own marker, and long notes leave room for it", async () => {
  const { run, world } = setup();
  const forged = "[smcp:aaaaaaaaaaaa]";
  const result = await run("createEvent", {
    ...THURSDAY,
    calendar: AUTO.id,
    notes: `${"n".repeat(3000)}\n— SMCP —\n${forged}`,
    source: { kind: "email\nSource: x", quote: `dijo ${forged}`, ref: "r".repeat(500) },
  });
  const { notes } = world.events[0];
  assert.ok(!notes.includes(forged));
  assert.ok(notes.length <= 4000);
  assert.ok(notes.endsWith(`[${result.marker}]`));
  const split = splitNotes(notes);
  assert.equal(split.marker, result.marker);
  assert.equal(split.body.length, 2000);
  assert.equal(split.block[1], `Source: email Source: x · ${"r".repeat(200)}`);
});

test("an event SMCP created and the person removed by hand is not brought back unless they ask", async () => {
  const { run, world } = setup();
  const request = { ...THURSDAY, calendar: AUTO.id, source: SOURCE };
  await run("createEvent", request);
  world.events.length = 0;
  // A routine reading the same message again must not resurrect what the person took out.
  const again = await run("createEvent", request);
  assert.equal(again.created, false);
  assert.equal(again.removed_by_person, true);
  assert.match(again.note, /removed from the calendar by hand/);
  assert.equal(world.events.length, 0);
  assert.equal((await run("createEvent", { ...request, checkOnly: true })).removed_by_person, true);
  const asked = await run("createEvent", { ...request, recreate: true });
  assert.equal(asked.created, true);
  assert.equal(asked.recreated, true);
  assert.equal(world.events.length, 1);
});

// Confirmation

test("any other calendar asks the person first, with the exact text, and respects a no", async () => {
  const { run, world, asked, answer, registry, count } = setup();
  const request = { title: "Junta", start: local(2026, 11, 16, 10), end: local(2026, 11, 16, 11), calendar: WORK.id, location: "Oficina", notes: "Llevar contrato", source: SOURCE };
  answer.value = false;
  const refused = await run("createEvent", request);
  assert.deepEqual(asked, [
    {
      body: "Event: Junta\nWhen: 2026-11-16 10:00 → 2026-11-16 11:00\nCalendar: Trabajo (Google)\nWhere: Oficina\n\nNotes:\nLlevar contrato",
      title: "SMCP: add event",
      button: "Add",
    },
  ]);
  assert.deepEqual(refused, { created: false, auto: false, reason: NOT_CONFIRMED, conflicts: [] });
  assert.equal(NOT_CONFIRMED, "Not confirmed. Nothing was changed.");
  assert.equal(world.events.length, 0);
  assert.equal(count("createEvent"), 0);

  answer.value = true;
  const accepted = await run("createEvent", request);
  assert.equal(accepted.created, true);
  assert.equal(accepted.auto, false);
  assert.equal(accepted.calendar, "Trabajo");
  // The person saw the notes in the window, so they are saved as they were shown.
  assert.equal(world.events[0].notes, "Llevar contrato");
  assert.deepEqual(registry.history(), []);
});

test("without a calendar the default one is used, and an all-day event shows its days", async () => {
  const { run, world, asked } = setup();
  await run("createEvent", { title: "Vacaciones", start: local(2026, 12, 20), end: local(2026, 12, 23) - 1000, allDay: true });
  assert.equal(asked[0].body, "Event: Vacaciones\nWhen: 2026-12-20 → 2026-12-22 (all day)\nCalendar: default");
  assert.equal(world.events[0].calendarId, HOME.id);
  await run("createEvent", { title: "Cumpleaños", start: local(2026, 12, 24), end: local(2026, 12, 25) - 1000, allDay: true });
  assert.match(asked[1].body, /When: 2026-12-24 \(all day\)/);
  // When the default calendar is an unattended one, the default is unattended too.
  const withAutoDefault = setup({ auto: [HOME.id] });
  const result = await withAutoDefault.run("createEvent", { ...THURSDAY, source: SOURCE });
  assert.equal(result.auto, true);
  assert.equal(withAutoDefault.asked.length, 0);
});

test("an event that is not valid, or a calendar that is unknown or read-only, is refused before asking", async () => {
  const { run, asked, world } = setup({ auto: [AUTO.id, LOCKED.id] });
  await assert.rejects(run("createEvent", { title: " ", start: 1, end: 2 }), /not valid/);
  await assert.rejects(run("createEvent", { title: "x", start: 2, end: 2 }), /not valid/);
  await assert.rejects(run("createEvent", { title: "x", start: "mañana", end: 2 }), /not valid/);
  await assert.rejects(run("createEvent", { ...THURSDAY, calendar: "cal-nope" }), /calendar_list_calendars/);
  await assert.rejects(run("createEvent", { ...THURSDAY, calendar: LOCKED.id, source: SOURCE }), /cannot be written/);
  assert.equal(asked.length, 0);
  assert.equal(world.events.length, 0);
});

test("a setting that cannot be read means nothing is unattended", async () => {
  const world = fakeMac();
  const asked = [];
  const ops = createCalendarOps({
    eventKit: createEventKit({ jxa: world.jxa }),
    confirm: async (body) => (asked.push(body), false),
    autoCalendars: () => {
      throw new Error("damaged");
    },
    registry: createAutoRegistry({ path: join(dir, `history-${files++}.jsonl`) }),
  });
  assert.equal((await ops.createEvent.run({ ...THURSDAY, calendar: AUTO.id, source: SOURCE })).created, false);
  assert.equal(asked.length, 1);
  const odd = setup({ auto: "cal-auto" });
  assert.equal((await odd.run("createEvent", { ...THURSDAY, calendar: AUTO.id, checkOnly: true })).auto, false);
});

// Conflicts

const BUSY = [
  seed({ id: "dentist", title: "Dentista", start: local(2026, 11, 19, 16, 30), end: local(2026, 11, 19, 17, 30) }),
  seed({ id: "holiday", title: "Feriado", start: local(2026, 11, 19), end: local(2026, 11, 20) - 1000, allDay: true, calendarId: LOCKED.id }),
  seed({ id: "before", title: "Justo antes", start: local(2026, 11, 19, 16), end: local(2026, 11, 19, 17), calendarId: WORK.id }),
  seed({ id: "after", title: "Justo después", start: local(2026, 11, 19, 18), end: local(2026, 11, 19, 19), calendarId: WORK.id }),
  seed({ id: "gym", title: "Gimnasio", start: local(2026, 11, 19, 17, 45), end: local(2026, 11, 19, 19), calendarId: WORK.id }),
];
const fresh = (events) => events.map((event) => ({ ...event }));

test("events already in the slot are reported from every calendar; all-day ones and neighbours are not", async () => {
  const { run, world, asked, count, answer } = setup({ events: fresh(BUSY) });
  const expected = [
    { id: "dentist", title: "Dentista", calendar: "Casa", start: local(2026, 11, 19, 16, 30), end: local(2026, 11, 19, 17, 30) },
    { id: "gym", title: "Gimnasio", calendar: "Trabajo", start: local(2026, 11, 19, 17, 45), end: local(2026, 11, 19, 19) },
  ];

  // Only checking writes nothing and asks nothing, in either kind of calendar.
  const checkAuto = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, checkOnly: true });
  assert.deepEqual(checkAuto, { created: false, check_only: true, auto: true, conflicts: expected });
  const checkOther = await run("createEvent", { ...THURSDAY, calendar: WORK.id, checkOnly: true });
  assert.deepEqual(checkOther, { created: false, check_only: true, auto: false, conflicts: expected });
  assert.equal(asked.length, 0);
  assert.equal(count("createEvent"), 0);
  assert.equal(world.events.length, BUSY.length);

  // A busy slot never stops the event: the caller decides what to tell the person.
  const created = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE });
  assert.equal(created.created, true);
  assert.deepEqual(created.conflicts, expected);
  answer.value = false;
  const refused = await run("createEvent", { ...THURSDAY, calendar: WORK.id });
  assert.equal(refused.created, false);
  assert.deepEqual(refused.conflicts.map((event) => event.id), ["dentist", created.id, "gym"]);
});

test("moving an event reports the new slot without counting the event itself", async () => {
  const { run } = setup({ events: fresh(BUSY) });
  const created = await run("createEvent", { title: "Llamada", start: local(2026, 11, 19, 10), end: local(2026, 11, 19, 11), calendar: AUTO.id, source: SOURCE });
  assert.deepEqual(created.conflicts, []);
  // Half an hour later it still overlaps its old self, and only itself.
  const nudged = await run("updateEvent", { id: created.id, start: local(2026, 11, 19, 10, 30) });
  assert.equal(nudged.updated, true);
  assert.deepEqual(nudged.conflicts, []);
  assert.equal(nudged.event.end, local(2026, 11, 19, 11, 30));
  const moved = await run("updateEvent", { id: created.id, start: local(2026, 11, 19, 17) });
  assert.deepEqual(moved.conflicts.map((event) => event.id), ["dentist", "gym"]);
  assert.equal(moved.event.start, local(2026, 11, 19, 17));
  // A change that does not move it does not look at the slot.
  const renamed = await run("updateEvent", { id: created.id, title: "Llamada con Ana" });
  assert.equal(renamed.conflicts, undefined);
});

// Unattended: update and delete

test("new notes keep SMCP's block and marker, and a new source adds its own line", async () => {
  const { run, world, asked } = setup();
  const created = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, notes: "Llevar el contrato", source: SOURCE });
  const block = provenanceBlock(SOURCE, created.marker);

  await run("updateEvent", { id: created.id, notes: "Llevar el regalo" });
  assert.equal(world.events[0].notes, ["Llevar el regalo", "", ...block].join("\n"));

  await run("updateEvent", { id: created.id, notes: "" });
  assert.equal(world.events[0].notes, block.join("\n"));

  const change = { kind: "whatsapp", ref: "Ana Prueba", quote: "mejor a las 6" };
  const moved = await run("updateEvent", { id: created.id, start: local(2026, 11, 19, 18), source: change });
  assert.equal(
    world.events[0].notes,
    [...block.slice(0, -1), 'Changed: 2026-11-13 · whatsapp · Ana Prueba · "mejor a las 6"', block.at(-1)].join("\n"),
  );
  assert.equal(splitNotes(moved.event.notes).marker, created.marker);

  // Only the latest few changes stay, so the block cannot grow without end.
  for (let i = 1; i <= 4; i++) await run("updateEvent", { id: created.id, start: local(2026, 11, 19, 18) + i * HOUR, source: { kind: "email", ref: `cambio ${i}` } });
  const lines = splitNotes(world.events[0].notes).block.filter((line) => line.startsWith("Changed: "));
  assert.deepEqual(lines, ["Changed: 2026-11-13 · email · cambio 2", "Changed: 2026-11-13 · email · cambio 3", "Changed: 2026-11-13 · email · cambio 4"]);
  assert.ok(world.events[0].notes.endsWith(`[${created.marker}]`));
  assert.equal(asked.length, 0);
});

test("notes typed in Calendar after the block, or a block without its header, are still told apart", () => {
  const block = provenanceBlock(SOURCE, "smcp:0123456789ab");
  assert.deepEqual(splitNotes(["Antes", "", ...block, "", "Escrito después"].join("\r\n")), { body: "Antes\n\nEscrito después", block, marker: "smcp:0123456789ab" });
  assert.deepEqual(splitNotes("Solo el marcador\n[smcp:0123456789ab]"), { body: "Solo el marcador", block: ["[smcp:0123456789ab]"], marker: "smcp:0123456789ab" });
  assert.deepEqual(splitNotes("Nada de SMCP"), { body: "Nada de SMCP", block: [], marker: null });
  assert.deepEqual(splitNotes(""), { body: "", block: [], marker: null });
  assert.deepEqual(cleanSource({ kind: " whatsapp ", ref: "", quote: "a\nb", extra: 1 }), { kind: "whatsapp", quote: "a b" });
  assert.equal(cleanSource({ ref: "x" }), null);
  assert.equal(cleanSource(null), null);
});

test("unattended changes and deletions keep what was there before, so they can be undone", async () => {
  const { run, world, asked, registry } = setup();
  const created = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, location: "Centro", source: SOURCE });
  const original = { ...world.events[0] };

  const updated = await run("updateEvent", { id: created.id, start: local(2026, 11, 20, 9), title: "Desayuno con Ana", location: "" });
  assert.equal(updated.updated, true);
  assert.equal(updated.auto, true);
  assert.equal(world.events[0].location, "");
  let [entry] = registry.history();
  assert.equal(entry.action, "update");
  assert.equal(entry.marker, created.marker);
  assert.equal(entry.title, "Desayuno con Ana");
  assert.equal(entry.start, local(2026, 11, 20, 9));
  assert.equal(entry.end, local(2026, 11, 20, 10));
  assert.deepEqual(entry.before, { title: "Café con Ana", start: THURSDAY.start, end: THURSDAY.end, allDay: false, location: "Centro" });
  assert.equal(entry.confirmed, undefined);
  assert.equal(registry.find(created.marker).title, "Desayuno con Ana");

  const deleted = await run("deleteEvent", { id: created.id });
  assert.deepEqual(deleted, { deleted: true, auto: true, id: created.id, title: "Desayuno con Ana", calendar: "SMCP" });
  assert.equal(world.events.length, 0);
  [entry] = registry.history();
  assert.equal(entry.action, "delete");
  assert.deepEqual(entry.before, {
    id: created.id,
    title: "Desayuno con Ana",
    calendar: "SMCP",
    calendarId: AUTO.id,
    start: local(2026, 11, 20, 9),
    end: local(2026, 11, 20, 10),
    allDay: false,
    location: "",
    notes: original.notes,
    recurring: false,
  });
  assert.deepEqual(registry.history().map((line) => line.action), ["delete", "update", "create"]);
  assert.equal(asked.length, 0);

  // After a deletion the plan may be created again, which is how a deletion is undone.
  assert.equal(registry.find(created.marker), null);
  const again = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE });
  assert.equal(again.created, true);
  assert.equal(again.recreated, undefined);
});

test("the person's own events in an unattended calendar can be changed there too", async () => {
  const { run, world, asked, registry } = setup({ events: [seed({ id: "mine", title: "Mío", calendarId: AUTO.id, notes: "Notas mías", start: THURSDAY.start, end: THURSDAY.end })] });
  const updated = await run("updateEvent", { id: "mine", title: "Mío, cambiado", source: SOURCE });
  assert.equal(updated.updated, true);
  assert.equal(asked.length, 0);
  assert.equal(world.events[0].notes, 'Notas mías\n\n— SMCP —\nChanged: 2026-11-13 · whatsapp · Ana Prueba · 2026-11-13 · "nos vemos el jueves a las 5"');
  assert.equal(registry.history()[0].marker, null);
  assert.equal(registry.history()[0].before.notes, "Notas mías");
});

test("the same values again write nothing, and an update needs something to change", async () => {
  const { run, count, registry } = setup();
  const created = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, notes: "Nota", source: SOURCE });
  const same = await run("updateEvent", { id: created.id, title: THURSDAY.title, start: THURSDAY.start, end: THURSDAY.end, notes: "Nota", calendar: AUTO.id, source: SOURCE });
  assert.equal(same.updated, false);
  assert.match(same.reason, /already has those values/);
  assert.equal(count("updateEvent"), 0);
  assert.equal(registry.history().length, 1);
  await assert.rejects(run("updateEvent", { id: created.id, source: SOURCE }), /Nothing to change/);
  await assert.rejects(run("updateEvent", { title: "x" }), /needs its id/);
  await assert.rejects(run("updateEvent", { id: created.id, title: "x", span: "all" }), /span/);
  await assert.rejects(run("updateEvent", { id: created.id, title: "  " }), /not valid/);
  await assert.rejects(run("updateEvent", { id: created.id, end: THURSDAY.start }), /not valid/);
  await assert.rejects(run("updateEvent", { id: "gone", title: "x" }), /no longer exists/);
  await assert.rejects(run("deleteEvent", { id: "gone" }), /no longer exists/);
});

test("turning an event into an all-day one, or back, gives it a usual length", async () => {
  const { run } = setup();
  const created = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE });
  const wholeDay = await run("updateEvent", { id: created.id, start: local(2026, 11, 20), allDay: true });
  assert.equal(wholeDay.event.allDay, true);
  assert.equal(wholeDay.event.end, local(2026, 11, 21) - 1000);
  const timed = await run("updateEvent", { id: created.id, start: local(2026, 11, 20, 12), allDay: false });
  assert.equal(timed.event.end, local(2026, 11, 20, 13));
});

test("moving an event out of an unattended calendar, or into another one, asks first", async () => {
  const { run, world, asked, answer, registry } = setup({ auto: [AUTO.id, HOME.id] });
  const created = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE });

  // Between two unattended calendars nobody is asked.
  const between = await run("updateEvent", { id: created.id, calendar: HOME.id });
  assert.equal(between.auto, true);
  assert.equal(world.events[0].calendarId, HOME.id);
  assert.deepEqual(registry.history()[0].before, { calendarId: AUTO.id, calendar: "SMCP" });
  assert.equal(asked.length, 0);

  answer.value = false;
  const refused = await run("updateEvent", { id: created.id, calendar: WORK.id });
  assert.deepEqual(refused, { updated: false, auto: false, reason: NOT_CONFIRMED });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "SMCP: change event");
  assert.equal(asked[0].button, "Change");
  assert.equal(
    asked[0].body,
    `Event: Café con Ana\nWhen: ${clock(THURSDAY.start)} → ${clock(THURSDAY.end)}\nCalendar: Casa (iCloud)\n\nChanges:\nCalendar: Casa (iCloud) → Trabajo (Google)`,
  );
  assert.equal(world.events[0].calendarId, HOME.id);

  // Accepted: the move is kept in the history, marked as confirmed, and the event's new id with it.
  answer.value = true;
  const out = await run("updateEvent", { id: created.id, calendar: WORK.id });
  assert.equal(out.updated, true);
  assert.equal(out.auto, false);
  assert.notEqual(out.event.id, created.id);
  assert.equal(out.event.calendarId, WORK.id);
  const [entry] = registry.history();
  assert.equal(entry.confirmed, true);
  assert.equal(entry.eventId, out.event.id);
  assert.equal(entry.before.eventId, created.id);
  assert.equal(registry.find(created.marker).eventId, out.event.id);
  // So the same plan is still known, wherever the event now lives.
  assert.equal((await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE })).duplicate, true);

  // Coming back in is the person's call as well.
  answer.value = false;
  assert.equal((await run("updateEvent", { id: out.event.id, calendar: AUTO.id })).updated, false);
  assert.equal(asked.length, 3);
});

test("changing an event in any other calendar shows what changes, old and new", async () => {
  const events = [seed({ id: "junta", title: "Junta", calendarId: WORK.id, location: "Oficina", notes: "Orden del día", start: local(2026, 11, 16, 10), end: local(2026, 11, 16, 11) })];
  const { run, world, asked, answer, registry, count } = setup({ events });
  answer.value = false;
  const change = { id: "junta", title: "Junta de cierre", start: local(2026, 11, 17, 12), location: "", notes: "Traer cifras", source: SOURCE };
  const refused = await run("updateEvent", change);
  assert.equal(refused.updated, false);
  assert.equal(refused.reason, NOT_CONFIRMED);
  assert.deepEqual(refused.conflicts, []);
  assert.equal(count("updateEvent"), 0);
  assert.equal(
    asked[0].body,
    [
      "Event: Junta",
      "When: 2026-11-16 10:00 → 2026-11-16 11:00",
      "Calendar: Trabajo (Google)",
      "",
      "Changes:",
      "Event: Junta → Junta de cierre",
      "When: 2026-11-16 10:00 → 2026-11-16 11:00 → 2026-11-17 12:00 → 2026-11-17 13:00",
      "Where: Oficina → —",
      "",
      "Notes:",
      "Traer cifras",
    ].join("\n"),
  );
  answer.value = true;
  const accepted = await run("updateEvent", change);
  assert.equal(accepted.updated, true);
  assert.deepEqual({ ...world.events[0] }, { ...events[0], title: "Junta de cierre", start: local(2026, 11, 17, 12), end: local(2026, 11, 17, 13), location: "", notes: "Traer cifras" });
  // Nothing unattended happened, and the event was never SMCP's, so the history stays empty.
  assert.deepEqual(registry.history(), []);
});

test("deleting from any other calendar asks; a read-only calendar is refused", async () => {
  const events = [
    seed({ id: "junta", title: "Junta", calendarId: WORK.id, location: "Oficina", start: local(2026, 11, 16, 10), end: local(2026, 11, 16, 11) }),
    seed({ id: "feriado", title: "Feriado", calendarId: LOCKED.id, allDay: true, start: local(2026, 11, 16), end: local(2026, 11, 17) - 1000 }),
  ];
  const { run, world, asked, answer, registry } = setup({ events });
  answer.value = false;
  assert.deepEqual(await run("deleteEvent", { id: "junta" }), { deleted: false, auto: false, reason: NOT_CONFIRMED });
  assert.deepEqual(asked, [
    { body: "Event: Junta\nWhen: 2026-11-16 10:00 → 2026-11-16 11:00\nCalendar: Trabajo (Google)\nWhere: Oficina", title: "SMCP: delete event", button: "Delete" },
  ]);
  assert.equal(world.events.length, 2);
  answer.value = true;
  assert.deepEqual(await run("deleteEvent", { id: "junta" }), { deleted: true, auto: false, id: "junta", title: "Junta", calendar: "Trabajo" });
  assert.deepEqual(world.events.map((event) => event.id), ["feriado"]);
  assert.deepEqual(registry.history(), []);
  await assert.rejects(run("deleteEvent", { id: "feriado" }), /cannot be written/);
  await assert.rejects(run("updateEvent", { id: "feriado", title: "x" }), /cannot be written/);
});

test("a repeating event changes only the repeat named, or that one and the ones after it", async () => {
  const weekly = (calendarId) =>
    [0, 7, 14].map((days) => seed({ id: "weekly", title: "Clase", calendarId, recurring: true, start: local(2026, 11, 2 + days, 8), end: local(2026, 11, 2 + days, 9) }));
  const { run, world, asked, registry } = setup({ events: weekly(AUTO.id) });
  const second = local(2026, 11, 9, 8);

  const one = await run("updateEvent", { id: "weekly", occurrence: second, title: "Clase movida" });
  assert.equal(one.recurring, true);
  assert.equal(one.span, "this");
  assert.deepEqual(world.events.map((event) => event.title), ["Clase", "Clase movida", "Clase"]);
  assert.deepEqual(world.state.saves.at(-1), { span: 0 });

  await run("updateEvent", { id: "weekly", occurrence: second, location: "Sala 2", span: "future" });
  assert.deepEqual(world.state.saves.at(-1), { span: 1 });

  // Without naming a repeat, EventKit answers with the first one.
  assert.equal((await run("updateEvent", { id: "weekly", location: "Sala 1" })).event.start, local(2026, 11, 2, 8));
  await assert.rejects(run("updateEvent", { id: "weekly", occurrence: second + HOUR, title: "x" }), /no repeat starting then/);

  const gone = await run("deleteEvent", { id: "weekly", occurrence: second, span: "future" });
  assert.deepEqual(gone, { deleted: true, auto: true, id: "weekly", title: "Clase movida", calendar: "SMCP", recurring: true, span: "future" });
  assert.deepEqual(world.events.map((event) => event.start), [local(2026, 11, 2, 8)]);
  assert.equal(registry.history()[0].before.span, "future");
  assert.equal(asked.length, 0);

  // Elsewhere the window says how far the change reaches.
  const other = setup({ events: weekly(WORK.id) });
  other.answer.value = false;
  await other.run("deleteEvent", { id: "weekly", occurrence: second });
  await other.run("updateEvent", { id: "weekly", occurrence: second, title: "x", span: "future" });
  assert.match(other.asked[0].body, /\nRepeats: only this event$/);
  assert.match(other.asked[1].body, /\nRepeats: this and future events\n\nChanges:/);
  assert.equal(other.world.events.length, 3);
});

// The history

test("the history skips a damaged line, reads newest first, and forgets a marker once deleted", async () => {
  const path = join(dir, "damaged.jsonl");
  const registry = createAutoRegistry({ path });
  assert.deepEqual(registry.history(), []);
  assert.equal(registry.find("smcp:aaaaaaaaaaaa"), null);
  const base = { marker: "smcp:aaaaaaaaaaaa", eventId: "e1", calendarId: AUTO.id, calendar: "SMCP", title: "Uno", start: 1000, end: 2000, allDay: false, source: SOURCE };
  assert.equal(registry.record({ ...base, at: "2026-11-10T10:00:00.000Z", action: "create" }), true);
  await appendFile(path, '{damaged\n\n"text"\n{"action":"explode","at":"2026-11-10T10:00:00.000Z"}\n{"action":"create"}\n');
  assert.equal(registry.record({ ...base, at: "2026-11-11T10:00:00.000Z", action: "update", eventId: "e2", title: "Dos", before: { title: "Uno" }, password: "x" }), true);
  assert.equal(registry.record({ ...base, at: "2026-11-12T10:00:00.000Z", action: "create", marker: "smcp:bbbbbbbbbbbb", eventId: "e9" }), true);
  assert.equal(registry.record({ action: "explode" }), false);

  assert.deepEqual(registry.history().map((entry) => [entry.action, entry.eventId]), [["create", "e9"], ["update", "e2"], ["create", "e1"]]);
  assert.equal(registry.history({ limit: 1 }).length, 1);
  assert.deepEqual(registry.history({ since: Date.parse("2026-11-11T00:00:00Z") }).map((entry) => entry.eventId), ["e9", "e2"]);
  assert.deepEqual(registry.history({ since: "2026-11-12T00:00:00Z" }).map((entry) => entry.eventId), ["e9"]);
  // Only the known fields are kept, in one order.
  assert.deepEqual(Object.keys(registry.history()[1]), ["at", "action", "marker", "eventId", "calendarId", "calendar", "title", "start", "end", "allDay", "source", "before"]);
  assert.equal(registry.find("smcp:aaaaaaaaaaaa").eventId, "e2");

  registry.record({ ...base, at: "2026-11-13T10:00:00.000Z", action: "delete", eventId: "e2", before: { title: "Dos" } });
  assert.equal(registry.find("smcp:aaaaaaaaaaaa"), null);
  assert.equal(registry.find("smcp:bbbbbbbbbbbb").eventId, "e9");
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 9);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a history that cannot be written does not undo the event, and says so", async () => {
  const blocker = join(dir, `blocker-${files++}`);
  await appendFile(blocker, "x");
  const { run, world } = setup({ registryPath: join(blocker, "history.jsonl") });
  const result = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE });
  assert.equal(result.created, true);
  assert.equal(result.history_saved, false);
  assert.equal(world.events.length, 1);
  // The marker in the notes still stops a second copy.
  assert.equal((await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE })).duplicate, true);
});

test("the history operation returns what was done unattended, newest first", async () => {
  const { run } = setup();
  const created = await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE });
  await run("deleteEvent", { id: created.id });
  assert.deepEqual((await run("autoHistory")).map((entry) => entry.action), ["delete", "create"]);
  assert.equal((await run("autoHistory", { limit: 1 })).length, 1);
  assert.deepEqual(await run("autoHistory", { since: NOW + DAY }), []);
});

// Reminders

test("a reminder changes only what is given, can lose its due date, be re-opened and be deleted", async () => {
  const reminders = [{ id: "r1", title: "Pagar luz", listId: LIST.id, notes: "Recibo", due: local(2026, 11, 15), dueHasTime: false, completed: true, priority: 0 }];
  const { run, world, asked, count } = setup({ reminders });
  const updated = await run("updateReminder", { id: "r1", title: "Pagar la luz", due: local(2026, 11, 16, 16, 30), dueHasTime: true, completed: false });
  assert.deepEqual(updated, { id: "r1", title: "Pagar la luz", list: "Pendientes", completed: false, due: local(2026, 11, 16, 16, 30), dueHasTime: true, priority: 0, notes: "Recibo" });
  assert.equal((await run("updateReminder", { id: "r1", due: local(2026, 11, 17, 16, 30) })).dueHasTime, false);
  assert.equal(world.reminders[0].due, local(2026, 11, 17));
  const cleared = await run("updateReminder", { id: "r1", due: null, notes: "" });
  assert.equal(cleared.due, null);
  assert.equal(cleared.notes, "");
  assert.equal(cleared.title, "Pagar la luz");
  assert.deepEqual((await run("reminders")).map((reminder) => reminder.id), ["r1"]);

  await assert.rejects(run("updateReminder", { title: "x" }), /needs its id/);
  await assert.rejects(run("updateReminder", { id: "r1" }), /Nothing to change/);
  await assert.rejects(run("updateReminder", { id: "r1", dueHasTime: true }), /Nothing to change/);
  await assert.rejects(run("updateReminder", { id: "r1", title: "  " }), /needs a title/);
  await assert.rejects(run("updateReminder", { id: "r1", due: "mañana" }), /valid date/);
  await assert.rejects(run("updateReminder", { id: "r1", list: "list-nope" }), /reminders_list_lists/);
  await assert.rejects(run("updateReminder", { id: "nope", title: "x" }), /no longer exists/);
  await assert.rejects(run("deleteReminder", {}), /needs its id/);
  await assert.rejects(run("deleteReminder", { id: "nope" }), /no longer exists/);
  assert.equal(count("updateReminder"), 5);

  assert.deepEqual(await run("deleteReminder", { id: "r1" }), { deleted: true, id: "r1", title: "Pagar la luz" });
  assert.equal(world.reminders.length, 0);
  // Reminders never used a window.
  assert.equal(asked.length, 0);
});

test("creating and completing reminders still work as before", async () => {
  const { run, world } = setup();
  await assert.rejects(run("createReminder", { title: " " }), /needs a title/);
  await assert.rejects(run("createReminder", { title: "x", due: "pronto" }), /valid date/);
  const created = await run("createReminder", { title: "Llamar a Ana", due: local(2026, 11, 15, 16, 30), dueHasTime: true });
  assert.deepEqual(created, { id: world.reminders[0].id, list: "Pendientes" });
  assert.equal((await run("createReminder", { title: "Sin fecha" })).list, "Pendientes");
  assert.equal(world.reminders[1].due, null);
  assert.deepEqual(await run("completeReminder", { id: created.id }), { completed: true, id: created.id, title: "Llamar a Ana" });
  assert.deepEqual((await run("reminders")).map((reminder) => reminder.title), ["Sin fecha"]);
  assert.equal((await run("reminders", { includeCompleted: true })).length, 2);
  // An event's id is not a reminder.
  await run("createEvent", { ...THURSDAY, calendar: AUTO.id, source: SOURCE });
  await assert.rejects(run("completeReminder", { id: world.events[0].id }), /no longer exists/);
});

// EventKit

test("EventKit sends every value as data and turns its codes into sentences", async () => {
  const seen = [];
  const kit = createEventKit({ jxa: async (prelude, script, params) => (seen.push({ script, params }), { status: 3, events: [] }) });
  await kit.events({ from: 1, to: 2, calendars: ["a"], notesContains: '[smcp:x]"); doShellScript("x' });
  assert.equal(seen[0].params.notesContains, '[smcp:x]"); doShellScript("x');
  assert.ok(!seen[0].script.includes("doShellScript"));
  await kit.events({ from: 1, to: 2 });
  assert.equal("notesContains" in seen[1].params, false);
  await kit.updateEvent({ id: "e", title: "t", location: "", span: 1, occurrence: 5 });
  assert.deepEqual(seen[2].params, { id: "e", occurrence: 5, title: "t", location: "", span: 1, notesChars: 5000 });
  await kit.deleteEvent({ id: "e", span: "future" });
  assert.deepEqual(seen[3].params, { id: "e", span: 0 });
  await kit.updateReminder({ id: "r", due: null });
  assert.deepEqual(seen[4].params, { id: "r", due: null, dueHasTime: false, notesChars: 1000 });
  await kit.getEvent({ id: "e" });
  assert.deepEqual(seen[5].params, { id: "e", notesChars: 5000 });

  assert.equal(friendlyEventKitError(new Error("NO_EVENT")), "That event no longer exists.");
  assert.match(friendlyEventKitError(new Error("NO_OCCURRENCE")), /calendar_list_events/);
  assert.match(friendlyEventKitError(new Error("NO_DEFAULT")), /no default calendar/);
  assert.match(friendlyEventKitError(new Error("NO_DEFAULT"), REMINDERS), /no default list/);
  assert.match(friendlyEventKitError(new Error("NO_ACCESS:2")), /Privacy & Security > Calendar/);
  assert.match(friendlyEventKitError(new Error("NO_CALENDAR")), /calendar_list_calendars/);
  assert.match(friendlyEventKitError(new Error("NO_REMINDER")), /reminder no longer exists/);
  assert.match(friendlyEventKitError(new Error("SAVE_FAILED:Read only.")), /did not save the change: Read only\./);
  assert.equal(eventKitErrorCode(new Error("Error: NO_EVENT")), "NO_EVENT");
  assert.equal(eventKitErrorCode(new Error("boom")), null);
});

test("the scripts read one event whole, filter by notes inside the script, and report what macOS refuses", async () => {
  const long = `${"a".repeat(1200)} [smcp:0123456789ab]`;
  const events = [
    seed({ id: "long", title: "Largo", notes: long, start: local(2026, 11, 16, 10), end: local(2026, 11, 16, 11) }),
    seed({ id: "short", title: "Corto", notes: "", start: local(2026, 11, 16, 12), end: local(2026, 11, 16, 13) }),
  ];
  const { kit, world } = setup({ events });
  const listed = await kit.events({ from: local(2026, 11, 16), to: local(2026, 11, 17) });
  assert.equal(listed.status, "granted");
  assert.deepEqual(listed.events.map((event) => [event.id, event.calendarId, event.calendar, event.notes.length, event.recurring]), [
    ["long", HOME.id, "Casa", 1000, false],
    ["short", HOME.id, "Casa", 0, false],
  ]);
  // The marker sits past the part of the notes a list returns, and is still found.
  const marked = await kit.events({ from: local(2026, 11, 16), to: local(2026, 11, 17), notesContains: "[smcp:0123456789ab]" });
  assert.deepEqual(marked.events.map((event) => event.id), ["long"]);
  assert.deepEqual((await kit.events({ from: local(2026, 11, 16), to: local(2026, 11, 17), calendars: [WORK.id] })).events, []);
  assert.deepEqual((await kit.events({ from: local(2027, 1, 1), to: local(2027, 1, 2) })).events, []);
  assert.equal((await kit.getEvent({ id: "long" })).notes, long);
  assert.deepEqual(await kit.defaultCalendar(), { id: HOME.id, title: "Casa", account: "iCloud", writable: true });
  assert.equal((await kit.defaultCalendar(REMINDERS)).id, LIST.id);

  await assert.rejects(kit.getEvent({ id: "nope" }), (error) => error.code === "NO_EVENT" && error.message === "That event no longer exists.");
  await assert.rejects(kit.updateEvent({ id: "short", calendar: LOCKED.id }), /did not save the change: That calendar is read only\./);
  await assert.rejects(kit.updateEvent({ id: "short", calendar: "cal-nope" }), /calendar_list_calendars/);
  world.state.noDefault = true;
  await assert.rejects(kit.defaultCalendar(), (error) => error.code === "NO_DEFAULT");
  world.state.access = 2;
  await assert.rejects(kit.getEvent({ id: "long" }), (error) => error.code === "NO_ACCESS" && /System Settings/.test(error.message));
  assert.deepEqual(await kit.events({ from: 1, to: 2, passive: true }), { status: "denied", events: [] });
});

// MCP tools

function fakeServer() {
  const tools = {};
  return { tools, registerTool: (name, config, handler) => (tools[name] = { config, handler }) };
}
const payload = (result) => {
  const data = JSON.parse(result.content[0].text);
  return data._untrusted_external ? data.data : data;
};

function tools(reply = () => ({})) {
  const calls = [];
  const server = fakeServer();
  registerCalendar(server, { call: async (op, args, options) => (calls.push({ op, args, options }), reply(op, args)) });
  const use = async (name, args) => {
    const parsed = server.tools[name].config.inputSchema ? Object.fromEntries(Object.entries(server.tools[name].config.inputSchema).map(([key, schema]) => [key, schema.parse(args[key])])) : args;
    return server.tools[name].handler(parsed);
  };
  return { server, calls, use };
}

test("the new tools are registered with the right annotations", () => {
  const { server } = tools();
  const writes = ["calendar_create_event", "calendar_update_event", "calendar_delete_event", "reminders_create", "reminders_update", "reminders_complete", "reminders_delete"];
  for (const name of writes) assert.deepEqual(server.tools[name].config.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, name);
  for (const name of ["calendar_auto_history", "calendar_list_calendars", "calendar_list_events"]) assert.equal(server.tools[name].config.annotations.readOnlyHint, true, name);
  assert.match(server.tools.calendar_create_event.config.description, /unattended/);
  assert.match(server.tools.calendar_create_event.config.description, /`source` is required/);
  assert.match(server.tools.calendar_list_calendars.config.description, /unattended/);
});

test("calendar_create_event passes the source, the key and the check, and waits long enough for a window", async () => {
  const { calls, use } = tools(() => ({
    created: true,
    auto: true,
    id: "new",
    calendar: "SMCP",
    calendarId: AUTO.id,
    marker: "smcp:0123456789ab",
    conflicts: [{ id: "dentist", title: "Dentista", calendar: "Casa", start: local(2026, 11, 19, 16, 30), end: local(2026, 11, 19, 17, 30) }],
  }));
  const result = payload(await use("calendar_create_event", { title: "Café con Ana", start: "2026-11-19T17:00:00", calendar: AUTO.id, source: SOURCE, key: "wa:3EB0A1" }));
  assert.deepEqual(calls[0], {
    op: "createEvent",
    args: { title: "Café con Ana", start: THURSDAY.start, end: THURSDAY.end, allDay: false, calendar: AUTO.id, location: undefined, notes: undefined, source: SOURCE, key: "wa:3EB0A1", checkOnly: false, recreate: false },
    options: { timeoutMs: 200_000 },
  });
  assert.deepEqual(result, {
    created: true,
    auto: true,
    id: "new",
    calendar: "SMCP",
    marker: "smcp:0123456789ab",
    calendar_id: AUTO.id,
    conflicts: [{ id: "dentist", title: "Dentista", calendar: "Casa", start: formatLocal(local(2026, 11, 19, 16, 30)), end: formatLocal(local(2026, 11, 19, 17, 30)) }],
  });

  await use("calendar_create_event", { title: "Vacaciones", start: "2026-12-20", end: "2026-12-22", check_only: true });
  assert.deepEqual([calls[1].args.start, calls[1].args.end, calls[1].args.allDay, calls[1].args.checkOnly], [local(2026, 12, 20), local(2026, 12, 23) - 1000, true, true]);
  await use("calendar_create_event", { title: "Feriado", start: "2026-12-25" });
  assert.equal(calls[2].args.end, local(2026, 12, 26) - 1000);
  assert.equal((await use("calendar_create_event", { title: "Mal", start: "2026-12-20T10:00:00Z", end: "2026-12-20T09:00:00Z" })).isError, true);
  assert.equal(calls.length, 3);
});

test("a duplicate comes back as the event that already exists", async () => {
  const existing = { id: "e1", title: "Café con Ana", calendar: "SMCP", calendarId: AUTO.id, start: THURSDAY.start, end: THURSDAY.end, allDay: false, location: "", notes: "", recurring: false };
  const { use } = tools(() => ({ created: false, duplicate: true, auto: true, marker: "smcp:0123456789ab", event: existing, conflicts: [] }));
  const result = payload(await use("calendar_create_event", { title: "Café con Ana", start: "2026-11-19T17:00:00", calendar: AUTO.id, source: SOURCE }));
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.event, { id: "e1", title: "Café con Ana", calendar: "SMCP", start: formatLocal(THURSDAY.start), end: formatLocal(THURSDAY.end), all_day: false, calendar_id: AUTO.id });
  assert.equal(presentEvent({ ...existing, recurring: true }).recurring, true);
});

test("calendar_update_event sends only what was given, with dates the way EventKit wants them", async () => {
  const { calls, use } = tools();
  await use("calendar_update_event", { id: "e1", start: "2026-11-20T09:00:00" });
  assert.deepEqual(calls[0], {
    op: "updateEvent",
    args: { id: "e1", occurrence: undefined, span: "this", title: undefined, start: local(2026, 11, 20, 9), end: undefined, allDay: false, calendar: undefined, location: undefined, notes: undefined, source: undefined },
    options: { timeoutMs: 200_000 },
  });
  // A bare date makes it an all-day event; a bare end date alone runs through that day.
  await use("calendar_update_event", { id: "e1", start: "2026-11-20", end: "2026-11-21" });
  assert.deepEqual([calls[1].args.start, calls[1].args.end, calls[1].args.allDay], [local(2026, 11, 20), local(2026, 11, 22) - 1000, true]);
  await use("calendar_update_event", { id: "e1", end: "2026-11-21" });
  assert.deepEqual([calls[2].args.start, calls[2].args.end, calls[2].args.allDay], [undefined, local(2026, 11, 22) - 1000, undefined]);
  await use("calendar_update_event", { id: "e1", end: "2026-11-21T10:00:00" });
  assert.equal(calls[3].args.end, local(2026, 11, 21, 10));

  await use("calendar_update_event", { id: "weekly", occurrence_start: "2026-11-09T08:00:00", span: "future", location: "", notes: "", calendar: WORK.id, title: "Clase", source: SOURCE });
  assert.deepEqual(calls[4].args, {
    id: "weekly",
    occurrence: local(2026, 11, 9, 8),
    span: "future",
    title: "Clase",
    start: undefined,
    end: undefined,
    allDay: undefined,
    calendar: WORK.id,
    location: "",
    notes: "",
    source: SOURCE,
  });
  assert.equal((await use("calendar_update_event", { id: "e1", start: "2026-11-20T10:00:00", end: "2026-11-20T09:00:00" })).isError, true);
  assert.equal(calls.length, 5);
});

test("calendar_delete_event names the event, the repeat and how far it reaches", async () => {
  const { calls, use } = tools(() => ({ deleted: true, auto: true, id: "weekly", title: "Clase", calendar: "SMCP" }));
  const result = payload(await use("calendar_delete_event", { id: "weekly", occurrence_start: "2026-11-09", span: "future" }));
  assert.deepEqual(calls[0], { op: "deleteEvent", args: { id: "weekly", occurrence: local(2026, 11, 9), span: "future" }, options: { timeoutMs: 200_000 } });
  assert.deepEqual(result, { deleted: true, auto: true, id: "weekly", title: "Clase", calendar: "SMCP" });
  await use("calendar_delete_event", { id: "e1" });
  assert.deepEqual(calls[1].args, { id: "e1", occurrence: undefined, span: "this" });
});

test("calendar_auto_history shows each action in local time, with what to put back", async () => {
  const entries = [
    { at: "2026-11-13T15:30:00.000Z", action: "delete", marker: "smcp:0123456789ab", eventId: "e1", calendarId: AUTO.id, calendar: "SMCP", title: "Vacaciones", start: local(2026, 12, 20), end: local(2026, 12, 23) - 1000, allDay: true, source: null, before: { id: "e1", title: "Vacaciones", calendar: "SMCP", calendarId: AUTO.id, start: local(2026, 12, 20), end: local(2026, 12, 23) - 1000, allDay: true, location: "", notes: "n", recurring: false } },
    { at: "2026-11-13T15:00:00.000Z", action: "update", marker: null, eventId: "e2", calendarId: AUTO.id, calendar: "SMCP", title: "Café", start: THURSDAY.start, end: THURSDAY.end, allDay: false, source: SOURCE, before: { start: THURSDAY.start - HOUR, end: THURSDAY.end - HOUR, allDay: false, eventId: "e0" } },
    { at: "2026-11-13T14:00:00.000Z", action: "create", marker: "smcp:0123456789ab", eventId: "e1", calendarId: AUTO.id, calendar: "SMCP", title: "Vacaciones", start: local(2026, 12, 20), end: local(2026, 12, 23) - 1000, allDay: true, source: SOURCE },
  ];
  const { calls, use } = tools(() => entries);
  const result = payload(await use("calendar_auto_history", { since: "2026-11-13" }));
  assert.deepEqual(calls[0], { op: "autoHistory", args: { limit: 50, since: local(2026, 11, 13) }, options: undefined });
  assert.equal(result.total, 3);
  assert.deepEqual(result.entries[0], {
    at: "2026-11-13T15:30:00.000Z",
    action: "delete",
    marker: "smcp:0123456789ab",
    calendar: "SMCP",
    title: "Vacaciones",
    source: null,
    event_id: "e1",
    calendar_id: AUTO.id,
    start: "2026-12-20",
    end: "2026-12-22",
    all_day: true,
    before: { title: "Vacaciones", calendar: "SMCP", location: "", notes: "n", recurring: false, event_id: "e1", calendar_id: AUTO.id, start: "2026-12-20", end: "2026-12-22", all_day: true },
  });
  assert.deepEqual(result.entries[1].before, { event_id: "e0", start: formatLocal(THURSDAY.start - HOUR), end: formatLocal(THURSDAY.end - HOUR), all_day: false });
  assert.equal(result.entries[1].start, formatLocal(THURSDAY.start));
  assert.equal(result.entries[2].before, undefined);
  await use("calendar_auto_history", {});
  assert.deepEqual(calls[1].args, { limit: 50, since: undefined });
});

test("reminders_update and reminders_delete map dates the same way as reminders_create", async () => {
  const { calls, use } = tools((op) => (op === "updateReminder" ? { id: "r1", title: "Pagar la luz", list: "Pendientes", completed: false, due: local(2026, 11, 15), dueHasTime: false, priority: 0, notes: "" } : { deleted: true, id: "r1", title: "Pagar la luz" }));
  const shown = payload(await use("reminders_update", { id: "r1", due: "2026-11-15", title: "Pagar la luz" }));
  assert.deepEqual(calls[0], { op: "updateReminder", args: { id: "r1", title: "Pagar la luz", list: undefined, notes: undefined, completed: undefined, due: local(2026, 11, 15), dueHasTime: false }, options: undefined });
  assert.deepEqual(shown, { id: "r1", title: "Pagar la luz", list: "Pendientes", completed: false, due: "2026-11-15" });
  await use("reminders_update", { id: "r1", due: "2026-11-15T16:30:00" });
  assert.deepEqual([calls[1].args.due, calls[1].args.dueHasTime], [local(2026, 11, 15, 16, 30), true]);
  await use("reminders_update", { id: "r1", clear_due: true });
  assert.deepEqual([calls[2].args.due, calls[2].args.dueHasTime], [null, false]);
  await use("reminders_update", { id: "r1", completed: false, notes: "" });
  assert.deepEqual([calls[3].args.due, calls[3].args.completed, calls[3].args.notes], [undefined, false, ""]);
  assert.equal((await use("reminders_update", { id: "r1", due: "2026-11-15", clear_due: true })).isError, true);
  assert.deepEqual(payload(await use("reminders_delete", { id: "r1" })), { deleted: true, id: "r1", title: "Pagar la luz" });
  assert.deepEqual(calls.at(-1), { op: "deleteReminder", args: { id: "r1" }, options: undefined });
});

test("the tools and the operations agree end to end, from the AI's dates to the calendar", async () => {
  const { ops, world, registry } = setup({ events: fresh(BUSY) });
  const server = fakeServer();
  registerCalendar(server, { call: (op, args) => ops[op].run(JSON.parse(JSON.stringify(args ?? {}))) });
  const use = async (name, args) => payload(await server.tools[name].handler(args));

  const calendars = await use("calendar_list_calendars", {});
  assert.equal(calendars.find((calendar) => calendar.id === AUTO.id).unattended, true);
  const created = await use("calendar_create_event", { title: "Café con Ana", start: "2026-11-19T17:00:00", calendar: AUTO.id, source: SOURCE });
  assert.equal(created.created, true);
  assert.deepEqual(created.conflicts.map((event) => event.id), ["dentist", "gym"]);
  assert.equal((await use("calendar_create_event", { title: "Café con Ana", start: "2026-11-19T17:00:00", calendar: AUTO.id, source: SOURCE })).duplicate, true);

  const listed = await use("calendar_list_events", { from: "2026-11-19", to: "2026-11-19", calendars: [AUTO.id] });
  assert.deepEqual(listed.events.map((event) => [event.id, event.calendar_id]), [[created.id, AUTO.id]]);

  const moved = await use("calendar_update_event", { id: created.id, start: "2026-11-21", span: "this" });
  assert.equal(moved.event.all_day, true);
  assert.equal(moved.event.start, "2026-11-21");
  assert.equal(moved.event.end, "2026-11-21");
  assert.deepEqual(moved.conflicts, []);
  assert.equal(world.events.find((event) => event.id === created.id).end, local(2026, 11, 22) - 1000);

  assert.equal((await use("calendar_delete_event", { id: created.id, span: "this" })).deleted, true);
  const history = await use("calendar_auto_history", { limit: 50 });
  assert.deepEqual(history.entries.map((entry) => entry.action), ["delete", "update", "create"]);
  assert.equal(history.entries[0].before.start, "2026-11-21");
  assert.equal(registry.find(created.marker), null);
});
