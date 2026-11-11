// Runs "keep awake": holds the power assertion while a session is on, checks that macOS really
// honors it, ends the session when its time, app or battery says so, and handles closed-lid mode.
// Has no Electron imports so the tests can drive it with fakes.
//
// What makes it sturdier than a plain toggle:
// - The assertion comes from /usr/bin/caffeinate started with `-w <SMCP's pid>`, so it disappears the
//   moment SMCP does, crash included. If caffeinate dies while a session is on, it is started again.
// - Every status reads `pmset -g assertions` and says whether SMCP's assertion is really there.
// - Closed-lid mode turns system sleep off only while a session needs it, and turns it back on at the
//   end, at quit, and at the next launch if SMCP ever crashed with it off.
// - On battery it stops at the person's floor, so a closed laptop never drains flat in a bag.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import {
  adminAppleScript,
  BATTERY_FLOORS,
  describe,
  installScript,
  isActive,
  makeSession,
  normalizeSettings,
  parseAssertions,
  parseBattery,
  parsePowerSettings,
  parseSleepLog,
  PMSET,
  processNames,
  readSettings,
  settingsPath,
  SUDOERS_PATH,
  uninstallScript,
  WATCH_GRACE_MS,
  watchRunning,
} from "../../src/awake.js";
import { formatLocal } from "../../src/tools/calendar.js";
import { run as runCommand } from "../../src/util.js";

const TICK_MS = 15_000;

/** If caffeinate keeps dying right after starting, stop restarting it until the next change. */
const MAX_QUICK_FAILURES = 3;
const QUICK_FAILURE_MS = 5_000;
const SUDO = "/usr/bin/sudo";

