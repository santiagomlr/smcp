// Runs the night light: keeps the native helper alive while it is on, tells it the color for each
// moment and keeps the settings. Has no Electron imports so the tests can drive it with fakes.
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampBrightness,
  clampKelvin,
  currentTarget,
  describe,
  MAX_KELVIN,
  nextWake,
  normalizeSettings,
  parseClock,
  parseLocation,
  PRESETS,
  readSettings,
  screenGains,
  settingsPath,
} from "../../src/nightlight.js";
import { formatLocal } from "../../src/tools/calendar.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TICK_MS = 30_000;
const TICK_FADE_SECONDS = 5;
const CHANGE_FADE_SECONDS = 2;
const PREVIEW_MS = 5_000;
/** If the helper keeps dying right after starting, stop trying until the next change. */
const MAX_QUICK_FAILURES = 3;
const QUICK_FAILURE_MS = 5_000;

/** The packaged app keeps it in Resources/bin and development in vendor/bin. Null if neither has it. */
export function nightLightBin() {
  if (process.env.SMCP_NIGHTLIGHT_BIN) return process.env.SMCP_NIGHTLIGHT_BIN;
  for (const path of [join(PROJECT_ROOT, "..", "bin", "smcp-nightlight"), join(PROJECT_ROOT, "vendor", "bin", "smcp-nightlight")]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

function saveSettings(settings, path = settingsPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** The real helper process: one JSON line in per change, one JSON line out per result. */
function startHelperProcess(bin, { onExit, onMessage }) {
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Ignore anything that is not a status line.
      }
    }
  });
  child.stdin.on("error", () => {});
  child.on("error", () => onExit());
  child.on("exit", () => onExit());
  return {
    send(message) {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    stop() {
      child.stdin.end();
    },
  };
}

const sameGains = (a, b) => Boolean(a && b) && ["r", "g", "b"].every((key) => Math.abs(a[key] - b[key]) < 0.002);

