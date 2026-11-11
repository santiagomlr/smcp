// Keep awake: lets this computer work as a server with the screen off, like Amphetamine or caffeinate,
// but with checks that it is really working. Everything here is plain logic and text parsing with no
// processes started, so the app, the MCP tools and the tests share it. The app runs the real thing
// (app/core/awake.js).
//
// How macOS decides to sleep, and so what each part of this feature does:
// - Idle sleep: prevented by a power assertion (PreventUserIdleSystemSleep). SMCP holds one through
//   /usr/bin/caffeinate, tied to SMCP's own process so it can never be left behind.
// - Display sleep: separate. Letting the screen sleep while the system stays up is what makes a
//   laptop a quiet server; `pmset displaysleepnow` turns it off right away.
// - Closing the lid: macOS sleeps no matter which assertions are held, unless a screen, keyboard and
//   power are attached or sleep is disabled system-wide (`pmset -a disablesleep 1`, which needs an
//   administrator). Amphetamine needs its separate "Enhancer" for this; SMCP asks for the
//   administrator once and installs a rule that allows only those two exact commands.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Longest timed session, so a typo can't keep a laptop awake for a year. */
export const MAX_MINUTES = 7 * 24 * 60;
/** Battery levels the person can choose to stop at; 0 means never. */
export const BATTERY_FLOORS = [0, 10, 20, 30, 50];
/** Watched apps must be gone this long before the session ends, so a restart doesn't end it. */
export const WATCH_GRACE_MS = 45_000;
/** The process names that count as Claude: Claude Code's `claude` and the Claude app. */
export const CLAUDE_PROCESSES = ["claude"];

export const SUDOERS_PATH = "/etc/sudoers.d/smcp-awake";
export const PMSET = "/usr/bin/pmset";
export const LID_COMMANDS = [`${PMSET} -a disablesleep 1`, `${PMSET} -a disablesleep 0`];

export const DEFAULTS = {
  /** null, or the session in progress. */
  session: null,
  /** Keep the screen on too. Off by default: the point is a server with its screen off. */
  displayOn: false,
  /** Keep running with the lid closed. Needs the one-time administrator setup. */
  closedLid: false,
  /** Start a session whenever SMCP opens: with "open at login", the computer is always up. */
  atLaunch: false,
  /** On battery, stop at this percentage (0 = never). Protects a closed laptop in a bag. */
  batteryFloor: 20,
  /** SMCP turned system sleep off and must turn it back on. Survives crashes. */
  lidOwned: false,
  /** While a session is on, reconnect VPNs that drop, like FortiClient after an idle timeout. */
  keepVpns: true,
  /** The VPNs seen on during this session, which keep awake brings back if they drop. */
  vpns: [],
};

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const cleanText = (value, max) => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return text || null;
};

/** An app name to watch: letters, digits, spaces and . _ - only, so it is never a pattern or a path. */
export function cleanAppName(value) {
  const text = cleanText(value, 60);
  if (!text || !/^[\p{L}\p{N} ._-]+$/u.test(text)) return null;
  return text;
}

function normalizeSession(saved) {
  if (!saved || typeof saved !== "object") return null;
  const started = Number(saved.started);
  if (!Number.isFinite(started)) return null;
  const until = saved.until === null || saved.until === undefined ? null : Number(saved.until);
  let watch = null;
  if (saved.watch && typeof saved.watch === "object") {
    if (saved.watch.kind === "claude") watch = { kind: "claude", name: "Claude" };
    else if (saved.watch.kind === "app" && cleanAppName(saved.watch.name)) watch = { kind: "app", name: cleanAppName(saved.watch.name) };
  }
  return {
    started,
    until: Number.isFinite(until) ? until : null,
    watch,
    reason: cleanText(saved.reason, 120),
    by: saved.by === "ai" ? "ai" : "person",
  };
}

/** Anything missing or damaged falls back to a safe value. */
export function normalizeSettings(saved = {}) {
  const source = saved && typeof saved === "object" ? saved : {};
  const floor = Number(source.batteryFloor);
  return {
    session: normalizeSession(source.session),
    displayOn: source.displayOn === true,
    closedLid: source.closedLid === true,
    atLaunch: source.atLaunch === true,
    batteryFloor: BATTERY_FLOORS.includes(floor) ? floor : DEFAULTS.batteryFloor,
    lidOwned: source.lidOwned === true,
    keepVpns: source.keepVpns !== false,
    vpns: Array.isArray(source.vpns) ? source.vpns.filter((id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)).slice(0, 20) : [],
  };
}

export function settingsPath() {
  return process.env.SMCP_AWAKE || join(homedir(), ".smcp", "awake.json");
}

export function readSettings(path = settingsPath()) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeSettings({});
  }
}