function saveSettings(settings, path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * A dead-man switch for closed-lid mode: a tiny detached shell that waits for SMCP to exit, however it
 * exits, and turns system sleep back on. It needs no password because SMCP's rule allows that command.
 */
export function startLidGuard({ pid = process.pid } = {}) {
  const script = `while /bin/kill -0 ${Number(pid)} 2>/dev/null; do /bin/sleep 5; done; ${SUDO} -n ${PMSET} -a disablesleep 0`;
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return {
    stop() {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

/** The Mac keeper: caffeinate tied to this process, so it can never outlive SMCP. */
export function startCaffeinate({ displayOn, onExit, pid = process.pid }) {
  // -i idle sleep, -m disk sleep, -s system sleep on power (lid open), -d the screen too if asked.
  const args = ["-i", "-m", "-s", ...(displayOn ? ["-d"] : []), "-w", String(pid)];
  const child = spawn("/usr/bin/caffeinate", args, { stdio: "ignore" });
  child.on("error", () => onExit());
  child.on("exit", () => onExit());
  return {
    pid: child.pid ?? null,
    stop() {
      child.removeAllListeners("exit");
      child.kill();
    },
  };
}

export function createAwake({
  path = settingsPath(),
  platform = process.platform,
  run = runCommand,
  startKeeper = startCaffeinate,
  startGuard = startLidGuard,
  exists = existsSync,
  user = () => userInfo().username,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  onChange = () => {},
  onEnded = () => {},
} = {}) {
  const mac = platform === "darwin";
  let keeper = null;
  let guard = null;
  let keeperDisplay = null;
  let startedAt = 0;
  let quickFailures = 0;
  let missingSince = null;
  let ticker = null;
  let lastError = null;
  let busy = Promise.resolve();

  const read = () => readSettings(path);
  const write = (patch) => {
    const settings = normalizeSettings({ ...read(), ...patch });
    saveSettings(settings, path);
    return settings;
  };

  /**
   * With the screen kept on, a screen saver can still start and lock the Mac: holding the display
   * awake does not stop it. Telling macOS the user is active does, so it is repeated every tick.
   */
  function declareActivity() {
    if (!mac) return;
    run("/usr/bin/caffeinate", ["-u", "-t", String(Math.ceil((TICK_MS * 2) / 1000))], { timeoutMs: TICK_MS * 3 }).catch(() => {});
  }

  /** One change at a time: a tick and a click must not both start caffeinate. */
  const serial = (fn) => {
    const next = busy.then(fn, fn);
    busy = next.catch(() => {});
    return next;
  };

  function stopKeeper() {
    keeper?.stop();
    keeper = null;
    keeperDisplay = null;
  }

  function ensureKeeper(settings) {
    if (keeper && keeperDisplay === settings.displayOn) return;
    stopKeeper();
    if (quickFailures >= MAX_QUICK_FAILURES) {
      lastError = "macOS keeps stopping the keep-awake helper. Turn keep awake off and on to try again.";
      return;
    }
    startedAt = now();
    const current = startKeeper({
      displayOn: settings.displayOn,
      onExit() {
        if (keeper !== current) return;
        keeper = null;
        keeperDisplay = null;
        if (now() - startedAt < QUICK_FAILURE_MS) quickFailures += 1;
        // Start it again right away while the session is still on.
        serial(() => apply()).finally(onChange);
      },
    });
    keeper = current;
    keeperDisplay = settings.displayOn;
  }

  async function sudoPmset(value) {
    const result = await run(SUDO, ["-n", PMSET, "-a", "disablesleep", value], { timeoutMs: 10_000 });
    return result.code === 0;
  }

  async function sleepDisabled() {
    const result = await run(PMSET, ["-g"], { timeoutMs: 10_000 });
    return parsePowerSettings(result.stdout).sleepDisabled;
  }

  /** Whether this user may turn system sleep off without a password, through SMCP's rule. */
  async function lidReady() {
    if (!mac || !exists(SUDOERS_PATH)) return false;
    const result = await run(SUDO, ["-n", "-l", PMSET, "-a", "disablesleep", "1"], { timeoutMs: 10_000 });
    return result.code === 0;
  }

  /** Puts the computer in the state the settings ask for. */
  async function apply() {
    let settings = read();
    const active = isActive(settings, now());
    if (!active && settings.session) settings = write({ session: null });
    if (active) ensureKeeper(settings);
    else stopKeeper();
    if (active && settings.displayOn) declareActivity();
    if (!mac) return settings;
    const wantLid = active && settings.closedLid;
    if (wantLid) {
      // Read what macOS has now rather than trusting the flag: anything else may have turned sleep back on.
      if (await sleepDisabled()) {
        if (settings.lidOwned && !guard) guard = startGuard();
        return settings;
      }
      if (!(await lidReady())) return settings;
      if (await sudoPmset("1")) {
        settings = write({ lidOwned: true });
        guard?.stop();
        guard = startGuard();
      } else lastError = "Could not turn on closed-lid mode. Set it up again in Settings.";
    } else if (settings.lidOwned) {
      // Even if this fails the flag stays, so the next tick or launch tries again.
      if (await sudoPmset("0")) {
        settings = write({ lidOwned: false });
        guard?.stop();
        guard = null;
      }
    }
    return settings;
  }

  async function end(reason) {
    const settings = read();
    if (!settings.session) return;
    write({ session: null });
    missingSince = null;
    await apply();
    onEnded(reason);
    onChange();
  }

  async function battery() {
    if (!mac) return null;
    const result = await run(PMSET, ["-g", "batt"], { timeoutMs: 10_000 });
    return result.code === 0 ? parseBattery(result.stdout) : null;
  }

  /** Running process names, or null if they can't be read (then nothing is ended for it). */
  async function running() {
    if (platform === "win32") {
      const result = await run("tasklist", ["/fo", "csv", "/nh"], { timeoutMs: 10_000 });
      if (result.code !== 0) return null;
      return result.stdout
        .split("\n")
        .map((line) => /^"([^"]+)"/.exec(line.trim())?.[1]?.replace(/\.exe$/i, ""))
        .filter(Boolean);
    }
    const result = await run("/bin/ps", ["-Ao", "comm="], { timeoutMs: 10_000 });
    return result.code === 0 ? processNames(result.stdout) : null;
  }

  /** Every few seconds: time up, watched app gone, battery low, or caffeinate gone. */
  async function tick() {
    const settings = read();
    if (!settings.session) {
      if (settings.lidOwned) await apply();
      return;
    }
    if (!isActive(settings, now())) return end("time");
    if (settings.session.watch) {
      const names = await running();
      if (names && !watchRunning(settings.session.watch, names)) {
        missingSince ??= now();
        if (now() - missingSince >= WATCH_GRACE_MS) return end("app");
      } else missingSince = null;
    }
    if (settings.batteryFloor > 0) {
      const power = await battery();
      if (power?.onBattery && power.percent !== null && power.percent <= settings.batteryFloor) return end("battery");
    }
    await apply();
  }

  /** Live facts from macOS, plus what SMCP is doing and anything that would stop it from working. */
  async function status() {
    const settings = read();
    const active = isActive(settings, now());
    const base = {
      supported: true,
      platform,
      ...describe(settings, now(), { formatTime: formatLocal }),
      settings: { displayOn: settings.displayOn, closedLid: settings.closedLid, atLaunch: settings.atLaunch, batteryFloor: settings.batteryFloor },
      batteryFloors: BATTERY_FLOORS,
      holding: Boolean(keeper),
      ...(lastError ? { error: lastError } : {}),
    };
    if (!mac) return { ...base, closedLidSupported: false, warnings: [] };
    const [assertions, power, settingsText, ready] = await Promise.all([
      run(PMSET, ["-g", "assertions"], { timeoutMs: 10_000 }),
      battery(),
      run(PMSET, ["-g"], { timeoutMs: 10_000 }),
      lidReady(),
    ]);
    const { totals, owners } = parseAssertions(assertions.stdout);
    const live = parsePowerSettings(settingsText.stdout);
    const verified = Boolean(keeper?.pid) && owners.some((owner) => owner.pid === keeper.pid && /PreventUserIdleSystemSleep|PreventSystemSleep/.test(owner.type));
    const others = owners
      .filter((owner) => owner.pid !== keeper?.pid && /Prevent\w*Sleep/.test(owner.type))
      .map((owner) => ({ process: owner.process, type: owner.type, name: owner.name }));
    const warnings = [];
    if (active && keeper && !verified) warnings.push({ code: "not-verified", text: "macOS does not show SMCP's keep-awake assertion yet. If this lasts, turn keep awake off and on." });
    if (active && settings.closedLid && !ready) warnings.push({ code: "lid-setup", text: "Closing the lid will still put the computer to sleep: closed-lid mode needs a one-time setup in SMCP's Settings." });
    if (active && settings.closedLid && power?.onBattery) warnings.push({ code: "lid-battery", text: "Running on battery with closed-lid mode: keep it ventilated, and it stops at the battery floor." });
    // The point is a server with its screen off, so say plainly when the screen would stay on anyway.
    if (active && !settings.displayOn && live.values.displaysleep === 0) {
      warnings.push({ code: "display-never", text: "The screen is set to never turn off in System Settings, so it stays on. Use Turn screen off, or set Turn display off when inactive in System Settings > Lock Screen." });
    }
    const displayHolders = [...new Set(others.filter((owner) => owner.type === "PreventUserIdleDisplaySleep").map((owner) => owner.process))];
    if (active && !settings.displayOn && displayHolders.length) {
      warnings.push({ code: "display-held", apps: displayHolders.join(", "), text: `${displayHolders.join(", ")} is keeping the screen on. Use Turn screen off, or close it.` });
    }
    if (live.values.lowpowermode === 1) warnings.push({ code: "low-power", text: "Low Power Mode is on. macOS may slow down network and background work." });
    if (live.sleepDisabled && !settings.lidOwned) warnings.push({ code: "sleep-disabled-elsewhere", text: "System sleep is turned off by something other than SMCP (for example Amphetamine Enhancer or a pmset command)." });
    return {
      ...base,
      verified: active ? verified : false,
      closedLidSupported: true,
      closedLidReady: ready,
      closedLidOn: live.sleepDisabled,
      battery: power,
      displaySleepMinutes: live.values.displaysleep ?? null,
      systemSleepMinutes: live.values.sleep ?? null,
      sleepPreventedBy: live.sleepPreventedBy,
      othersKeepingAwake: others,
      ...(totals.PreventUserIdleSystemSleep !== undefined ? { systemWide: totals } : {}),
      warnings,
    };
  }

  return {
    status,

    /** Starts (or replaces) a session. See makeSession for the endings. */
    start(options = {}) {
      return serial(async () => {
        const session = makeSession(options, now());
        if (session.watch) {
          const names = await running();
          if (names && !watchRunning(session.watch, names)) throw new Error(`${session.watch.name} is not running, so there is nothing to wait for.`);
        }
        const patch = { session };
        if (options.displayOn !== undefined) patch.displayOn = options.displayOn === true;
        if (options.closedLid !== undefined) patch.closedLid = options.closedLid === true;
        write(patch);
        quickFailures = 0;
        missingSince = null;
        lastError = null;
        await apply();
        onChange();
        return status();
      });
    },

    stop() {
      return serial(async () => {
        write({ session: null });
        missingSince = null;
        await apply();
        onChange();
        return status();
      });
    },

    configure(input = {}) {
      return serial(async () => {
        const patch = {};
        for (const key of ["displayOn", "closedLid", "atLaunch"]) {
          if (input[key] !== undefined) patch[key] = input[key] === true;
        }
        if (input.batteryFloor !== undefined) {
          const floor = Number(input.batteryFloor);
          if (!BATTERY_FLOORS.includes(floor)) throw new Error(`The battery floor must be one of ${BATTERY_FLOORS.join(", ")}.`);
          patch.batteryFloor = floor;
        }
        write(patch);
        quickFailures = 0;
        await apply();
        onChange();
        return status();
      });
    },

    /** Turns the screen off now. The computer keeps running only if a session is on. */
    async screenOff() {
      if (!mac) throw new Error("Turning the screen off is only available on a Mac.");
      const result = await run(PMSET, ["displaysleepnow"], { timeoutMs: 10_000 });
      if (result.code !== 0) throw new Error("macOS did not turn the screen off.");
      const settings = read();
      return {
        screen: "off",
        ...(isActive(settings, now())
          ? { note: "The computer stays on. Any key or the trackpad turns the screen back on." }
          : { note: "Keep awake is off, so the computer may go to sleep on its usual schedule." }),
      };
    },

    /** Status plus why the computer slept recently, for "it went to sleep anyway". */
    async diagnose() {
      const current = await status();
      if (!mac) return current;
      const log = await run(PMSET, ["-g", "log"], { timeoutMs: 20_000 });
      return { ...current, recentSleeps: parseSleepLog(log.stdout, 8) };
    },

    /** Asks for the administrator once and installs the two-command rule. Only from the window. */
    async setupClosedLid() {
      if (!mac) throw new Error("Closed-lid mode is only available on a Mac.");
      const script = installScript(user());
      const result = await run("/usr/bin/osascript", ["-e", adminAppleScript(script, "SMCP needs your password once so it can keep this Mac awake with the lid closed.")], {
        timeoutMs: 120_000,
      });
      if (result.code !== 0) {
        if (/-128|cancel/i.test(result.stderr)) throw new Error("Setup was cancelled.");
        throw new Error("Closed-lid mode could not be set up.");
      }
      return serial(async () => {
        await apply();
        onChange();
        return status();
      });
    },

    /** Removes the rule and turns system sleep back on. */
    async removeClosedLid() {
      if (!mac) throw new Error("Closed-lid mode is only available on a Mac.");
      const result = await run("/usr/bin/osascript", ["-e", adminAppleScript(uninstallScript(), "SMCP will remove its closed-lid permission.")], { timeoutMs: 120_000 });
      if (result.code !== 0 && /-128|cancel/i.test(result.stderr)) throw new Error("Cancelled.");
      write({ closedLid: false, lidOwned: false });
      onChange();
      return status();
    },

    /** At app start: undo a crash's leftovers, resume a session still in time, or start one for server mode. */
    launch() {
      return serial(async () => {
        const settings = read();
        if (settings.atLaunch && !isActive(settings, now())) write({ session: makeSession({ by: "person", reason: "Started with SMCP" }, now()) });
        await apply();
        ticker = setTimer(() => serial(tick).catch(() => {}), TICK_MS);
        onChange();
      });
    },

    /** At quit: let go of everything. The session stays saved, so it resumes when SMCP opens again. */
    async shutdown() {
      clearTimer(ticker);
      stopKeeper();
      if (mac && read().lidOwned && (await sudoPmset("0"))) write({ lidOwned: false });
      guard?.stop();
      guard = null;
    },

    tick: () => serial(tick),
  };
}
