import { z } from "zod";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, textResult } from "../util.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 92;
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
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { notes: event.notes } : {}),
  };
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
  const calendarIds = z.array(z.string().max(200)).max(50).optional().describe("Calendar ids from calendar_list_calendars. Without it, every calendar.");

  server.registerTool(
    "calendar_list_calendars",
    { description: "Lists the calendars on this Mac (iCloud, Google, Exchange…), with their ids and whether they can be written.", annotations: reads },
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
        "Adds an event to a calendar. Opens a macOS window and adds it only if the person presses Add. Without `calendar`, uses the default calendar.",
      inputSchema: {
        title: z.string().min(1).max(200),
        start: when.describe("ISO date and time, or YYYY-MM-DD for an all-day event."),
        end: when.optional().describe("By default, one hour after the start, or the same day for an all-day event."),
        calendar: z.string().max(200).optional().describe("Calendar id from calendar_list_calendars."),
        location: z.string().max(300).optional(),
        notes: z.string().max(2000).optional(),
      },
      annotations: writes,
    },
    safe(async ({ title, start, end, calendar, location, notes }) => {
      const allDay = DATE_ONLY.test(start.trim());
      const startTime = parseWhen(start);
      const endTime = end ? parseWhen(end, { endOfDay: allDay }) : allDay ? startTime + DAY_MS : startTime + 60 * 60 * 1000;
      if (endTime <= startTime) throw new Error("The end must be after the start.");
      // All-day events end at midnight, but EventKit wants the last instant of the last day.
      return call(
        "createEvent",
        { title, start: startTime, end: allDay ? endTime - 1000 : endTime, allDay, calendar, location, notes },
        { timeoutMs: 200_000 },
      );
    }, textResult),
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
    "reminders_complete",
    {
      description: "Marks an Apple Reminder as done.",
      inputSchema: { id: z.string().min(1).max(300).describe("Reminder id from reminders_list.") },
      annotations: writes,
    },
    safe(({ id }) => call("completeReminder", { id }), textResult),
  );
}
