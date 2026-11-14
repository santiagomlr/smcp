// Opt-in tests against the real Calendar, Reminders and Contacts of a Mac. They are the only tests
// that run the JavaScript for Automation scripts for real; everything else uses a fake bridge.
//
//   SMCP_LIVE_CALENDAR="SMCP pruebas" node --test test/calendar-live.test.js
//
// SMCP_LIVE_CALENDAR is the title of a throwaway calendar: events are created, moved and deleted in
// it, without any window, as if the person had chosen it for unattended writing. To also check
// repeating events, add by hand a weekly event titled "SMCP live repeat" starting within the next
// week; each run renames its second upcoming repeat and deletes its third.
// SMCP_LIVE_REMINDERS is the title of a throwaway Reminders list, and SMCP_LIVE_CONTACTS a name to
// look up in Contacts (nothing is written there, and nothing found is printed).
// macOS asks for access under the name of the app that runs the test, usually the terminal.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAutoRegistry, createCalendarOps, splitNotes } from "../app/core/calendar-ops.js";
import { createContacts, queryKind } from "../src/contacts.js";
import { createEventKit, EVENTS, REMINDERS } from "../src/eventkit.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const IS_MAC = process.platform === "darwin";
const CALENDAR = process.env.SMCP_LIVE_CALENDAR;
const LIST = process.env.SMCP_LIVE_REMINDERS;
const PERSON = process.env.SMCP_LIVE_CONTACTS;
const REPEAT_TITLE = "SMCP live repeat";

const skipUnless = (value, name, what) => {
  if (!IS_MAC) return "Runs only on macOS: it uses the real Calendar, Reminders and Contacts.";
  return value ? false : `Opt-in: set ${name} to ${what}.`;
};

/** Tomorrow at 03:00, where a real calendar is most likely empty. */
function quietHour() {
  const at = new Date();
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 3, 0, 0, 0).getTime();
}

async function throwaway(eventKit, type, title) {
  const matches = (await eventKit.calendars(type)).filter((calendar) => calendar.title === title);
  assert.equal(matches.length, 1, `Expected exactly one ${type === EVENTS ? "calendar" : "list"} titled "${title}", found ${matches.length}.`);
  assert.equal(matches[0].writable, true, `"${title}" cannot be written.`);
  return matches[0];
}

