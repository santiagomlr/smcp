import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAwake } from "../app/core/awake.js";
import {
  describe,
  installScript,
  isActive,
  makeSession,
  normalizeSettings,
  parseAssertions,
  parseBattery,
  parsePowerSettings,
  parseSleepLog,
  parseUntil,
  processNames,
  readSettings,
  sudoersRule,
  SUDOERS_PATH,
  watchRunning,
} from "../src/awake.js";
import { denialFor, readPolicy, toolGroup } from "../src/policy.js";
import { REMOTE_TOOLS } from "../src/remote-tools.js";
import { registerAwake } from "../src/tools/awake.js";

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-awake-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
const freshPath = () => join(dir, `${Math.random().toString(36).slice(2)}.json`);

const ASSERTIONS = `2026-11-10 12:00:00 -0600
Assertion status system-wide:
   BackgroundTask                 0
   PreventUserIdleDisplaySleep    0
   PreventSystemSleep             1
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 4242(caffeinate): [0x0000a1b2000192f0] 00:01:02 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting on behalf of '/usr/bin/caffeinate' (pid 4242)
   pid 321(coreaudiod): [0x0000a1b2000192f1] 00:00:10 PreventUserIdleSystemSleep named: "com.apple.audio.context123.preventuseridlesleep"
Kernel Assertions: 0x4=USB
`;

test("reads who holds each assertion from pmset", () => {
  const { totals, owners } = parseAssertions(ASSERTIONS);
  assert.equal(totals.PreventUserIdleSystemSleep, 1);
  assert.equal(totals.PreventSystemSleep, 1);
  assert.deepEqual(owners[0], { pid: 4242, process: "caffeinate", type: "PreventUserIdleSystemSleep", name: "caffeinate command-line tool" });
  assert.equal(owners[1].process, "coreaudiod");
  assert.equal(owners.length, 2);
});

test("reads the battery, and no battery on a desktop", () => {
  assert.deepEqual(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t18%; discharging; 1:02 remaining present: true\n"), {
    onBattery: true,
    percent: 18,
    state: "discharging",
  });
  assert.equal(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n").onBattery, false);
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n"), { onBattery: false, percent: null, state: null });
  assert.equal(parseBattery(""), null);
});

test("reads whether sleep is off system-wide and who prevents it", () => {
  const live = parsePowerSettings(`System-wide power settings:
 SleepDisabled		1
Currently in use:
 standby              1
 womp                 1
 sleep                1 (sleep prevented by caffeinate, coreaudiod)
 displaysleep         10
 lowpowermode         0
`);
  assert.equal(live.sleepDisabled, true);
  assert.equal(live.values.displaysleep, 10);
  assert.equal(live.values.lowpowermode, 0);
  assert.deepEqual(live.sleepPreventedBy, ["caffeinate", "coreaudiod"]);
  assert.equal(parsePowerSettings(" SleepDisabled\t\t0\n").sleepDisabled, false);
});

test("explains recent sleeps in plain words, newest first", () => {
  const sleeps = parseSleepLog(`2026-11-09 23:10:02 -0600 Sleep               \tEntering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using AC (Charge:100%) 120 secs
2026-11-09 23:30:00 -0600 Wake                \tDarkWake to FullWake
2026-11-10 03:12:44 -0600 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:76%) 1234 secs
`);
  assert.equal(sleeps.length, 2);
  assert.equal(sleeps[0].reason, "lid closed");
  assert.equal(sleeps[0].at, "2026-11-10T09:12:44.000Z");
  assert.equal(sleeps[1].reason, "idle");
});

