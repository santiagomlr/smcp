// Checks, on a real Mac, the parts of SMCP that cannot be tested anywhere else: the scripts that talk
// to Calendar, Reminders and Contacts; the approval page through Tailscale; and the Gmail export
// against a real account. It prints one PASS or FAIL line per check and a summary to paste back.
//
// Run it from a clone of this repository with the Node that the installed SMCP carries:
//
//   ELECTRON_RUN_AS_NODE=1 /Applications/SMCP.app/Contents/MacOS/SMCP scripts/verify-on-mac.mjs
//
// What it touches, and nothing else:
//  - Calendar and Reminders: it creates a calendar and a list named "SMCP verify (safe to delete)",
//    works only inside them, and deletes both at the end.
//  - Contacts: one search by your first name. It prints how many it found, never who.
//  - Tailscale: after asking, it shares a test page on port 47826 inside your tailnet and removes it
//    at the end. The page holds one fake request; approving it sends nothing.
//  - Gmail: optional. It asks for an account and an app password (not shown, not saved), exports
//    into a temporary copy of that account's folder and never writes to your vault.
//
// Options: --vault <folder> (default ~/Server/brain), --only calendar,reminders,contacts,tailscale,gmail,
// --skip <same names>, --own-name <first name for the Contacts search>.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THROWAWAY = "SMCP verify (safe to delete)";
const INSTALLED_MODULES = "/Applications/SMCP.app/Contents/Resources/app/node_modules";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SECTIONS = ["calendar", "reminders", "contacts", "tailscale", "gmail"];

/* Reporting */

const results = [];
const MARK = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP", INFO: "INFO" };