test(
  "live: an unattended calendar gets the event once, then it is moved and deleted",
  { skip: skipUnless(CALENDAR, "SMCP_LIVE_CALENDAR", "the title of a throwaway calendar") },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "smcp-live-"));
    const eventKit = createEventKit();
    const calendar = await throwaway(eventKit, EVENTS, CALENDAR);
    const registry = createAutoRegistry({ path: join(dir, "history.jsonl") });
    const make = (history) =>
      createCalendarOps({
        eventKit,
        confirm: async (body) => assert.fail(`No window was expected, but one was asked for:\n${body}`),
        autoCalendars: () => [calendar.id],
        registry: history,
      });
    const ops = make(registry);
    const title = `SMCP live test ${Date.now()}`;
    const start = quietHour();
    const end = start + HOUR;
    const source = { kind: "test", ref: "calendar-live.test.js", date: new Date().toISOString().slice(0, 10), quote: "created by SMCP's live test" };
    const request = { title, start, end, calendar: calendar.id, location: "Nowhere", notes: "Safe to delete.", source };
    const mine = async () => (await eventKit.events({ from: start - DAY, to: end + 2 * DAY, calendars: [calendar.id] })).events.filter((event) => event.title.startsWith(title));
    t.after(async () => {
      for (const event of await mine()) await eventKit.deleteEvent({ id: event.id }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    });

    await t.test("the list of calendars marks it as unattended, and it is not the only calendar read", async () => {
      const listed = await ops.calendars.run({});
      assert.equal(listed.find((item) => item.id === calendar.id).unattended, true);
      assert.ok(listed.filter((item) => !item.unattended).every((item) => typeof item.id === "string" && item.id));
      const fallback = await eventKit.defaultCalendar(EVENTS);
      assert.ok(listed.some((item) => item.id === fallback.id), "The default calendar is one of the calendars listed.");
    });

    let created;
    await t.test("it is created without a window, with its source and marker in the notes", async () => {
      const check = await ops.createEvent.run({ ...request, checkOnly: true });
      assert.deepEqual([check.created, check.check_only, check.auto], [false, true, true]);
      assert.deepEqual(await mine(), []);

      created = await ops.createEvent.run(request);
      assert.equal(created.created, true);
      assert.equal(created.auto, true);
      assert.equal(created.calendar, CALENDAR);
      const events = await mine();
      assert.equal(events.length, 1);
      assert.deepEqual(
        { id: events[0].id, title: events[0].title, calendarId: events[0].calendarId, start: events[0].start, end: events[0].end, allDay: events[0].allDay, location: events[0].location, recurring: events[0].recurring },
        { id: created.id, title, calendarId: calendar.id, start, end, allDay: false, location: "Nowhere", recurring: false },
      );
      const whole = await eventKit.getEvent({ id: created.id });
      const notes = splitNotes(whole.notes);
      assert.equal(notes.body, "Safe to delete.");
      assert.equal(notes.marker, created.marker);
      assert.match(whole.notes, /— SMCP —\nSource: test · calendar-live\.test\.js · \d{4}-\d{2}-\d{2}\n"created by SMCP's live test"\n\[smcp:[0-9a-f]{12}\]$/);
    });

    await t.test("the same request again creates nothing, even with an empty history", async () => {
      const again = await ops.createEvent.run(request);
      assert.deepEqual([again.created, again.duplicate, again.event.id], [false, true, created.id]);
      // As on another computer: the event arrived through iCloud, the history did not.
      const elsewhere = make(createAutoRegistry({ path: join(dir, "other-computer.jsonl") }));
      const found = await elsewhere.createEvent.run(request);
      assert.deepEqual([found.created, found.duplicate, found.event.id], [false, true, created.id]);
      assert.equal((await mine()).length, 1);
      const marked = await eventKit.events({ from: start - DAY, to: end + DAY, calendars: [calendar.id], notesContains: `[${created.marker}]` });
      assert.deepEqual(marked.events.map((event) => event.id), [created.id]);
      const other = await eventKit.events({ from: start - DAY, to: end + DAY, calendars: [calendar.id], notesContains: "[smcp:000000000000]" });
      assert.deepEqual(other.events, []);
    });

    let movedId;
    await t.test("it is moved and renamed, keeping its marker, and its own slot is not a conflict", async () => {
      const moved = await ops.updateEvent.run({ id: created.id, start: start + 2 * HOUR, title: `${title} (moved)`, location: "", notes: "Moved.", source: { kind: "test", quote: "moved by the live test" } });
      assert.equal(moved.updated, true);
      assert.equal(moved.auto, true);
      assert.ok(!moved.conflicts.some((event) => event.id === created.id));
      movedId = moved.event.id;
      const events = await mine();
      assert.equal(events.length, 1);
      assert.deepEqual([events[0].start, events[0].end, events[0].title, events[0].location], [start + 2 * HOUR, end + 2 * HOUR, `${title} (moved)`, ""]);
      const notes = splitNotes((await eventKit.getEvent({ id: movedId })).notes);
      assert.equal(notes.body, "Moved.");
      assert.equal(notes.marker, created.marker);
      assert.ok(notes.block.some((line) => /^Changed: \d{4}-\d{2}-\d{2} · test · "moved by the live test"$/.test(line)));

      const wholeDay = await ops.updateEvent.run({ id: movedId, start, allDay: true });
      assert.equal(wholeDay.event.allDay, true);
      const back = await ops.updateEvent.run({ id: wholeDay.event.id, start: start + 2 * HOUR, allDay: false });
      assert.deepEqual([back.event.allDay, back.event.start, back.event.end], [false, start + 2 * HOUR, start + 3 * HOUR]);
      movedId = back.event.id;
    });

    await t.test("it is deleted, the history holds every step, and the plan can be created again", async () => {
      const deleted = await ops.deleteEvent.run({ id: movedId });
      assert.equal(deleted.deleted, true);
      assert.deepEqual(await mine(), []);
      await assert.rejects(eventKit.getEvent({ id: movedId }), (error) => error.code === "NO_EVENT");
      const history = await ops.autoHistory.run({});
      assert.deepEqual(history.map((entry) => entry.action), ["delete", "update", "update", "update", "create"]);
      assert.equal(history[0].before.title, `${title} (moved)`);
      assert.equal(registry.find(created.marker), null);
      const again = await ops.createEvent.run(request);
      assert.equal(again.created, true);
      assert.equal((await ops.deleteEvent.run({ id: again.id })).deleted, true);
    });

    await t.test("one repeat of a repeating event is changed and another deleted, leaving the rest", async (step) => {
      const from = Date.now();
      const repeats = async () =>
        (await eventKit.events({ from, to: from + 60 * DAY, calendars: [calendar.id] })).events.filter((event) => event.title.startsWith(REPEAT_TITLE)).sort((a, b) => a.start - b.start);
      const before = await repeats();
      if (before.length < 4) return step.skip(`Add a weekly event titled "${REPEAT_TITLE}" to "${CALENDAR}" to check repeating events.`);
      const [, second, third] = before.filter((event) => event.recurring && event.title === REPEAT_TITLE);
      assert.ok(third, "The event repeats: at least three untouched repeats are ahead.");
      assert.equal(second.id, third.id, "Every repeat shares one id.");
      assert.equal((await eventKit.getEvent({ id: second.id })).start < second.start, true, "Asking by id alone answers with an earlier repeat.");
      assert.equal((await eventKit.getEvent({ id: second.id, occurrence: second.start })).start, second.start);

      const renamed = await ops.updateEvent.run({ id: second.id, occurrence: second.start, title: `${REPEAT_TITLE} (changed)` });
      assert.deepEqual([renamed.updated, renamed.recurring, renamed.span], [true, true, "this"]);
      const gone = await ops.deleteEvent.run({ id: third.id, occurrence: third.start });
      assert.deepEqual([gone.deleted, gone.recurring, gone.span], [true, true, "this"]);

      const after = await repeats();
      assert.equal(after.length, before.length - 1);
      assert.ok(!after.some((event) => event.start === third.start));
      assert.deepEqual(after.filter((event) => event.title.endsWith("(changed)")).map((event) => event.start), [second.start]);
      await assert.rejects(eventKit.getEvent({ id: second.id, occurrence: second.start + 60_000 }), (error) => error.code === "NO_OCCURRENCE");
    });
  },
);

