// "SMCP pulls": the settings, the heartbeat every run leaves, the list of what changed, and the runner.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBrainExports } from "../app/core/brain.js";
import { readCheckpoints, readInboxMark, readJournal, recordRun, sourceHealth, writeInboxMark } from "../src/brain/checkpoint.js";
import { defaultMailLabel, enabledSources, normalizeBrainConfig, rawFolder, readBrainConfig, writeBrainConfig } from "../src/brain/config.js";
import { brainInbox, changedRawFiles } from "../src/brain/inbox.js";
import { readPolicy, toolGroup } from "../src/policy.js";
import { registerBrain } from "../src/tools/brain.js";
import { exportsStatus, smcpStatus } from "../src/tools/status.js";

let dir;
let vault;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-brain-"));
  vault = join(dir, "vault");
  await mkdir(join(vault, "raw", "Personal", "whatsapp", "Personales"), { recursive: true });
  await mkdir(join(vault, "raw", "Work", "gmail"), { recursive: true });
});
after(() => rm(dir, { recursive: true, force: true }));

const state = async (name) => {
  const path = join(dir, name);
  await mkdir(path, { recursive: true });
  return path;
};
const HOUR = 60 * 60 * 1000;
const config = (extra = {}) =>
  normalizeBrainConfig({
    vault,
    whatsapp: { enabled: true, everyMinutes: 30, ownName: "Ana" },
    gmail: { enabled: true, everyMinutes: 60, accounts: { "ana@example.com": { folder: "raw/Work/gmail" } } },
    ...extra,
  });