/** "18:30" today, or tomorrow if it has passed; or an ISO date. Null when it is neither or not in the future. */
export function parseUntil(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const at = Date.parse(text);
  return Number.isFinite(at) && at > now ? at : null;
}

/**
 * Builds a session from what the person or the AI asked for. At most one ending: minutes, a time,
 * or an app to watch. None means until it is turned off.
 */
export function makeSession({ minutes, until, whileApp, whileClaude, reason, by } = {}, now = Date.now()) {
  const endings = [minutes, until, whileApp, whileClaude ? true : undefined].filter((value) => value !== undefined && value !== null && value !== "");
  if (endings.length > 1) throw new Error("Choose one ending: minutes, until, while_app or while_claude.");
  let end = null;
  let watch = null;
  if (minutes !== undefined && minutes !== null) {
    const count = Number(minutes);
    if (!isNumber(count) || count < 1 || count > MAX_MINUTES) throw new Error(`Minutes must be between 1 and ${MAX_MINUTES}.`);
    end = now + Math.round(count) * 60_000;
  } else if (until !== undefined && until !== null && until !== "") {
    end = parseUntil(until, now);
    if (end === null) throw new Error("The end time must be a future time such as 18:30 or an ISO date.");
    if (end - now > MAX_MINUTES * 60_000) throw new Error("That end time is more than a week away.");
  } else if (whileApp) {
    const name = cleanAppName(whileApp);
    if (!name) throw new Error("The app name can only have letters, digits, spaces, dots, dashes and underscores.");
    watch = { kind: "app", name };
  } else if (whileClaude) {
    watch = { kind: "claude", name: "Claude" };
  }
  return normalizeSession({ started: now, until: end, watch, reason, by });
}

/** True while the session has not run out. Watched apps are checked by the app, not here. */
export function isActive(settings, now = Date.now()) {
  const session = settings?.session;
  if (!session) return false;
  return session.until === null || session.until > now;
}

/** What the session is doing, for the AI and the windows. */
export function describe(settings, now = Date.now(), { formatTime = (ms) => new Date(ms).toISOString() } = {}) {
  const active = isActive(settings, now);
  const session = active ? settings.session : null;
  return {
    active,
    ...(session
      ? {
          since: formatTime(session.started),
          ends: session.until ? formatTime(session.until) : session.watch ? `when ${session.watch.name} closes` : "when turned off",
          ...(session.until ? { endsAt: new Date(session.until).toISOString(), minutesLeft: Math.max(0, Math.ceil((session.until - now) / 60_000)) } : {}),
          ...(session.watch ? { watching: session.watch } : {}),
          ...(session.reason ? { reason: session.reason } : {}),
          startedBy: session.by,
        }
      : {}),
    screen: settings.displayOn ? "kept on" : "may turn off; the computer stays on",
    closedLid: settings.closedLid,
    atLaunch: settings.atLaunch,
    batteryFloor: settings.batteryFloor,
    keepVpns: settings.keepVpns,
  };
}

// ---------------------------------------------------------------------------------------------
// What macOS says

/**
 * `pmset -g assertions`: the system-wide totals and who holds each assertion.
 * Returns { totals: { PreventUserIdleSystemSleep: 1, ... }, owners: [{ pid, process, type, name }] }.
 */
export function parseAssertions(text) {
  const totals = {};
  const owners = [];
  let section = null;
  for (const line of String(text ?? "").split("\n")) {
    if (/^Assertion status system-wide/i.test(line)) section = "totals";
    else if (/^Listed by owning process/i.test(line)) section = "owners";
    else if (/^Kernel Assertions/i.test(line)) section = null;
    else if (section === "totals") {
      const match = /^\s+(\w+)\s+(\d+)\s*$/.exec(line);
      if (match) totals[match[1]] = Number(match[2]);
    } else if (section === "owners") {
      const match = /^\s*pid (\d+)\(([^)]*)\):\s*\[[^\]]*\]\s*(?:[\d:]+\s+)?(\w+)\s+named:\s*"(.*)"/.exec(line);
      if (match) owners.push({ pid: Number(match[1]), process: match[2], type: match[3], name: match[4] });
    }
  }
  return { totals, owners };
}

/** `pmset -g batt`. Null when the computer has no battery. */
export function parseBattery(text) {
  const source = String(text ?? "");
  const power = /drawing from '([^']+)'/.exec(source)?.[1] ?? null;
  const line = /InternalBattery[^\n]*?(\d{1,3})%;\s*([^;]+);/.exec(source);
  if (!line) return power ? { onBattery: false, percent: null, state: null } : null;
  return {
    onBattery: /battery/i.test(power ?? "") || /discharging/i.test(line[2]),
    percent: Number(line[1]),
    state: line[2].trim(),
  };
}