test("sessions take one ending, and refuse nonsense", () => {
  const now = Date.UTC(2026, 10, 10, 18, 0);
  assert.equal(makeSession({ minutes: 90 }, now).until, now + 90 * 60_000);
  assert.equal(makeSession({}, now).until, null);
  assert.deepEqual(makeSession({ whileClaude: true }, now).watch, { kind: "claude", name: "Claude" });
  assert.deepEqual(makeSession({ whileApp: "Xcode" }, now).watch, { kind: "app", name: "Xcode" });
  assert.throws(() => makeSession({ minutes: 10, whileClaude: true }, now), /one ending/);
  assert.throws(() => makeSession({ minutes: 0 }, now), /between/);
  assert.throws(() => makeSession({ whileApp: "x; rm -rf /" }, now), /letters/);
  assert.throws(() => makeSession({ until: "2020-01-01T00:00:00Z" }, now), /future/);
  assert.equal(makeSession({ reason: "a\nb" }, now).reason, "a b");
});

test("a clock time means the next time it comes round", () => {
  const now = new Date(2026, 10, 10, 20, 0).getTime();
  assert.equal(new Date(parseUntil("21:30", now)).getDate(), 10);
  assert.equal(new Date(parseUntil("07:00", now)).getDate(), 11);
  assert.equal(parseUntil("25:00", now), null);
});

test("a damaged settings file falls back to safe values", () => {
  assert.deepEqual(normalizeSettings({ batteryFloor: 7, session: { started: "x" }, displayOn: "yes" }), {
    session: null,
    displayOn: false,
    closedLid: false,
    atLaunch: false,
    batteryFloor: 20,
    lidOwned: false,
  });
  assert.equal(readSettings(join(dir, "missing.json")).session, null);
});

test("describes a timed session, and an expired one as off", () => {
  const now = Date.UTC(2026, 10, 10, 18, 0);
  const settings = normalizeSettings({ session: makeSession({ minutes: 30, reason: "Build" }, now) });
  const told = describe(settings, now + 10 * 60_000);
  assert.equal(told.active, true);
  assert.equal(told.minutesLeft, 20);
  assert.equal(told.reason, "Build");
  assert.equal(isActive(settings, now + 31 * 60_000), false);
  assert.equal(describe(settings, now + 31 * 60_000).active, false);
});

test("watches Claude Code and the Claude app by process name", () => {
  const names = processNames("/sbin/launchd\n/Applications/Claude.app/Contents/MacOS/Claude\nnode\n");
  assert.equal(watchRunning({ kind: "claude" }, names), true);
  assert.equal(watchRunning({ kind: "claude" }, ["zsh", "claude"]), true);
  assert.equal(watchRunning({ kind: "claude" }, ["zsh"]), false);
  assert.equal(watchRunning({ kind: "app", name: "Xcode" }, ["xcode"]), true);
});

test("the closed-lid rule allows exactly two commands for one user, and is checked before installing", () => {
  const rule = sudoersRule("santiago");
  assert.match(rule, /^santiago ALL=\(root\) NOPASSWD: \/usr\/bin\/pmset -a disablesleep 1, \/usr\/bin\/pmset -a disablesleep 0$/m);
  assert.equal(rule.split("\n").filter((line) => line && !line.startsWith("#")).length, 1);
  assert.throws(() => sudoersRule("bad user"), /user name/);
  assert.throws(() => sudoersRule("ALL=(ALL) NOPASSWD: ALL #"), /user name/);
  const script = installScript("santiago");
  assert.ok(script.indexOf("visudo -cf") < script.indexOf("install -m 0440"), "visudo must check the rule first");
  assert.match(script, /mktemp/);
  assert.ok(script.includes(SUDOERS_PATH));
});

/**
 * A pretend Mac: pmset, sudo and ps answer from `sim`, and the keeper and the guard are recorded.
 */