export function createNightLight({
  path = settingsPath(),
  bin = nightLightBin,
  start = startHelperProcess,
  now = () => Date.now(),
  supported = process.platform === "darwin",
  setTimer = setInterval,
  clearTimer = clearInterval,
  onChange = () => {},
} = {}) {
  let helper = null;
  let sent = null;
  let lastError = null;
  let displays = null;
  let quickFailures = 0;
  let startedAt = 0;
  let previewTimer = null;
  let ticker = null;

  const read = () => readSettings(path);

  function ensureHelper() {
    if (helper) return helper;
    if (quickFailures >= MAX_QUICK_FAILURES) return null;
    const executable = bin();
    if (!executable) {
      lastError = "The night light helper is not installed in this copy of SMCP.";
      return null;
    }
    startedAt = now();
    const current = start(executable, {
      onMessage(message) {
        if (message.ok === false) lastError = message.error ?? "The screen could not be changed.";
        else {
          if (Number.isFinite(message.displays)) displays = message.displays;
          if (!message.restored) lastError = null;
        }
      },
      onExit() {
        if (helper !== current) return;
        helper = null;
        sent = null;
        if (now() - startedAt < QUICK_FAILURE_MS) quickFailures += 1;
        onChange();
      },
    });
    helper = current;
    return helper;
  }

  /** Sends the color for this moment. Nothing is sent when it has not changed. */
  function sync({ fade = CHANGE_FADE_SECONDS } = {}) {
    if (!supported || previewTimer) return;
    const target = currentTarget(read(), now());
    if (!target.active) {
      if (helper) {
        helper.send({ off: true, fade });
        sent = null;
      }
      return;
    }
    if (sameGains(sent, target.gains)) return;
    const running = ensureHelper();
    if (!running) return;
    running.send({ ...target.gains, fade });
    sent = target.gains;
  }

  /** Saves and applies. A preview in progress ends first unless only the schedule's colors moved. */
  function write(patch, { keepPreview = false } = {}) {
    if (!keepPreview && previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    const settings = normalizeSettings({ ...read(), ...patch });
    saveSettings(settings, path);
    quickFailures = 0;
    sync();
    onChange();
    return status();
  }

  function status() {
    const settings = read();
    return {
      supported,
      installed: Boolean(bin()),
      running: Boolean(helper),
      ...(displays !== null ? { displays } : {}),
      ...(lastError ? { error: lastError } : {}),
      ...describe(settings, now(), { formatTime: formatLocal }),
      settings,
      presets: PRESETS,
    };
  }

  /**
   * Changes the schedule. Each value is optional; the preset fills day, sunset, bedtime and dim first,
   * so values passed alongside it win.
   */
  function configure(input = {}) {
    const patch = {};
    if (input.preset !== undefined) {
      const preset = PRESETS[input.preset];
      if (!preset) throw new Error(`Unknown preset. Use one of: ${Object.keys(PRESETS).join(", ")}.`);
      Object.assign(patch, preset);
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled === true;
    for (const key of ["day", "sunset", "bedtime"]) {
      if (input[key] !== undefined) patch[key] = clampKelvin(input[key]);
    }
    if (input.dim !== undefined) patch.dim = clampBrightness(input.dim);
    if (input.wake !== undefined) {
      const clock = parseClock(input.wake);
      if (!clock) throw new Error("The wake time must look like 07:00.");
      patch.wake = clock.text;
    }
    if (input.location !== undefined) {
      const location = input.location === null || input.location === "" ? null : parseLocation(input.location);
      if (input.location && !location) throw new Error("The location must be latitude,longitude, such as 25.7,-100.3.");
      patch.location = location;
    }
    // A new schedule replaces whatever was chosen by hand for now.
    if (Object.keys(patch).some((key) => key !== "enabled")) patch.override = null;
    // Dragging a schedule slider keeps its preview on screen for a moment, as f.lux does.
    return write(patch, { keepPreview: patch.enabled === undefined && patch.location === undefined && patch.wake === undefined });
  }

  /**
   * Sets the color by hand for a while, the way f.lux's slider does. It turns the night light on.
   * Without minutes it lasts until the next wake time.
   */
  function setNow({ kelvin, brightness, minutes } = {}) {
    const settings = read();
    const base = currentTarget({ ...settings, enabled: true }, now());
    const until = Number.isFinite(minutes) && minutes > 0 ? now() + Math.round(minutes) * 60_000 : nextWake(now(), settings);
    return write({
      enabled: true,
      override: {
        kelvin: kelvin === undefined ? base.kelvin : clampKelvin(kelvin),
        brightness: brightness === undefined ? base.brightness : clampBrightness(brightness),
        until,
      },
    });
  }

  /** Goes back to the schedule. */
  function clearNow() {
    return write({ override: null });
  }

  /** Daytime color for a while, like f.lux's "disable for an hour". */
  function pause(minutes = 60) {
    return setNow({ kelvin: MAX_KELVIN, brightness: 1, minutes });
  }

  /** Shows a color for a few seconds while a slider moves, then returns to what is scheduled. */
  function preview({ kelvin, brightness = 1 }) {
    if (!supported) return status();
    const running = ensureHelper();
    if (!running) return status();
    const gains = screenGains({ kelvin: clampKelvin(kelvin), brightness: clampBrightness(brightness) });
    running.send({ ...gains, fade: 0.15 });
    sent = gains;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      sent = null;
      sync({ fade: 1 });
    }, PREVIEW_MS);
    return status();
  }

  return {
    status,
    configure,
    setNow,
    clearNow,
    pause,
    preview,
    sync,
    start() {
      sync({ fade: 1 });
      ticker = setTimer(() => sync({ fade: TICK_FADE_SECONDS }), TICK_MS);
    },
    /** Puts the screen back right away, for quitting. */
    stop() {
      clearTimer(ticker);
      clearTimeout(previewTimer);
      previewTimer = null;
      helper?.send({ off: true, fade: 0 });
      helper?.stop();
      helper = null;
      sent = null;
    },
  };
}