test("an exporter may only write inside the vault's raw folder", () => {
  assert.equal(rawFolder("raw/Personal/gmail/"), "raw/Personal/gmail");
  for (const bad of ["", "raw", "wiki/notes", "/etc/passwd", "raw/../wiki", "raw/./x", "raw/.obsidian/x", "../raw/x", "C:\\raw\\x", "raw\\Work\\gmail", "raw//x", "x".repeat(300)]) {
    assert.throws(() => rawFolder(bad), /inside the vault's raw\/ folder|too long/, bad);
  }
});

test("settings start off, keep only what is valid, and name each mail folder's files", async () => {
  const empty = normalizeBrainConfig();
  assert.equal(empty.vault, null);
  assert.equal(empty.whatsapp.enabled, false);
  assert.equal(empty.gmail.enabled, false);
  assert.equal(empty.whatsapp.folder, "raw/Personal/whatsapp");
  assert.deepEqual(enabledSources(empty), []);

  assert.equal(defaultMailLabel("raw/Personal/gmail"), "personal");
  assert.equal(defaultMailLabel("raw/Work/gmail"), "de Work");

  const messy = normalizeBrainConfig({
    vault: "relative/path",
    whatsapp: { enabled: "yes", everyMinutes: 1, folder: "../outside", ownName: "Ana:\nB" },
    gmail: { enabled: true, everyMinutes: 99_999, accounts: { "ANA@Example.com": { folder: "raw/Work/gmail" }, "not-an-email": { folder: "raw/x/y" }, "b@example.com": { folder: "/abs" } } },
  });
  assert.equal(messy.vault, null);
  assert.equal(messy.whatsapp.enabled, false);
  assert.equal(messy.whatsapp.everyMinutes, 5);
  assert.equal(messy.whatsapp.folder, "raw/Personal/whatsapp");
  assert.equal(messy.whatsapp.ownName, "Ana B");
  assert.equal(messy.gmail.everyMinutes, 24 * 60);
  assert.deepEqual(messy.gmail.accounts, { "ana@example.com": { folder: "raw/Work/gmail", label: "de Work" } });
  // Without a vault nothing runs, whatever is switched on.
  assert.deepEqual(enabledSources(messy), []);

  const path = join(dir, "brain.json");
  writeBrainConfig(config(), path);
  assert.deepEqual(readBrainConfig(path), config());
  assert.deepEqual(enabledSources(config()).map((source) => source.id), ["whatsapp", "gmail:ana@example.com"]);
});

test("every run leaves a heartbeat, so nothing new and did not run never look the same", async () => {
  const stateDir = await state("heartbeat");
  const t0 = Date.parse("2026-11-13T10:00:00Z");
  recordRun("whatsapp", { ok: true, startedAt: t0, finishedAt: t0 + 1000, summary: { new_messages: 0 }, files: [] }, stateDir);
  let checkpoint = readCheckpoints(stateDir).whatsapp;
  assert.equal(checkpoint.lastRunAt, "2026-11-13T10:00:01.000Z");
  assert.equal(checkpoint.lastChangeAt, null);
  assert.equal(sourceHealth(checkpoint, { enabled: true, everyMinutes: 30, now: t0 + 20 * 60_000 }), "ok");
  // It ran and found nothing: no journal line, but the heartbeat moved.
  assert.deepEqual(readJournal({ dir: stateDir }), []);

  // Silent for too long is "late", which is not the same as "ok with nothing new".
  assert.equal(sourceHealth(checkpoint, { enabled: true, everyMinutes: 30, now: t0 + 3 * HOUR }), "late");
  assert.equal(sourceHealth(null, { enabled: true, everyMinutes: 30 }), "never");
  assert.equal(sourceHealth(checkpoint, { enabled: false, everyMinutes: 30 }), "off");

  recordRun("whatsapp", { ok: false, startedAt: t0 + HOUR, finishedAt: t0 + HOUR, error: "sqlite3 was not found on this computer." }, stateDir);
  recordRun("whatsapp", { ok: false, startedAt: t0 + 2 * HOUR, finishedAt: t0 + 2 * HOUR, error: "sqlite3 was not found on this computer." }, stateDir);
  checkpoint = readCheckpoints(stateDir).whatsapp;
  assert.equal(checkpoint.ok, false);
  assert.equal(checkpoint.failures, 2);
  assert.equal(checkpoint.lastOkAt, "2026-11-13T10:00:01.000Z", "the last good run is still known");
  assert.equal(sourceHealth(checkpoint, { enabled: true, everyMinutes: 30, now: t0 + 2 * HOUR }), "failed");

  recordRun("whatsapp", { ok: true, startedAt: t0 + 3 * HOUR, finishedAt: t0 + 3 * HOUR, summary: { new_messages: 4 }, files: [{ path: "raw/Personal/whatsapp/Personales/Ana 1x.md", added: 4 }] }, stateDir);
  checkpoint = readCheckpoints(stateDir).whatsapp;
  assert.deepEqual({ ok: checkpoint.ok, failures: checkpoint.failures, error: checkpoint.error }, { ok: true, failures: 0, error: null });
  assert.deepEqual(readJournal({ dir: stateDir }).map((entry) => [entry.source, entry.path, entry.added]), [["whatsapp", "raw/Personal/whatsapp/Personales/Ana 1x.md", 4]]);
});

test("the mark of what was interpreted only moves to a real, past time", async () => {
  const stateDir = await state("mark");
  assert.equal(readInboxMark(stateDir), null);
  assert.throws(() => writeInboxMark("yesterday-ish", stateDir), /must be a date and time/);
  assert.throws(() => writeInboxMark(new Date(Date.now() + HOUR).toISOString(), stateDir), /future/);
  assert.equal(writeInboxMark("2026-11-13T10:00:00Z", stateDir), "2026-11-13T10:00:00.000Z");
  assert.equal(readInboxMark(stateDir), "2026-11-13T10:00:00.000Z");
});

test("the inbox lists exactly what changed since the mark, and warns about a source that is not running", async () => {
  const stateDir = await state("inbox");
  const now = Date.now();
  const note = "raw/Personal/whatsapp/Personales/Ana 1x.md";
  const day = "raw/Work/gmail/2026-11-13.md";
  await writeFile(join(vault, note), "x");
  await writeFile(join(vault, day), "x");
  // A file some other tool dropped into raw/, and an old one that must not show up.
  await writeFile(join(vault, "raw", "meeting-notes.md"), "x");
  await writeFile(join(vault, "raw", "Personal", "whatsapp", "_Conversation Index.md"), "x");
  await writeFile(join(vault, "raw", "old.md"), "x");
  await utimes(join(vault, "raw", "old.md"), new Date(now - 30 * 24 * HOUR), new Date(now - 30 * 24 * HOUR));

  recordRun("whatsapp", { ok: true, startedAt: now - 5 * HOUR, finishedAt: now - 5 * HOUR, files: [{ path: note, added: 2 }] }, stateDir);
  writeInboxMark(new Date(now - 4 * HOUR).toISOString(), stateDir);
  recordRun("whatsapp", { ok: true, startedAt: now - 2 * HOUR, finishedAt: now - 2 * HOUR, files: [{ path: note, added: 3 }] }, stateDir);
  recordRun("whatsapp", { ok: true, startedAt: now - 60_000, finishedAt: now - 60_000, summary: { new_messages: 5 }, files: [{ path: note, added: 5 }] }, stateDir);
  recordRun("gmail:ana@example.com", { ok: false, startedAt: now - 60_000, finishedAt: now - 60_000, error: "Could not connect to Gmail." }, stateDir);

  const inbox = brainInbox({ config: config(), dir: stateDir, now });
  assert.equal(inbox.interpreted_through, new Date(now - 4 * HOUR).toISOString());
  // Only what changed after the mark, added up per file.
  assert.deepEqual(inbox.changed.map((item) => [item.path, item.source, item.runs, item.added]), [[note, "whatsapp", 2, 8]]);
  const other = inbox.other_changed.map((item) => item.path);
  assert.ok(other.includes("raw/meeting-notes.md"));
  assert.ok(other.includes(day), "a file SMCP did not record is still listed, as changed by something else");
  assert.ok(!other.includes(note), "what the journal already lists is not repeated");
  assert.ok(!other.includes("raw/old.md"));
  assert.ok(!other.includes("raw/Personal/whatsapp/_Conversation Index.md"), "the index is rewritten on every run and is not news");
  const gmail = inbox.sources.find((source) => source.source === "gmail:ana@example.com");
  assert.deepEqual({ status: gmail.status, error: gmail.error, folder: gmail.folder }, { status: "failed", error: "Could not connect to Gmail.", folder: "raw/Work/gmail" });
  assert.match(inbox.warning, /gmail:ana@example\.com \(failed\).*did not run, not that nothing happened/);
  assert.equal(inbox.sources.find((source) => source.source === "whatsapp").status, "ok");

  // The first time there is no mark: it says so and looks back a week.
  const first = brainInbox({ config: config(), dir: await state("inbox-empty"), now });
  assert.equal(first.interpreted_through, null);
  assert.match(first.note_first_time, /last 7 days/);
  assert.match(first.warning, /whatsapp \(never\)/);
  assert.throws(() => brainInbox({ config: normalizeBrainConfig(), dir: stateDir }), /No vault is chosen/);
});

test("the walk through raw skips hidden folders and stops at its limit", async () => {
  await mkdir(join(vault, "raw", ".hidden"), { recursive: true });
  await writeFile(join(vault, "raw", ".hidden", "secret.md"), "x");
  const all = changedRawFiles(vault, 0);
  assert.ok(!all.files.some((file) => file.path.includes(".hidden")));
  const capped = changedRawFiles(vault, 0, { max: 1 });
  assert.equal(capped.files.length, 1);
  assert.equal(capped.complete, false);
});

test("the runner records every run, keeps a failure a failure, and tells the person once", async () => {
  const stateDir = await state("runner");
  let clock = Date.parse("2026-11-13T10:00:00Z");
  const calls = [];
  const failures = [];
  let gmailFails = true;
  const exports = createBrainExports({
    gmail: { exportSince: async () => ({}) },
    storePath: () => join(dir, "wacli.db"),
    readConfig: () => config(),
    readPolicy: () => ({ paused: false, disabled: {}, whatsapp: { read: true } }),
    stateDir: () => stateDir,
    now: () => clock,
    onFailure: (source, message) => failures.push([source, message]),
    exporters: {
      whatsapp: async (options) => {
        calls.push(["whatsapp", options.ownName, options.folder, options.statePath.startsWith(stateDir), options.seedStatePath]);
        return { stats: { storeLastMessage: "2026-11-13T09:59:00Z" }, report: { messagesWritten: 3, chatsTouched: 1, notesCreated: 0, detail: [{ note: "raw/Personal/whatsapp/Personales/Ana 1x.md", new: 3 }] }, files: ["raw/Personal/whatsapp/Personales/Ana 1x.md"], ambiguous: [] };
      },
      gmail: async (options) => {
        calls.push(["gmail", options.account, options.folder, options.label]);
        if (gmailFails) throw new Error("Could not connect to Gmail. Check your internet connection.");
        return { written: 0, days: 0, skipped: 0, files: [] };
      },
    },
  });

  await exports.runDue();
  assert.deepEqual(calls, [
    ["whatsapp", "Ana", "raw/Personal/whatsapp", true, undefined],
    ["gmail", "ana@example.com", "raw/Work/gmail", "de Work"],
  ]);
  let checkpoints = readCheckpoints(stateDir);
  assert.equal(checkpoints.whatsapp.ok, true);
  assert.deepEqual(checkpoints.whatsapp.summary, { new_messages: 3, chats: 1, new_notes: 0, newest_message_in_store: "2026-11-13T09:59:00Z" });
  assert.equal(checkpoints["gmail:ana@example.com"].ok, false);
  assert.deepEqual(failures, [["gmail:ana@example.com", "Could not connect to Gmail. Check your internet connection."]]);

  // Not due yet: nothing runs.
  clock += 10 * 60_000;
  calls.length = 0;
  await exports.runDue();
  assert.deepEqual(calls, []);

  // WhatsApp is due at 30 minutes; Gmail (hourly) is not. A second failure in a row does not notify again.
  clock += 25 * 60_000;
  await exports.runDue();
  assert.deepEqual(calls.map((call) => call[0]), ["whatsapp"]);
  clock += 30 * 60_000;
  calls.length = 0;
  await exports.runDue();
  assert.deepEqual(calls.map((call) => call[0]), ["whatsapp", "gmail"]);
  assert.equal(failures.length, 1);
  assert.equal(readCheckpoints(stateDir)["gmail:ana@example.com"].failures, 2);

  // It comes back, with nothing new: the heartbeat still moves and the failure clears.
  gmailFails = false;
  const now = await exports.runNow({ source: "gmail:ana@example.com" });
  assert.deepEqual(now.ran, [{ source: "gmail:ana@example.com", ok: true, new_emails: 0, days: 0, skipped_for_safety: 0, files: [] }]);
  checkpoints = readCheckpoints(stateDir);
  assert.equal(checkpoints["gmail:ana@example.com"].ok, true);
  assert.equal(checkpoints["gmail:ana@example.com"].lastRunAt, new Date(clock).toISOString());

  await assert.rejects(exports.runNow({ source: "gmail:nobody@example.com" }), /No export named/);
  const status = exports.status();
  assert.deepEqual(status.sources.map((source) => [source.source, source.status]), [["whatsapp", "ok"], ["gmail:ana@example.com", "ok"]]);
});

test("pausing SMCP or turning a source off stops its export too, and the gap is explained", async () => {
  const stateDir = await state("blocked");
  let policy = { paused: true, disabled: {}, whatsapp: { read: true } };
  const ran = [];
  const exports = createBrainExports({
    gmail: {},
    storePath: () => "x",
    readConfig: () => config(),
    readPolicy: () => policy,
    stateDir: () => stateDir,
    exporters: { whatsapp: async () => (ran.push("whatsapp"), { report: {}, files: [] }), gmail: async () => (ran.push("gmail"), { files: [] }) },
  });
  let result = await exports.runNow();
  assert.deepEqual(result.ran.map((item) => [item.ok, item.error]), [[false, "SMCP is paused, so nothing was exported."], [false, "SMCP is paused, so nothing was exported."]]);
  policy = { paused: false, disabled: { gmail: true }, whatsapp: { read: false } };
  result = await exports.runNow();
  assert.match(result.ran[0].error, /Reading WhatsApp is turned off/);
  assert.match(result.ran[1].error, /Gmail is turned off/);
  assert.deepEqual(ran, []);
  policy = { paused: false, disabled: {}, whatsapp: { read: true } };
  await exports.runNow();
  assert.deepEqual(ran, ["whatsapp", "gmail"]);
});

test("a vault without a raw folder is a failure with a reason, not an empty run", async () => {
  const stateDir = await state("no-raw");
  const exports = createBrainExports({
    gmail: {},
    storePath: () => "x",
    readConfig: () => ({ ...config(), vault: join(dir, "not-a-vault") }),
    readPolicy: () => ({ paused: false, disabled: {}, whatsapp: { read: true } }),
    stateDir: () => stateDir,
    exporters: { whatsapp: async () => assert.fail("must not run"), gmail: async () => assert.fail("must not run") },
  });
  const { ran } = await exports.runNow({ source: "whatsapp" });
  assert.equal(ran[0].ok, false);
  assert.match(ran[0].error, /has no raw\/ folder/);
  assert.equal(readCheckpoints(stateDir).whatsapp.ok, false);
});

test("a failed export shows in the status report, not only in a log", async () => {
  const stateDir = await state("status");
  const now = Date.now();
  recordRun("whatsapp", { ok: false, startedAt: now, finishedAt: now, error: "The WhatsApp store could not be read." }, stateDir);
  const exported = exportsStatus({ config: config(), checkpoints: readCheckpoints(stateDir), now });
  assert.deepEqual(exported.notWorking, ["whatsapp: failed (The WhatsApp store could not be read.)", "gmail:ana@example.com: never"]);
  const status = await smcpStatus({ policy: readPolicy(join(dir, "missing.json")), probes: {}, server: null, exports: () => exported });
  assert.equal(status.exports.sources[0].status, "failed");
  // With no vault chosen there is nothing to report.
  assert.equal(exportsStatus({ config: normalizeBrainConfig(), checkpoints: {} }), null);
});

test("the brain tools follow the Notes switch and report errors plainly", async () => {
  for (const name of ["brain_inbox", "brain_inbox_mark", "brain_export_now"]) assert.equal(toolGroup(name), "notes");
  const tools = {};
  const marks = [];
  registerBrain(
    { registerTool: (name, _config, handler) => (tools[name] = handler) },
    {
      inbox: ({ since } = {}) => ({ since: since ?? null, changed: [] }),
      mark: (through) => (marks.push(through), through),
      exportNow: async ({ source }) => {
        if (source === "nope") throw new Error("No export named \"nope\" is turned on.");
        return { ran: [] };
      },
    },
  );
  assert.deepEqual(JSON.parse((await tools.brain_inbox({})).content[0].text), { since: null, changed: [] });
  assert.equal(JSON.parse((await tools.brain_inbox({ since: "2026-11-13T10:00:00Z" })).content[0].text).since, "2026-11-13T10:00:00.000Z");
  assert.equal((await tools.brain_inbox({ since: "soon" })).isError, true);
  await tools.brain_inbox_mark({ through: "2026-11-13T10:00:00Z" });
  assert.deepEqual(marks, ["2026-11-13T10:00:00Z"]);
  const failed = await tools.brain_export_now({ source: "nope" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /No export named/);
});