export function note(status, name, detail = "") {
  results.push({ status, name, detail });
  console.log(`  ${MARK[status]}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Runs one check. A failure is recorded and the rest carry on. Returns whether it passed. */
export async function check(name, fn) {
  try {
    note("PASS", name, (await fn()) ?? "");
    return true;
  } catch (error) {
    note("FAIL", name, String(error?.message ?? error).split("\n").slice(0, 3).join(" | "));
    return false;
  }
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const section = (title) => console.log(`\n${title}`);
const near = (a, b) => Math.abs(a - b) < 2000;

/* Asking the person */

function ask(question) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => reader.question(question, (answer) => (reader.close(), resolve(answer.trim()))));
}

/** Reads a line without showing it. Falls back to a visible prompt when there is no terminal. */
function askHidden(question) {
  if (!process.stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (char === "\u0003") process.exit(130);
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

/* Calendar */

function quietHour(daysAhead = 1) {
  const at = new Date();
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + daysAhead, 3, 0, 0, 0).getTime();
}

/**
 * Everything the calendar tools do, against one throwaway calendar: writing without the window, the
 * mark that prevents duplicates, clashes, moving, deleting and the history.
 */
export async function checkCalendar({ eventKit, createCalendarOps, createAutoRegistry, splitNotes, calendar, historyDir }) {
  let windows = 0;
  const confirm = async () => {
    windows += 1;
    return false;
  };
  const registry = createAutoRegistry({ path: join(historyDir, "history.jsonl") });
  const ops = createCalendarOps({ eventKit, confirm, autoCalendars: () => [calendar.id], registry });
  const stamp = Date.now();
  const title = `SMCP verify ${stamp}`;
  const start = quietHour();
  const end = start + HOUR;
  const source = { kind: "test", ref: "verify-on-mac", date: new Date().toISOString().slice(0, 10), quote: "created by SMCP's check" };
  const request = { title, start, end, calendar: calendar.id, location: "Nowhere", notes: "Safe to delete.", source };
  const mine = async () => (await eventKit.events({ from: start - DAY, to: end + 3 * DAY, calendars: [calendar.id] })).events.filter((event) => event.title.includes(String(stamp)));
  let created = null;

  await check("calendar: the list marks the calendar as written without the window", async () => {
    const listed = await ops.calendars.run({});
    expect(listed.find((item) => item.id === calendar.id)?.unattended === true, "the throwaway calendar is not marked unattended");
    expect(listed.length >= 1 && listed.every((item) => typeof item.id === "string" && item.id), "a calendar came back without an id");
    return `${listed.length} calendars read`;
  });

  await check("calendar: check_only reports and adds nothing", async () => {
    const result = await ops.createEvent.run({ ...request, checkOnly: true });
    expect(result.created === false && result.check_only === true && result.auto === true, JSON.stringify(result));
    expect((await mine()).length === 0, "an event was added by a check");
  });

  await check("calendar: an event is added without the window, with its source and mark in the notes", async () => {
    created = await ops.createEvent.run(request);
    expect(created.created === true && created.auto === true && created.id && created.marker, JSON.stringify(created));
    const saved = await eventKit.getEvent({ id: created.id });
    expect(saved.title === title, `title came back as "${saved.title}"`);
    expect(near(saved.start, start) && near(saved.end, end), "the times came back different");
    expect(saved.location === "Nowhere", "the location was not saved");
    expect(saved.calendarId === calendar.id, "it was saved in another calendar");
    const notes = splitNotes(saved.notes);
    expect(notes.marker === created.marker, `the mark in the notes is ${notes.marker}, expected ${created.marker}`);
    expect(notes.body === "Safe to delete.", `the caller's notes came back as "${notes.body}"`);
    expect(saved.notes.includes("Source: test"), "the source line is missing from the notes");
    expect(windows === 0, "a confirmation window was asked for");
  });

  await check("calendar: the mark is found by searching the calendar's notes", async () => {
    const { events } = await eventKit.events({ from: start - DAY, to: end + DAY, calendars: [calendar.id], notesContains: `[${created.marker}]` });
    expect(events.length === 1 && events[0].id === created.id, `found ${events.length} events with the mark`);
  });

  await check("calendar: the same call twice adds one event", async () => {
    const again = await ops.createEvent.run(request);
    expect(again.created === false && again.duplicate === true && again.event?.id === created.id, JSON.stringify(again));
    expect((await mine()).length === 1, "there are two events now");
  });

  await check("calendar: with the history lost, the mark in the notes still prevents a duplicate", async () => {
    const fresh = createCalendarOps({ eventKit, confirm, autoCalendars: () => [calendar.id], registry: createAutoRegistry({ path: join(historyDir, "empty.jsonl") }) });
    const again = await fresh.createEvent.run(request);
    expect(again.created === false && again.duplicate === true, JSON.stringify(again));
    expect((await mine()).length === 1, "there are two events now");
  });

  let second = null;
  await check("calendar: a clash with an existing event is reported, and the event is still added", async () => {
    second = await ops.createEvent.run({ ...request, title: `${title} second`, start: start + 30 * 60_000, end: end + 30 * 60_000, key: `verify-${stamp}-second` });
    expect(second.created === true, JSON.stringify(second));
    expect(second.conflicts.some((event) => event.id === created.id), `conflicts: ${JSON.stringify(second.conflicts)}`);
  });

  await check("calendar: an event is moved and its notes changed, keeping the mark", async () => {
    const moved = await ops.updateEvent.run({ id: created.id, start: start + 2 * HOUR, end: end + 2 * HOUR, notes: "Moved by the check.", source: { ...source, quote: "moved" } });
    expect(moved.updated === true && moved.auto === true, JSON.stringify(moved));
    const saved = await eventKit.getEvent({ id: moved.event.id });
    expect(near(saved.start, start + 2 * HOUR), "the start did not move");
    const notes = splitNotes(saved.notes);
    expect(notes.marker === created.marker, "the mark was lost");
    expect(notes.body === "Moved by the check.", `the notes came back as "${notes.body}"`);
    created.id = moved.event.id;
  });

  await check("calendar: location and notes can be cleared", async () => {
    const cleared = await ops.updateEvent.run({ id: created.id, location: "", notes: "" });
    expect(cleared.updated === true, JSON.stringify(cleared));
    const saved = await eventKit.getEvent({ id: created.id });
    expect(saved.location === "", `the location is still "${saved.location}"`);
    expect(splitNotes(saved.notes).marker === created.marker, "the mark was lost when the notes were cleared");
  });

  await check("calendar: events are deleted, and reading a deleted one says it is gone", async () => {
    for (const id of [created.id, second?.id].filter(Boolean)) {
      const result = await ops.deleteEvent.run({ id });
      expect(result.deleted === true && result.auto === true, JSON.stringify(result));
    }
    const gone = await eventKit.getEvent({ id: created.id }).then(
      () => null,
      (error) => error,
    );
    expect(gone?.code === "NO_EVENT", `reading it gave: ${gone ? gone.message : "the event, still there"}`);
    expect((await mine()).length === 0, "an event is still in the calendar");
  });

  await check("calendar: an event removed by hand is not brought back", async () => {
    const byHand = { ...request, title: `${title} by hand`, key: `verify-${stamp}-hand` };
    const first = await ops.createEvent.run(byHand);
    await eventKit.deleteEvent({ id: first.id });
    const again = await ops.createEvent.run(byHand);
    expect(again.created === false && again.removed_by_person === true, JSON.stringify(again));
    expect((await mine()).length === 0, "the event came back");
  });

  await check("calendar: an all-day event keeps its day", async () => {
    const day = new Date(quietHour(2));
    const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const allDay = await ops.createEvent.run({ ...request, title: `${title} all day`, start: from, end: from + DAY - 1000, allDay: true, key: `verify-${stamp}-day` });
    expect(allDay.created === true, JSON.stringify(allDay));
    const saved = await eventKit.getEvent({ id: allDay.id });
    expect(saved.allDay === true, "it was not saved as an all-day event");
    expect(new Date(saved.start).getDate() === day.getDate(), "it landed on another day");
    await ops.deleteEvent.run({ id: allDay.id });
  });

  await check("calendar: every change made without the window is in the history", async () => {
    const history = registry.history({ limit: 50 });
    const actions = history.map((entry) => entry.action);
    for (const action of ["create", "update", "delete"]) expect(actions.includes(action), `no "${action}" in the history`);
    expect(history.find((entry) => entry.action === "delete")?.before?.title, "a delete was recorded without the event from before");
    return `${history.length} entries`;
  });

  await check("calendar: a calendar that was not chosen asks first, and a no adds nothing", async () => {
    const before = windows;
    const asking = createCalendarOps({ eventKit, confirm, autoCalendars: () => [], registry });
    const result = await asking.createEvent.run({ ...request, title: `${title} asked` });
    expect(windows === before + 1, "no confirmation was asked for");
    expect(result.created === false && result.auto === false, JSON.stringify(result));
    expect((await mine()).length === 0, "the event was added without a yes");
  });

  for (const event of await mine().catch(() => [])) await eventKit.deleteEvent({ id: event.id }).catch(() => {});
}