/** `pmset -g`: whether sleep is off system-wide, plus the numeric settings in use (sleep, displaysleep...). */
export function parsePowerSettings(text) {
  const values = {};
  let sleepDisabled = false;
  let preventedBy = [];
  for (const line of String(text ?? "").split("\n")) {
    const disabled = /^\s*SleepDisabled\s+(\d)/.exec(line);
    if (disabled) {
      sleepDisabled = disabled[1] === "1";
      continue;
    }
    const match = /^\s+([A-Za-z][\w ]*?)\s{2,}(-?\d+)(.*)$/.exec(line);
    if (!match) continue;
    values[match[1].trim()] = Number(match[2]);
    if (match[1].trim() === "sleep") {
      const by = /prevented by ([^)]+)\)/.exec(match[3]);
      if (by) preventedBy = by[1].split(",").map((name) => name.trim()).filter(Boolean);
    }
  }
  return { sleepDisabled, values, sleepPreventedBy: preventedBy };
}

const SLEEP_REASONS = [
  [/clamshell/i, "lid closed"],
  [/idle/i, "idle"],
  [/low power/i, "low battery"],
  [/thermal/i, "too hot"],
  [/power button/i, "power button"],
  [/maintenance/i, "maintenance"],
  [/software sleep/i, "an app or the person asked"],
];

/** The latest sleeps in `pmset -g log`, newest first, with a plain reason. */
export function parseSleepLog(text, limit = 5) {
  const sleeps = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+Sleep\s+(.*)$/.exec(line);
    if (!match) continue;
    const cause = /due to '([^']+)'/.exec(match[2])?.[1] ?? /due to ([^:]+)/.exec(match[2])?.[1]?.trim() ?? "";
    const plain = SLEEP_REASONS.find(([pattern]) => pattern.test(cause))?.[1] ?? (cause || "unknown");
    const at = Date.parse(match[1].replace(" ", "T").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2"));
    sleeps.push({ at: Number.isFinite(at) ? new Date(at).toISOString() : match[1], cause: cause || null, reason: plain });
  }
  return sleeps.slice(-limit).reverse();
}

/** Seconds since the keyboard or trackpad was last touched, from `ioreg -c IOHIDSystem -d 4`. Null if unknown. */
export function parseIdleSeconds(text) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text ?? ""));
  return match ? Math.floor(Number(match[1]) / 1e9) : null;
}

/** Process names from `ps -Ao comm=`, reduced to what each executable is called. */
export function processNames(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim().split("/").pop())
    .filter(Boolean);
}

/** Whether the watched app is among the running processes. Case does not matter. */
export function watchRunning(watch, names) {
  if (!watch) return true;
  const wanted = watch.kind === "claude" ? CLAUDE_PROCESSES : [watch.name.toLowerCase()];
  return names.some((name) => wanted.includes(name.toLowerCase()));
}

/** The user name as a sudoers rule can safely contain it. */
export function safeUserName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null;
}

/** The rule that lets this one user run exactly the two closed-lid commands without a password. */
export function sudoersRule(user) {
  const name = safeUserName(user);
  if (!name) throw new Error("This user name can't be used in a system rule.");
  return [
    "# Installed by SMCP so it can keep this Mac awake with the lid closed.",
    "# It allows only these two commands. Delete this file, or use SMCP's Settings, to undo it.",
    `${name} ALL=(root) NOPASSWD: ${LID_COMMANDS.join(", ")}`,
    "",
  ].join("\n");
}

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/**
 * The script the administrator prompt runs: checks the rule with visudo before installing it, so a
 * broken file can never lock the person out of sudo.
 */
export function installScript(user) {
  // mktemp, not a fixed name: root must never write through a link someone else left in /tmp.
  const steps = [
    `/usr/bin/printf '%s' ${shellQuote(sudoersRule(user))} > "$t"`,
    `/usr/sbin/visudo -cf "$t"`,
    `/usr/bin/install -m 0440 -o root -g wheel "$t" ${SUDOERS_PATH}`,
  ].join(" && ");
  return `t=$(/usr/bin/mktemp /tmp/smcp-awake.XXXXXX) || exit 1; ${steps}; r=$?; /bin/rm -f "$t"; exit $r`;
}

/** Removing the rule also turns system sleep back on, so nothing is left behind. */
export function uninstallScript() {
  return `${PMSET} -a disablesleep 0; /bin/rm -f ${SUDOERS_PATH}`;
}

/** An AppleScript `do shell script` with the administrator prompt. */
export function adminAppleScript(script, prompt) {
  const escape = (text) => String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `do shell script "${escape(script)}" with prompt "${escape(prompt)}" with administrator privileges`;
}
