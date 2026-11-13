import { z } from "zod";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, textResult } from "../util.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 92;
/** Long enough for the person to read the confirmation window and answer it. */
const CONFIRM_TIMEOUT_MS = 200_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Calendar access belongs to SMCP.app, so these always go through it. */
function callApp(op, args, options) {
  return viaHelper("calendar", { op, args }, () => {
    throw new Error("Open the SMCP app to use Calendar and Reminders.");
  }, options);
}

/**
 * A date (YYYY-MM-DD, local midnight) or a full ISO date and time. With `endOfDay`, a bare date
 * means the end of that day, so `to: 2026-11-10` includes the 10th.
 */
export function parseWhen(value, { endOfDay = false } = {}) {
  const text = String(value ?? "").trim();
  const day = DATE_ONLY.exec(text);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    const parsed = new Date(year, month, date);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== date) throw new Error(`Not a valid date: ${text}`);
    return endOfDay ? new Date(year, month, date + 1).getTime() : parsed.getTime();
  }
  const time = Date.parse(text);
  if (!text || Number.isNaN(time)) throw new Error(`Not a valid date: ${text || "(empty)"}. Use YYYY-MM-DD or an ISO date and time.`);
  return time;
}

export function startOfDay(time) {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local time with its offset, which the AI reads more reliably than UTC. */
export function formatLocal(time) {
  const date = new Date(time);
  const pad = (n) => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

export function formatDay(time) {
  return formatLocal(time).slice(0, 10);
}

/** Resolves a from/to pair with defaults and a sane size. */
export function range({ from, to }, { defaultDays = 7, now = Date.now() } = {}) {
  const start = from ? parseWhen(from) : startOfDay(now);
  const end = to ? parseWhen(to, { endOfDay: true }) : start + defaultDays * DAY_MS;
  if (end <= start) throw new Error("`to` must be after `from`.");
  if (end - start > MAX_RANGE_DAYS * DAY_MS) throw new Error(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
  return { start, end };
}

export function presentEvent(event) {
  return {
    id: event.id,
    title: event.title,
    calendar: event.calendar,
    start: event.allDay ? formatDay(event.start) : formatLocal(event.start),
    end: event.allDay ? formatDay(event.end - 1) : formatLocal(event.end),
    all_day: event.allDay,
    ...(event.calendarId ? { calendar_id: event.calendarId } : {}),
    ...(event.recurring ? { recurring: true } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { notes: event.notes } : {}),
  };
}

const showTime = (time, allDay, { end = false } = {}) => (allDay ? formatDay(end ? time - 1 : time) : formatLocal(time));

/** What a write returns, with its times, its event and the events already in that slot made readable. */
export function presentWrite({ calendarId, event, conflicts, ...rest }) {
  return {
    ...rest,
    ...(calendarId ? { calendar_id: calendarId } : {}),
    ...(event ? { event: presentEvent(event) } : {}),
    ...(conflicts ? { conflicts: conflicts.map((item) => ({ ...item, start: formatLocal(item.start), end: formatLocal(item.end) })) } : {}),
  };
}

/** One line of the history of unattended writes; `before` holds what to put back to undo it. */
export function presentHistory({ eventId, calendarId, allDay, start, end, before, ...rest }) {
  const times = (item, wholeDay) => ({
    ...(Number.isFinite(item.start) ? { start: showTime(item.start, wholeDay) } : {}),
    ...(Number.isFinite(item.end) ? { end: showTime(item.end, wholeDay, { end: true }) } : {}),
  });
  const previous = () => {
    const { eventId: oldId, calendarId: oldCalendar, allDay: oldAllDay, start: oldStart, end: oldEnd, id, ...other } = before;
    const wholeDay = oldAllDay ?? allDay;
    return {
      ...other,
      ...(id ?? oldId ? { event_id: id ?? oldId } : {}),
      ...(oldCalendar ? { calendar_id: oldCalendar } : {}),
      ...times({ start: oldStart, end: oldEnd }, wholeDay),
      ...(oldAllDay === undefined ? {} : { all_day: oldAllDay }),
    };
  };
  return {
    ...rest,
    event_id: eventId ?? null,
    calendar_id: calendarId ?? null,
    ...times({ start, end }, allDay),
    all_day: allDay === true,
    ...(before && typeof before === "object" ? { before: previous() } : {}),
  };
}

/** `start`, `end` and `allDay` for EventKit, from the dates the AI sent. All-day events end at the last instant of the last day. */
function eventTimes({ start, end }, { fill }) {
  const allDay = start ? DATE_ONLY.test(start.trim()) : undefined;
  const startTime = start ? parseWhen(start) : undefined;
  let endTime;
  // Without a start, a bare end date means "through that day".
  if (end) endTime = allDay ?? DATE_ONLY.test(end.trim()) ? parseWhen(end, { endOfDay: true }) - 1000 : parseWhen(end);
  else if (fill) endTime = allDay ? startTime + DAY_MS - 1000 : startTime + 60 * 60 * 1000;
  if (startTime !== undefined && endTime !== undefined && endTime <= startTime) throw new Error("The end must be after the start.");
  return { start: startTime, end: endTime, allDay };
}

function atClock(day, clock) {
  const [, hours, minutes] = CLOCK.exec(clock);
  const date = new Date(day);
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date.getTime();
}

/**
 * Free gaps inside working hours. All-day events (birthdays, holidays, "out of office" markers)
 * do not block time; anything with a start and end does. Pure, so it is tested without a calendar.
 */
export function freeSlots(events, { start, end, dayStart = "09:00", dayEnd = "18:00", minMinutes = 30, weekends = false, now = Date.now() }) {
  if (!CLOCK.test(dayStart) || !CLOCK.test(dayEnd)) throw new Error("Working hours use HH:MM, for example 09:00.");
  const busy = events
    .filter((event) => !event.allDay && event.end > event.start)
    .map((event) => [event.start, event.end])
    .sort((a, b) => a[0] - b[0]);
  const slots = [];
  for (let day = startOfDay(start); day < end; day = startOfDay(day + DAY_MS + 2 * 60 * 60 * 1000)) {
    const weekday = new Date(day).getDay();
    if (!weekends && (weekday === 0 || weekday === 6)) continue;
    let cursor = Math.max(atClock(day, dayStart), start, now);
    const close = Math.min(atClock(day, dayEnd), end);
    for (const [busyStart, busyEnd] of busy) {
      if (busyEnd <= cursor || busyStart >= close) continue;
      if (busyStart - cursor >= minMinutes * 60_000) slots.push([cursor, busyStart]);
      cursor = Math.max(cursor, busyEnd);
    }
    if (close - cursor >= minMinutes * 60_000) slots.push([cursor, close]);
  }
  return slots.map(([from, to]) => ({ start: formatLocal(from), end: formatLocal(to), minutes: Math.round((to - from) / 60_000) }));
}

export function presentReminder(reminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    list: reminder.list,
    completed: reminder.completed,
    due: reminder.due === null ? null : reminder.dueHasTime ? formatLocal(reminder.due) : formatDay(reminder.due),
    ...(reminder.priority ? { priority: reminder.priority } : {}),
    ...(reminder.notes ? { notes: reminder.notes } : {}),
  };
}

/** Today's events, for the daily brief. */
export async function eventsBetween(start, end, call = callApp) {
  const { events } = await call("events", { from: start, to: end });
  return events.sort((a, b) => a.start - b.start).map(presentEvent);
}

export async function remindersDue(until, call = callApp) {
  const reminders = await call("reminders", {});
  return reminders
    .filter((reminder) => reminder.due !== null && reminder.due < until)
    .sort((a, b) => a.due - b.due)
    .map(presentReminder);
}

export function registerCalendar(server, { call = callApp } = {}) {
  const reads = { readOnlyHint: true, openWorldHint: false };
  const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  const safe = (fn, wrap = externalResult) => async (args) => {
    try {
      return wrap(await fn(args ?? {}));
    } catch (error) {
      return errorResult(error.message);
    }
  };
  const when = z.string().max(40);
  const source = z
    .object({
      kind: z.string().min(1).max(40).describe("Where the plan was confirmed: whatsapp, email, call…"),
      ref: z.string().max(200).optional().describe("The chat, thread or person."),
      date: z.string().max(40).optional().describe("When it was confirmed."),
      quote: z.string().max(300).optional().describe("The few words that confirm it."),
    })
    .optional();
  const eventId = z.string().min(1).max(300).describe("Event id from calendar_list_events.");
  const occurrence = when.optional().describe("For a repeating event, the `start` of the repeat to act on, as calendar_list_events shows it. Without it, the first one.");
  const span = z.enum(["this", "future"]).default("this").describe("For a repeating event: only this one, or this and the ones after it.");
  const target = ({ id, occurrence_start, span: reach }) => ({ id, occurrence: occurrence_start ? parseWhen(occurrence_start) : undefined, span: reach });
  const calendarIds = z.array(z.string().max(200)).max(50).optional().describe("Calendar ids from calendar_list_calendars. Without it, every calendar.");

  server.registerTool(
    "calendar_list_calendars",
    {
      description:
        "Lists the calendars on this Mac (iCloud, Google, Exchange…), with their ids and whether they can be written. `unattended` marks the ones the person chose for writing without the confirmation window.",
      annotations: reads,
    },
    safe(() => call("calendars", {}), textResult),
  );

  server.registerTool(
    "calendar_list_events",
    {
      description:
        "Lists events between two dates, from every account on this Mac, with repeats expanded. Dates are YYYY-MM-DD or ISO date and time. By default, today and the next 6 days.",
      inputSchema: {
        from: when.optional(),
        to: when.optional().describe("A bare date includes that whole day."),
        query: z.string().max(200).optional().describe("Keeps only events whose title, location or notes contain this."),
        calendars: calendarIds,
      },
      annotations: reads,
    },
    safe(async ({ from, to, query, calendars }) => {
      const { start, end } = range({ from, to });
      const { events } = await call("events", { from: start, to: end, calendars });
      const wanted = query?.trim().toLowerCase();
      const matching = wanted
        ? events.filter((event) => [event.title, event.location, event.notes].some((text) => text?.toLowerCase().includes(wanted)))
        : events;
      return { from: formatLocal(start), to: formatLocal(end), events: matching.sort((a, b) => a.start - b.start).map(presentEvent) };
    }),
  );

  server.registerTool(
    "calendar_free_slots",
    {
      description:
        "Finds free time between two dates inside working hours. All-day events do not block time. By default, the next 7 days, 09:00 to 18:00, weekdays, gaps of 30 minutes or more.",
      inputSchema: {
        from: when.optional(),
        to: when.optional(),
        day_start: z.string().regex(CLOCK).default("09:00"),
        day_end: z.string().regex(CLOCK).default("18:00"),
        min_minutes: z.number().int().min(5).max(24 * 60).default(30),
        include_weekends: z.boolean().default(false),
        calendars: calendarIds,
      },
      annotations: reads,
    },
    safe(async ({ from, to, day_start, day_end, min_minutes, include_weekends, calendars }) => {
      const { start, end } = range({ from, to });
      const { events } = await call("events", { from: start, to: end, calendars });
      return {
        slots: freeSlots(events, { start, end, dayStart: day_start, dayEnd: day_end, minMinutes: min_minutes, weekends: include_weekends }),
      };
    }, textResult),
  );

  server.registerTool(
    "calendar_create_event",
    {
      description:
        "Adds an event to a calendar and reports, in `conflicts`, the events already in that time slot. Opens a confirmation and adds it only if the person accepts, " +
        "unless the calendar is one the person chose for unattended writing (see calendar_list_calendars): there it is added at once, `source` is required, " +
        "and the same call twice creates it once. Without `calendar`, uses the default calendar.",
      inputSchema: {
        title: z.string().min(1).max(200),
        start: when.describe("ISO date and time, or YYYY-MM-DD for an all-day event."),
        end: when.optional().describe("By default, one hour after the start, or the same day for an all-day event."),
        calendar: z.string().max(200).optional().describe("Calendar id from calendar_list_calendars."),
        location: z.string().max(300).optional(),
        notes: z.string().max(2000).optional(),
        source: source.describe("Where the plan was confirmed. Required for unattended calendars; it is written in the event's notes."),
        key: z.string().max(200).optional().describe("A stable id for this plan, such as the message id. The same key never creates a second event."),
        check_only: z.boolean().default(false).describe("Only report the events already in that slot; adds nothing."),
        recreate: z.boolean().default(false).describe("Adds the event again after the person removed it from the calendar by hand. Only when they ask for it back."),
      },
      annotations: writes,
    },
    safe(async ({ title, start, end, calendar, location, notes, source: origin, key, check_only, recreate }) =>
      presentWrite(
        await call(
          "createEvent",
          { title, ...eventTimes({ start, end }, { fill: true }), calendar, location, notes, source: origin, key, checkOnly: check_only === true, recreate: recreate === true },
          { timeoutMs: CONFIRM_TIMEOUT_MS },
        ),
      ),
    ),
  );

  server.registerTool(
    "calendar_update_event",
    {
      description:
        "Changes an event: only the fields given. A new `start` alone keeps its length; an empty `location` or `notes` clears it; `calendar` moves it. " +
        "Reports in `conflicts` the events already in the new slot. Opens a confirmation, unless the event stays inside calendars the person chose for unattended writing.",
      inputSchema: {
        id: eventId,
        occurrence_start: occurrence,
        title: z.string().min(1).max(200).optional(),
        start: when.optional().describe("ISO date and time, or YYYY-MM-DD to make it an all-day event."),
        end: when.optional(),
        calendar: z.string().max(200).optional().describe("Calendar id to move it to, from calendar_list_calendars."),
        location: z.string().max(300).optional(),
        notes: z.string().max(2000).optional(),
        span,
        source: source.describe("Where the change was confirmed. In unattended calendars it is added to the event's notes."),
      },
      annotations: writes,
    },
    safe(async ({ title, start, end, calendar, location, notes, source: origin, ...which }) =>
      presentWrite(
        await call(
          "updateEvent",
          { ...target(which), title, ...eventTimes({ start, end }, { fill: false }), calendar, location, notes, source: origin },
          { timeoutMs: CONFIRM_TIMEOUT_MS },
        ),
      ),
    ),
  );

  server.registerTool(
    "calendar_delete_event",
    {
      description:
        "Deletes an event. Opens a confirmation, unless it is in a calendar the person chose for unattended writing; those deletions stay in calendar_auto_history.",
      inputSchema: { id: eventId, occurrence_start: occurrence, span },
      annotations: writes,
    },
    safe(async (which) => presentWrite(await call("deleteEvent", target(which), { timeoutMs: CONFIRM_TIMEOUT_MS }))),
  );

  server.registerTool(
    "calendar_auto_history",
    {
      description:
        "Lists what SMCP wrote to calendars without the confirmation window, newest first: events created, changed and deleted, with where each plan came from. " +
        "`before` holds the earlier values; to undo, put them back with calendar_update_event, calendar_delete_event or calendar_create_event.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50),
        since: when.optional().describe("Only what happened from this date on."),
      },
      annotations: reads,
    },
    safe(async ({ limit, since }) => {
      const entries = await call("autoHistory", { limit, since: since ? parseWhen(since) : undefined });
      return { total: entries.length, entries: entries.map(presentHistory) };
    }),
  );

  server.registerTool(
    "reminders_list_lists",
    { description: "Lists the Apple Reminders lists, with their ids.", annotations: reads },
    safe(() => call("reminderLists", {}), textResult),
  );

  server.registerTool(
    "reminders_list",
    {
      description: "Lists Apple Reminders. By default only pending ones, from every list, soonest due first.",
      inputSchema: {
        lists: z.array(z.string().max(200)).max(50).optional().describe("List ids from reminders_list_lists."),
        include_completed: z.boolean().default(false),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: reads,
    },
    safe(async ({ lists, include_completed, query, limit }) => {
      const reminders = await call("reminders", { lists, includeCompleted: include_completed });
      const wanted = query?.trim().toLowerCase();
      const matching = wanted ? reminders.filter((r) => `${r.title} ${r.notes}`.toLowerCase().includes(wanted)) : reminders;
      matching.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
      return { total: matching.length, reminders: matching.slice(0, limit).map(presentReminder) };
    }),
  );

  server.registerTool(
    "reminders_create",
    {
      description: "Creates an Apple Reminder. `due` is YYYY-MM-DD, or an ISO date and time for an alert at that time.",
      inputSchema: {
        title: z.string().min(1).max(300),
        list: z.string().max(200).optional().describe("List id from reminders_list_lists. Without it, the default list."),
        due: when.optional(),
        notes: z.string().max(5000).optional(),
      },
      annotations: writes,
    },
    safe(({ title, list, due, notes }) =>
      call("createReminder", { title, list, notes, due: due ? parseWhen(due) : null, dueHasTime: Boolean(due) && !DATE_ONLY.test(due.trim()) }),
    textResult),
  );

  server.registerTool(
    "reminders_update",
    {
      description: "Changes an Apple Reminder: only the fields given. `completed: false` re-opens one that was done.",
      inputSchema: {
        id: z.string().min(1).max(300).describe("Reminder id from reminders_list."),
        title: z.string().min(1).max(300).optional(),
        list: z.string().max(200).optional().describe("List id to move it to, from reminders_list_lists."),
        due: when.optional().describe("YYYY-MM-DD, or an ISO date and time for an alert at that time."),
        clear_due: z.boolean().default(false).describe("Takes the due date away."),
        notes: z.string().max(5000).optional().describe("An empty text clears them."),
        completed: z.boolean().optional(),
      },
      annotations: writes,
    },
    safe(async ({ id, title, list, due, clear_due, notes, completed }) => {
      if (due && clear_due) throw new Error("Pass `due` or `clear_due`, not both.");
      const reminder = await call("updateReminder", {
        id,
        title,
        list,
        notes,
        completed,
        due: clear_due ? null : due ? parseWhen(due) : undefined,
        dueHasTime: Boolean(due) && !DATE_ONLY.test(due.trim()),
      });
      return reminder?.id ? presentReminder(reminder) : reminder;
    }),
  );

  server.registerTool(
    "reminders_complete",
    {
      description: "Marks an Apple Reminder as done.",
      inputSchema: { id: z.string().min(1).max(300).describe("Reminder id from reminders_list.") },
      annotations: writes,
    },
    safe(({ id }) => call("completeReminder", { id }), textResult),
  );

  server.registerTool(
    "reminders_delete",
    {
      description: "Deletes an Apple Reminder for good. To mark it as done instead, use reminders_complete.",
      inputSchema: { id: z.string().min(1).max(300).describe("Reminder id from reminders_list.") },
      annotations: writes,
    },
    safe(({ id }) => call("deleteReminder", { id })),
  );
}