/* Reminders */

export async function checkReminders({ eventKit, ops, list }) {
  const title = `SMCP verify ${Date.now()}`;
  const due = quietHour();
  let id = null;
  const find = async (includeCompleted = false) => (await ops.reminders.run({ lists: [list.id], includeCompleted })).find((reminder) => reminder.id === id);

  await check("reminders: one is created with a due time and read back", async () => {
    const made = await ops.createReminder.run({ title, list: list.id, notes: "Safe to delete.", due, dueHasTime: true });
    expect(made.id, JSON.stringify(made));
    id = made.id;
    const saved = await find();
    expect(saved?.title === title, "it was not found in the list");
    expect(saved.dueHasTime === true && near(saved.due, due), `the due time came back as ${saved.due}`);
  });
  if (!id) return;

  await check("reminders: the title and notes are changed", async () => {
    const result = await ops.updateReminder.run({ id, title: `${title} changed`, notes: "Changed." });
    expect(result.title === `${title} changed`, JSON.stringify(result));
    expect((await find())?.notes === "Changed.", "the notes did not change");
  });

  await check("reminders: the due date is moved to a day with no time, then removed", async () => {
    const day = quietHour(3);
    const moved = await ops.updateReminder.run({ id, due: day, dueHasTime: false });
    expect(moved.dueHasTime === false && new Date(moved.due).getDate() === new Date(day).getDate(), JSON.stringify(moved));
    const cleared = await ops.updateReminder.run({ id, due: null });
    expect(cleared.due === null, `the due date is still ${cleared.due}`);
  });

  await check("reminders: it is completed and opened again", async () => {
    await ops.completeReminder.run({ id });
    expect((await find(true))?.completed === true, "it does not show as completed");
    expect(!(await find(false)), "a completed reminder is still listed as pending");
    const reopened = await ops.updateReminder.run({ id, completed: false });
    expect(reopened.completed === false, JSON.stringify(reopened));
  });

  await check("reminders: it is deleted", async () => {
    const result = await ops.deleteReminder.run({ id });
    expect(result.deleted === true, JSON.stringify(result));
    expect(!(await find(true)), "it is still in the list");
    const again = await ops.deleteReminder.run({ id }).then(
      () => null,
      (error) => error,
    );
    expect(again, "deleting it twice did not fail");
  });
}