test(
  "live: a reminder is created, changed, re-opened, loses its due date and is deleted",
  { skip: skipUnless(LIST, "SMCP_LIVE_REMINDERS", "the title of a throwaway Reminders list") },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "smcp-live-"));
    const eventKit = createEventKit();
    const list = await throwaway(eventKit, REMINDERS, LIST);
    const ops = createCalendarOps({ eventKit, confirm: async () => assert.fail("Reminders never use a window."), registry: createAutoRegistry({ path: join(dir, "history.jsonl") }) });
    const title = `SMCP live test ${Date.now()}`;
    const read = async (id) => (await eventKit.reminders({ lists: [list.id], includeCompleted: true })).find((reminder) => reminder.id === id);
    const due = quietHour();
    const created = await ops.createReminder.run({ title, list: list.id, due, dueHasTime: true, notes: "Safe to delete." });
    t.after(async () => {
      await eventKit.deleteReminder({ id: created.id }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    });
    assert.deepEqual(await read(created.id), { id: created.id, title, list: LIST, completed: false, due, dueHasTime: true, priority: 0, notes: "Safe to delete." });

    const changed = await ops.updateReminder.run({ id: created.id, title: `${title} (changed)`, due: due + DAY, dueHasTime: false, notes: "" });
    assert.deepEqual([changed.title, changed.dueHasTime, changed.notes], [`${title} (changed)`, false, ""]);
    assert.equal(new Date(changed.due).getDate(), new Date(due + DAY).getDate());
    assert.deepEqual(await read(created.id), changed);

    assert.equal((await ops.completeReminder.run({ id: created.id })).completed, true);
    assert.equal((await read(created.id)).completed, true);
    assert.equal((await ops.updateReminder.run({ id: created.id, completed: false })).completed, false);
    assert.equal((await read(created.id)).completed, false);

    const cleared = await ops.updateReminder.run({ id: created.id, due: null });
    assert.equal(cleared.due, null);
    assert.equal((await read(created.id)).due, null);

    assert.deepEqual(await ops.deleteReminder.run({ id: created.id }), { deleted: true, id: created.id, title: `${title} (changed)` });
    assert.equal(await read(created.id), undefined);
    await assert.rejects(ops.deleteReminder.run({ id: created.id }), /no longer exists/);
  },
);

test(
  "live: Contacts answers a search by name with the expected shape",
  { skip: skipUnless(PERSON, "SMCP_LIVE_CONTACTS", "a name that is in Contacts") },
  async () => {
    const contacts = createContacts();
    const found = await contacts.search({ query: PERSON, limit: 5 });
    assert.ok(found.length >= 1 && found.length <= 5, `Expected one to five contacts for that name, found ${found.length}.`);
    for (const contact of found) {
      assert.deepEqual(Object.keys(contact), ["name", "organization", "phones", "emails", "birthday"]);
      assert.equal(typeof contact.name, "string");
      assert.ok(contact.phones.every((phone) => typeof phone.label === "string" && phone.number));
      assert.ok(contact.emails.every((email) => typeof email.label === "string" && email.address.includes("@")));
      assert.ok(contact.birthday === null || /^(\d{4}-)?\d{2}-\d{2}$/.test(contact.birthday));
    }
    // An address or a number from the first match finds it again through its own matcher.
    const [first] = found;
    if (first.emails[0]) assert.ok((await contacts.search({ query: first.emails[0].address })).some((contact) => contact.name === first.name));
    if (first.phones[0] && queryKind(first.phones[0].number) === "phone") assert.ok((await contacts.search({ query: first.phones[0].number })).some((contact) => contact.name === first.name));
    assert.deepEqual(await contacts.search({ query: `nobody-${Date.now()}` }), []);
  },
);