function fakeMac({ lidRule = true, battery = { onBattery: false, percent: 100 }, processes = ["claude"], ...options } = {}) {
  const sim = { displaySleep: 10, extraAssertions: "", sleepDisabled: false, keepers: [], guards: 0, guardsStopped: 0, battery, processes, calls: [] };
  let clock = Date.UTC(2026, 10, 10, 18, 0);
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run = async (file, args) => {
    sim.calls.push([file, ...args].join(" "));
    if (file === "/usr/bin/sudo") {
      if (!lidRule) return { code: 1, stdout: "", stderr: "a password is required" };
      if (args[1] === "-l") return ok("/usr/bin/pmset -a disablesleep 1\n");
      sim.sleepDisabled = args.at(-1) === "1";
      return ok();
    }
    if (file === "/usr/bin/pmset") {
      if (args[1] === "assertions") {
        const keeper = sim.keepers.at(-1);
        const listed = keeper && !keeper.stopped ? ASSERTIONS.replaceAll("4242", String(keeper.pid)) : "Assertion status system-wide:\nListed by owning process:\n";
        return ok(listed.replace("Kernel Assertions", `${sim.extraAssertions}Kernel Assertions`));
      }
      if (args[1] === "batt") {
        const { onBattery, percent } = sim.battery;
        return ok(`Now drawing from '${onBattery ? "Battery Power" : "AC Power"}'\n -InternalBattery-0 (id=1)\t${percent}%; ${onBattery ? "discharging" : "charged"}; 1:00 remaining present: true\n`);
      }
      if (args[0] === "-g" && args.length === 1) return ok(`System-wide power settings:\n SleepDisabled\t\t${sim.sleepDisabled ? 1 : 0}\nCurrently in use:\n displaysleep         ${sim.displaySleep}\n`);
      if (args[0] === "displaysleepnow") return ok();
      if (args[1] === "log") return ok("");
    }
    if (file === "/bin/ps") return ok(sim.processes.join("\n"));
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  const awake = createAwake({
    path: freshPath(),
    platform: "darwin",
    run,
    exists: (path) => path === SUDOERS_PATH && lidRule,
    user: () => "santiago",
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
    startKeeper: ({ displayOn, onExit }) => {
      const keeper = { pid: 5000 + sim.keepers.length, displayOn, onExit, stopped: false };
      sim.keepers.push(keeper);
      return { pid: keeper.pid, stop: () => (keeper.stopped = true) };
    },
    startGuard: () => {
      sim.guards += 1;
      return { stop: () => (sim.guardsStopped += 1) };
    },
    ...options,
  });
  return { awake, sim, advance: (ms) => (clock += ms) };
}

test("keeps the Mac awake, and macOS confirms SMCP's assertion", async () => {
  const { awake, sim } = fakeMac();
  const status = await awake.start({ minutes: 60, reason: "Nightly build" });
  assert.equal(status.active, true);
  assert.equal(status.verified, true);
  assert.equal(status.reason, "Nightly build");
  assert.equal(sim.keepers.length, 1);
  assert.equal(sim.keepers[0].displayOn, false, "the screen may turn off by default");
  assert.deepEqual(status.othersKeepingAwake.map((owner) => owner.process), ["coreaudiod"]);
  const stopped = await awake.stop();
  assert.equal(stopped.active, false);
  assert.equal(sim.keepers[0].stopped, true);
});

test("keeping the screen on restarts the keeper with the display assertion", async () => {
  const { awake, sim } = fakeMac();
  await awake.start({});
  await awake.configure({ displayOn: true });
  assert.equal(sim.keepers.length, 2);
  assert.equal(sim.keepers[0].stopped, true);
  assert.equal(sim.keepers[1].displayOn, true);
});

test("if caffeinate dies, it is started again while the session is on", async () => {
  const { awake, sim, advance } = fakeMac();
  await awake.start({});
  advance(60_000);
  sim.keepers[0].onExit();
  await awake.tick();
  assert.equal(sim.keepers.length, 2);
  assert.equal((await awake.status()).verified, true);
});

test("closed-lid mode turns system sleep off only during the session, with a guard, and back on at the end", async () => {
  const { awake, sim } = fakeMac();
  await awake.configure({ closedLid: true });
  assert.equal(sim.sleepDisabled, false, "nothing changes until a session starts");
  const status = await awake.start({});
  assert.equal(sim.sleepDisabled, true);
  assert.equal(status.closedLidOn, true);
  assert.equal(sim.guards, 1);
  assert.deepEqual(status.warnings, []);
  await awake.stop();
  assert.equal(sim.sleepDisabled, false);
  assert.equal(sim.guardsStopped, 1);
});

test("closed-lid mode without the setup warns instead of pretending", async () => {
  const { awake, sim } = fakeMac({ lidRule: false });
  const status = await awake.start({ closedLid: true });
  assert.equal(sim.sleepDisabled, false);
  assert.equal(status.closedLidReady, false);
  assert.ok(status.warnings.some((warning) => warning.code === "lid-setup"));
});

test("if something else turns sleep back on mid-session, the next tick fixes it", async () => {
  const { awake, sim } = fakeMac();
  await awake.start({ closedLid: true });
  sim.sleepDisabled = false;
  await awake.tick();
  assert.equal(sim.sleepDisabled, true);
});

test("quitting turns system sleep back on but keeps the session for the next launch", async () => {
  const { awake, sim } = fakeMac();
  await awake.start({ closedLid: true });
  await awake.shutdown();
  assert.equal(sim.sleepDisabled, false);
  assert.equal(sim.keepers[0].stopped, true);
  assert.equal((await awake.status()).active, true);
  await awake.launch();
  assert.equal(sim.sleepDisabled, true);
  assert.equal(sim.keepers.length, 2);
});

test("after a crash with sleep off and no session, launching turns sleep back on", async () => {
  const path = freshPath();
  const { awake } = fakeMac({ path });
  await awake.start({ minutes: 5, closedLid: true });
  assert.equal(readSettings(path).lidOwned, true);
  // SMCP dies here without shutdown, and comes back after the session ran out, with sleep still off.
  const { awake: again, sim } = fakeMac({ path, now: () => Date.UTC(2026, 10, 10, 19, 0) });
  sim.sleepDisabled = true;
  await again.launch();
  assert.equal(sim.sleepDisabled, false);
  assert.equal(readSettings(path).lidOwned, false);
  assert.equal(readSettings(path).session, null);
});

test("ends when the time is up and tells why", async () => {
  const ended = [];
  const { awake, advance, sim } = fakeMac({ onEnded: (reason) => ended.push(reason) });
  await awake.start({ minutes: 1 });
  advance(61_000);
  await awake.tick();
  assert.deepEqual(ended, ["time"]);
  assert.equal(sim.keepers[0].stopped, true);
});

test("ends at the battery floor on battery, never on power", async () => {
  const ended = [];
  const { awake, sim } = fakeMac({ onEnded: (reason) => ended.push(reason), battery: { onBattery: false, percent: 15 } });
  await awake.start({});
  await awake.tick();
  assert.deepEqual(ended, [], "plugged in, a low battery does not matter");
  sim.battery = { onBattery: true, percent: 15 };
  await awake.tick();
  assert.deepEqual(ended, ["battery"]);
});

test("while Claude is open: refuses if Claude is not running, ends after a grace period once it quits", async () => {
  const ended = [];
  const { awake, sim, advance } = fakeMac({ processes: ["zsh"], onEnded: (reason) => ended.push(reason) });
  await assert.rejects(awake.start({ whileClaude: true }), /not running/);
  sim.processes = ["zsh", "claude"];
  await awake.start({ whileClaude: true });
  sim.processes = ["zsh"];
  await awake.tick();
  assert.deepEqual(ended, [], "a quick restart must not end it");
  advance(60_000);
  await awake.tick();
  assert.deepEqual(ended, ["app"]);
});

test("server mode starts a session whenever SMCP opens", async () => {
  const { awake, sim } = fakeMac();
  await awake.configure({ atLaunch: true });
  await awake.launch();
  const status = await awake.status();
  assert.equal(status.active, true);
  assert.equal(status.ends, "when turned off");
  assert.equal(sim.keepers.length, 1);
});

test("turning the screen off says whether the computer stays on", async () => {
  const { awake, sim } = fakeMac();
  assert.match((await awake.screenOff()).note, /may go to sleep/);
  await awake.start({});
  assert.match((await awake.screenOff()).note, /stays on/);
  assert.ok(sim.calls.includes("/usr/bin/pmset displaysleepnow"));
});

test("by default the screen may sleep while the system stays awake, and it says when the screen would stay on", async () => {
  const { awake, sim } = fakeMac();
  const status = await awake.start({});
  assert.equal(sim.keepers[0].displayOn, false, "caffeinate runs without -d, so the screen sleeps on its schedule");
  assert.equal(status.displaySleepMinutes, 10);
  assert.deepEqual(status.warnings, []);
  sim.displaySleep = 0;
  assert.ok((await awake.status()).warnings.some((warning) => warning.code === "display-never"));
  sim.displaySleep = 10;
  sim.extraAssertions = '   pid 77(zoom.us): [0x1] 00:05:00 PreventUserIdleDisplaySleep named: "Meeting"\n';
  const held = (await awake.status()).warnings.find((warning) => warning.code === "display-held");
  assert.equal(held.apps, "zoom.us");
  await awake.configure({ displayOn: true });
  assert.deepEqual((await awake.status()).warnings, [], "with the screen kept on on purpose there is nothing to warn about");
});

test("warns when something other than SMCP has turned sleep off", async () => {
  const { awake, sim } = fakeMac();
  sim.sleepDisabled = true;
  const status = await awake.status();
  assert.ok(status.warnings.some((warning) => warning.code === "sleep-disabled-elsewhere"));
});

test("on Windows and Linux it keeps the computer awake without macOS tools", async () => {
  const blocks = [];
  const awake = createAwake({
    path: freshPath(),
    platform: "win32",
    run: async () => assert.fail("no commands on Windows"),
    startKeeper: ({ displayOn }) => {
      blocks.push(displayOn);
      return { pid: null, stop: () => blocks.push("stopped") };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const status = await awake.start({ minutes: 30 });
  assert.equal(status.active, true);
  assert.equal(status.closedLidSupported, false);
  await awake.stop();
  assert.deepEqual(blocks, [false, "stopped"]);
  await assert.rejects(awake.screenOff(), /only available on a Mac/);
});

test("the tools pass the AI's choices to the app", async () => {
  const tools = new Map();
  const calls = [];
  registerAwake(
    { registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
    {
      call: async (op, args) => {
        calls.push([op, args]);
        return { ok: true };
      },
    },
  );
  assert.deepEqual([...tools.keys()].sort(), ["awake_screen_off", "awake_start", "awake_status", "awake_stop"]);
  await tools.get("awake_start").handler({ minutes: 45, reason: "Long refactor", keep_screen_on: false });
  await tools.get("awake_status").handler({ diagnose: true });
  assert.deepEqual(calls[0], ["start", { minutes: 45, until: undefined, whileApp: undefined, whileClaude: undefined, reason: "Long refactor", displayOn: false, closedLid: undefined }]);
  assert.equal(calls[1][0], "diagnose");
  assert.equal(tools.get("awake_status").config.annotations.readOnlyHint, true);
});

test("keep awake has its own switch, works in read-only mode, and only starts from the phone", () => {
  assert.equal(toolGroup("awake_start"), "awake");
  const policy = readPolicy(join(dir, "no-config.json"));
  assert.equal(policy.disabled.awake, false);
  const annotations = { readOnlyHint: false, destructiveHint: false };
  assert.equal(denialFor("awake_start", annotations, { ...policy, readOnly: true }), null);
  assert.match(denialFor("awake_start", annotations, { ...policy, disabled: { ...policy.disabled, awake: true } }), /awake/);
  assert.ok(REMOTE_TOOLS.has("awake_status"));
  assert.ok(REMOTE_TOOLS.has("awake_start"));
  assert.ok(!REMOTE_TOOLS.has("awake_stop"), "letting it sleep from the phone would cut the phone's own connection");
  assert.ok(!REMOTE_TOOLS.has("awake_screen_off"));
});