/* Contacts */

export async function checkContacts({ contacts, name }) {
  await check("contacts: a search by name answers in the expected shape", async () => {
    const found = await contacts.search({ query: name, limit: 5 });
    expect(Array.isArray(found), "the answer is not a list");
    for (const person of found) {
      expect(typeof person.name === "string" && Array.isArray(person.phones) && Array.isArray(person.emails), "a contact came back in another shape");
      expect(person.birthday === null || /^(\d{4}-)?\d{2}-\d{2}$/.test(person.birthday), `a birthday came back as "${person.birthday}"`);
    }
    const count = (pick) => found.filter(pick).length;
    return `${found.length} found; ${count((person) => person.phones.length)} with a phone, ${count((person) => person.emails.length)} with an email, ${count((person) => person.birthday)} with a birthday`;
  });
  await check("contacts: a search that matches nobody answers with an empty list", async () => {
    const found = await contacts.search({ query: "zzqx-nobody-smcp", limit: 5 });
    expect(Array.isArray(found) && found.length === 0, JSON.stringify(found).slice(0, 80));
  });
}

/* The throwaway calendar and list, made and removed with plain AppleScript */

function appleScript(app, statement, name) {
  const script = `on run argv\n  tell application "${app}" to ${statement}\nend run`;
  return execFileSync("/usr/bin/osascript", ["-e", script, name], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
}

async function throwaway({ eventKit, type, app, make, remove, label }) {
  const find = async () => (await eventKit.calendars(type)).filter((item) => item.title === THROWAWAY);
  let found = await find();
  if (!found.length) {
    try {
      appleScript(app, make, THROWAWAY);
    } catch (error) {
      throw new Error(`could not create the ${label} "${THROWAWAY}" (${String(error.stderr || error.message).trim().split("\n")[0]}). Create it by hand in ${app} and run this again.`);
    }
    for (let i = 0; i < 20 && !found.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      found = await find();
    }
  }
  if (!found.length) throw new Error(`the ${label} "${THROWAWAY}" was created but does not show up yet. Run this again in a minute.`);
  if (!found[0].writable) throw new Error(`the ${label} "${THROWAWAY}" cannot be written.`);
  return {
    item: found[0],
    cleanup: () => {
      try {
        appleScript(app, remove, THROWAWAY);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/* Tailscale: the approval page */

const mask = (text) => String(text ?? "").replace(/^(.).*?(@.*)?$/, (_, first, domain) => `${first}***${domain ?? ""}`);

async function checkTailscale() {
  const { createApprovals } = await import("../app/core/approvals.js");
  const { APPROVAL_LOCAL_PORT, APPROVAL_PORT, createApprovalPage } = await import("../app/core/approval-page.js");
  const { readBaseUrl } = await import("../app/core/funnel.js");
  const { disableServe, enableServe, tailscaleLogin } = await import("../app/core/tasks-hub.js");
  const { tailscaleCandidates } = await import("../src/vpn.js");
  const { run } = await import("../src/util.js");
  const tailscale = tailscaleCandidates().find((candidate) => existsSync(candidate));
  if (!tailscale) return note("SKIP", "tailscale", "Tailscale is not installed on this computer");

  let owner = null;
  let host = null;
  const ready = await check("tailscale: this computer's login and name are read", async () => {
    owner = await tailscaleLogin();
    host = new URL(await readBaseUrl()).host;
    expect(owner && host, "no login or no name");
    return `signed in as ${mask(owner)}`;
  });
  if (!ready) return;

  console.log(`\n  The next step shares a test page on port ${APPROVAL_PORT}, only inside your Tailscale network,`);
  console.log("  and removes it when this finishes. It holds one fake request; approving it sends nothing.");
  if (!/^(y|s)/i.test(await ask("  Share the test page now? [y/N] "))) return note("SKIP", "tailscale: the approval page", "not approved in this run");

  const approvals = createApprovals();
  const page = createApprovalPage({ approvals, owner, port: APPROVAL_LOCAL_PORT });
  let scheme = "https";
  let shared = false;
  const stop = async () => {
    await page.stop().catch(() => {});
    if (shared) await disableServe(APPROVAL_PORT, { scheme }).catch(() => {});
  };
  process.once("SIGINT", () => stop().finally(() => process.exit(130)));
  try {
    await check("tailscale: the page starts on this computer", async () => {
      await page.start();
    });
    await check("tailscale: the page is shared with Tailscale Serve", async () => {
      try {
        await enableServe(APPROVAL_PORT, APPROVAL_LOCAL_PORT, { scheme });
      } catch {
        scheme = "http";
        await enableServe(APPROVAL_PORT, APPROVAL_LOCAL_PORT, { scheme });
      }
      shared = true;
      return `over ${scheme}`;
    });
    if (!shared) return;
    const url = `${scheme}://${host}:${APPROVAL_PORT}/`;
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const request = approvals.request({ title: "SMCP: test approval", action: "Approve the test", body: `This is a test. Nothing is sent.\nCode: ${code}`, origin: { source: "remote", client: "verify-on-mac" } });

    await check("tailscale: asked without going through Tailscale, the page refuses", async () => {
      const direct = await fetch(`http://127.0.0.1:${APPROVAL_LOCAL_PORT}/`, { signal: AbortSignal.timeout(5000) });
      const body = await direct.text();
      expect(direct.status === 403, `it answered ${direct.status}`);
      expect(!body.includes(code), "it showed the request to someone with no login");
    });

    await check("tailscale: the page is not published to the internet", async () => {
      const funnel = await run(tailscale, ["funnel", "status", "--json"], { timeoutMs: 8000 });
      let open = {};
      try {
        open = JSON.parse(funnel.stdout || "{}").AllowFunnel ?? {};
      } catch {
        // No Funnel at all: nothing is published.
      }
      const published = Object.entries(open).filter(([key, on]) => on && key.endsWith(`:${APPROVAL_PORT}`));
      expect(!published.length, `Funnel is on for ${published.map(([key]) => key).join(", ")}`);
    });

    const self = await fetch(url, { signal: AbortSignal.timeout(8000) }).then(
      async (response) => ({ status: response.status, body: await response.text() }),
      (error) => ({ error: error.message }),
    );
    if (self.status === 200 && self.body.includes(code)) note("PASS", "tailscale: opened from this computer through Tailscale, the page shows the request");
    else note("INFO", "tailscale: this computer could not open its own page through Tailscale", self.error ?? `status ${self.status}`);

    console.log(`\n  Now open this address on your phone, with Tailscale on:\n\n      ${url}\n`);
    console.log(`  You should see "SMCP: test approval" with the code ${code}. Press "Approve the test".`);
    console.log("  Waiting up to 5 minutes. Press Enter here to skip this step.\n");
    const reader = createInterface({ input: process.stdin });
    const outcome = await Promise.race([
      request.decision.then((approved) => (approved ? "approved" : "rejected")),
      new Promise((resolve) => reader.once("line", () => resolve("skipped"))),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 5 * 60_000)),
    ]);
    reader.close();
    const status = approvals.get(request.id)?.status;
    if (outcome === "approved") note("PASS", "tailscale: the request was approved from another device", "the page recognised your login");
    else if (outcome === "rejected" && status === "rejected") note("PASS", "tailscale: the request was rejected from another device", "the page recognised your login");
    else note("SKIP", "tailscale: approving from the phone", outcome);
  } finally {
    await stop();
    await check("tailscale: the test page is no longer shared", async () => {
      const status = await run(tailscale, ["serve", "status", "--json"], { timeoutMs: 8000 });
      expect(!String(status.stdout).includes(`:${APPROVAL_PORT}`), "port 47826 still appears in `tailscale serve status`");
    });
  }
}

/* Gmail */

const MARKER = /<!-- gmail:([0-9a-f]+) -->/g;
const marks = (text) => [...text.matchAll(MARKER)].map((match) => match[1]);

async function checkGmail({ vault }) {
  const { createGmail } = await import("../app/core/gmail.js");
  const { exportGmailAccount } = await import("../src/brain/gmail-export.js");
  console.log("\n  This step is optional. It needs a Gmail app password, typed here: it is not shown, not saved");
  console.log("  and not printed. Create one at https://myaccount.google.com/apppasswords and delete it afterwards.");
  const email = (await ask("  Gmail account to check (Enter to skip): ")).toLowerCase();
  if (!email) return note("SKIP", "gmail", "no account given");
  const guess = existsSync(join(vault, "raw", "Personal", "gmail")) && email.endsWith("@gmail.com") ? "raw/Personal/gmail" : "raw/Senda/gmail";
  const folder = (await ask(`  Folder for this account inside the vault [${guess}]: `)) || guess;
  const password = (await askHidden("  App password (16 letters, not shown): ")).replace(/\s/g, "");
  if (!password) return note("SKIP", "gmail", "no password given");

  const work = mkdtempSync(join(tmpdir(), "smcp-verify-gmail-"));
  const copy = join(work, "vault");
  try {
    mkdirSync(join(copy, folder), { recursive: true });
    const real = join(vault, folder);
    if (existsSync(real)) cpSync(real, join(copy, folder), { recursive: true });
    const days = readdirSync(join(copy, folder)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort();
    const before = new Map(days.map((name) => [name, readFileSync(join(copy, folder, name), "utf8")]));
    const gmail = createGmail({
      store: { list: async () => [{ label: email, email }], credentials: async () => ({ label: email, email, password }) },
      confirm: async () => false,
    });
    const newest = days.at(-1) ?? null;
    note("INFO", "gmail: the copy of the folder", `${days.length} day files, the newest is ${newest ?? "none"}`);

    // The marks already in the notes came from Gmail's API. If the id read over IMAP is the same number,
    // mail from the newest day is recognised; if it were not, every one of them would be written again.
    if (newest) {
      await check("gmail: mail already in the notes is recognised by its id", async () => {
        const [year, month, day] = newest.slice(0, 10).split("-").map(Number);
        const since = new Date(year, month - 1, day).getTime();
        const { messages } = await gmail.exportSince({ account: email, since, limit: 500 });
        const old = new Set(marks(before.get(newest)));
        const again = messages.filter((message) => old.has(message.id)).length;
        expect(old.size > 0, "the newest day file has no marks to compare");
        expect(again > 0, `none of the ${old.size} emails in ${newest} was found again among ${messages.length} read from Gmail: the ids do not match`);
        return `${again} of the ${old.size} emails in ${newest} were found again by id (${messages.length} read since that day, ${messages.filter((message) => message.sent).length} sent by you)`;
      });
    }

    let result = null;
    await check("gmail: the export runs against the real account", async () => {
      result = await exportGmailAccount({ gmail, account: email, vault: copy, folder });
      return `${result.written} new emails in ${result.files.length} files; ${result.skipped} left out for safety${result.truncated ? "; more are waiting for the next run" : ""}`;
    });
    if (!result) return;

    await check("gmail: nothing already in the notes was written twice", async () => {
      let repeated = 0;
      for (const [name, text] of before) {
        const now = readFileSync(join(copy, folder, name), "utf8");
        expect(now.startsWith(text.replace(/\n+$/, "")), `${name} was changed instead of only added to`);
        const all = marks(now);
        repeated += all.length - new Set(all).size;
      }
      expect(repeated === 0, `${repeated} emails appear twice`);
    });

    await check("gmail: new day files have the expected top and one mark per email", async () => {
      const created = result.files.map((path) => path.split("/").pop()).filter((name) => !before.has(name));
      for (const name of created) {
        const text = readFileSync(join(copy, folder, name), "utf8");
        expect(text.startsWith(`---\nfuente: gmail `) && text.includes(`\nfecha: ${name.slice(0, 10)}\n---\n\n# Correo `), `${name} does not start like a day file`);
        expect(marks(text).length === (text.match(/^## \d{2}:\d{2} · /gm) ?? []).length, `${name} has a different number of headings and marks`);
      }
      return `${created.length} new day files`;
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* Main */

function options() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const list = (name) => (value(name, "") || "").split(",").map((item) => item.trim()).filter(Boolean);
  const expand = (path) => (path?.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  const only = list("only");
  const skip = list("skip");
  return {
    vault: expand(value("vault", "~/Server/brain")),
    ownName: value("own-name", null),
    wants: (name) => (only.length ? only.includes(name) : !skip.includes(name)),
  };
}

function firstName(given) {
  if (given) return given;
  try {
    return execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8" }).trim().split(/\s+/)[0] || userInfo().username;
  } catch {
    return userInfo().username;
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("This check only runs on a Mac: it uses the real Calendar, Reminders, Contacts and Tailscale.");
    process.exit(2);
  }
  const { vault, ownName, wants } = options();
  // The libraries are the ones the installed SMCP already carries, so nothing has to be installed.
  if (!existsSync(join(ROOT, "node_modules"))) {
    if (!existsSync(INSTALLED_MODULES)) {
      console.error(`No node_modules here and none at ${INSTALLED_MODULES}. Run \`npm ci --omit=dev\` in this folder first.`);
      process.exit(2);
    }
    symlinkSync(INSTALLED_MODULES, join(ROOT, "node_modules"));
  }
  const version = (command, args) => {
    try {
      return execFileSync(command, args, { encoding: "utf8" }).trim().split("\n")[0];
    } catch {
      return "not found";
    }
  };
  const commit = version("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
  console.log(`SMCP check on a Mac · commit ${commit} · macOS ${version("/usr/bin/sw_vers", ["-productVersion"])} · Node ${process.versions.node}${process.versions.electron ? ` (Electron ${process.versions.electron})` : ""}`);

  const { createEventKit, EVENTS, REMINDERS } = await import("../src/eventkit.js");
  const { createAutoRegistry, createCalendarOps, splitNotes } = await import("../app/core/calendar-ops.js");
  const eventKit = createEventKit();
  const historyDir = mkdtempSync(join(tmpdir(), "smcp-verify-"));

  if (wants("calendar")) {
    section("Calendar (macOS may ask whether the terminal can use your calendars: allow it)");
    let made = null;
    const ready = await check("calendar: a throwaway calendar is ready", async () => {
      made = await throwaway({ eventKit, type: EVENTS, app: "Calendar", label: "calendar", make: "make new calendar with properties {name:(item 1 of argv)}", remove: "delete (first calendar whose name is (item 1 of argv))" });
      return `"${made.item.title}" in ${made.item.account}`;
    });
    if (ready) {
      try {
        await checkCalendar({ eventKit, createCalendarOps, createAutoRegistry, splitNotes, calendar: made.item, historyDir });
      } catch (error) {
        note("FAIL", "calendar: the checks stopped early", error.message);
      }
      note(made.cleanup() ? "PASS" : "FAIL", "calendar: the throwaway calendar is deleted");
    }
  }

  if (wants("reminders")) {
    section("Reminders (macOS may ask whether the terminal can use your reminders: allow it)");
    let made = null;
    const ready = await check("reminders: a throwaway list is ready", async () => {
      made = await throwaway({ eventKit, type: REMINDERS, app: "Reminders", label: "list", make: "make new list with properties {name:(item 1 of argv)}", remove: "delete (first list whose name is (item 1 of argv))" });
      return `"${made.item.title}"`;
    });
    if (ready) {
      const ops = createCalendarOps({ eventKit, confirm: async () => false, autoCalendars: () => [], registry: createAutoRegistry({ path: join(historyDir, "reminders.jsonl") }) });
      try {
        await checkReminders({ eventKit, ops, list: made.item });
      } catch (error) {
        note("FAIL", "reminders: the checks stopped early", error.message);
      }
      note(made.cleanup() ? "PASS" : "FAIL", "reminders: the throwaway list is deleted");
    }
  }

  if (wants("contacts")) {
    section("Contacts (macOS may ask whether the terminal can use your contacts: allow it)");
    const { createContacts } = await import("../src/contacts.js");
    await checkContacts({ contacts: createContacts(), name: firstName(ownName) });
  }

  if (wants("tailscale")) {
    section("Tailscale: the approval page");
    await checkTailscale().catch((error) => note("FAIL", "tailscale: the checks stopped early", error.message));
  }

  if (wants("gmail")) {
    section("Gmail export");
    if (!existsSync(join(vault, "raw"))) note("SKIP", "gmail", `no vault with a raw folder at ${vault}; pass --vault`);
    else await checkGmail({ vault }).catch((error) => note("FAIL", "gmail: the checks stopped early", error.message));
  }

  rmSync(historyDir, { recursive: true, force: true });
  const count = (status) => results.filter((result) => result.status === status).length;
  console.log("\n===== paste from here =====");
  console.log(`SMCP check · commit ${commit} · macOS ${version("/usr/bin/sw_vers", ["-productVersion"])} · Node ${process.versions.node}`);
  console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`);
  for (const result of results.filter((item) => item.status !== "PASS")) console.log(`${result.status}  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
  console.log("===== to here =====");
  process.exit(count("FAIL") ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
