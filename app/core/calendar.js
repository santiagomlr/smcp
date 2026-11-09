// Reads the Mac's Calendar through EventKit, which already merges every account and expands repeats.
import { run } from "../../src/util.js";

const PRELUDE = `
ObjC.import("Foundation");
ObjC.import("EventKit");
const FULL_ACCESS = 3;
const status = () => Number($.EKEventStore.authorizationStatusForEntityType(0));
`;

const SCRIPTS = {
  status: `function main() { return { status: status() }; }`,
  request: `
function main() {
  const store = $.EKEventStore.alloc.init;
  let finished = false;
  store.requestFullAccessToEventsWithCompletion((granted) => { finished = true; });
  for (let i = 0; i < 300 && !finished; i++) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
  }
  return { status: status() };
}`,
  events: `
function main(a) {
  if (status() !== FULL_ACCESS) return { status: status(), events: [] };
  const store = $.EKEventStore.alloc.init;
  const start = $.NSDate.dateWithTimeIntervalSince1970(a.from / 1000);
  const end = $.NSDate.dateWithTimeIntervalSince1970(a.to / 1000);
  const found = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(start, end, $()));
  const events = [];
  for (let i = 0; i < found.count && events.length < 2000; i++) {
    const e = found.objectAtIndex(i);
    events.push({
      title: e.title.js || "",
      calendar: e.calendar.title.js || "",
      start: Number(e.startDate.timeIntervalSince1970) * 1000,
      end: Number(e.endDate.timeIntervalSince1970) * 1000,
      allDay: Boolean(e.allDay),
    });
  }
  return { status: status(), events };
}`,
};

async function call(name, params = {}, timeoutMs = 20_000) {
  const body = `${PRELUDE}${SCRIPTS[name]}
function run(argv) { return JSON.stringify(main(JSON.parse(argv[0]))); }`;
  const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", body, JSON.stringify(params)], { timeoutMs });
  if (result.code !== 0 || result.timedOut) throw new Error("Could not read this Mac's Calendar.");
  return JSON.parse(result.stdout);
}

const describe = (code) => ({ 0: "ask", 1: "restricted", 2: "denied", 3: "granted", 4: "writeOnly" })[code] ?? "ask";

export async function calendarStatus() {
  return describe((await call("status")).status);
}

export async function requestCalendar() {
  return describe((await call("request", {}, 70_000)).status);
}

export async function calendarEvents({ from, to }) {
  const result = await call("events", { from: Number(from), to: Number(to) });
  return { status: describe(result.status), events: result.events };
}
