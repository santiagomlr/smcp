import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { storeDir, transcriptsPath, wacliBin } from "../../src/tools/whatsapp.js";
import { run } from "../../src/util.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LIVE_FIRST_RETRY_MS = 5_000;
const LIVE_MAX_RETRY_MS = 5 * 60 * 1000;
// A run this long counts as healthy, so the next failure retries quickly again.
const LIVE_HEALTHY_MS = 2 * 60 * 1000;
const LIVE_STOP_GRACE_MS = 5_000;
const LIVE_TAIL_CHARS = 2_000;

export function isInstalled(bin = wacliBin()) {
  return bin !== "wacli" && existsSync(bin);
}

export function parseDoctor(stdout) {
  try {
    const data = JSON.parse(stdout)?.data;
    if (!data) return null;
    return {
      linked: Boolean(data.authenticated) && !data.session_revoked,
      busy: Boolean(data.lock_held),
      messages: data.store?.messages ?? 0,
      chats: data.store?.chats ?? 0,
      lastSync: data.store?.last_sync_at ?? null,
    };
  } catch {
    return null;
  }
}

export async function readWhatsApp() {
  // The app only ships wacli for the Mac; elsewhere WhatsApp works only if someone installed it themselves.
  if (process.platform === "win32" || (process.platform !== "darwin" && !isInstalled())) return { supported: false };
  if (!isInstalled()) return { supported: true, installed: false };
  const [result, chats] = await Promise.all([
    run(wacliBin(), [`--store=${storeDir()}`, "--read-only", "--json", "doctor"], { timeoutMs: 10_000 }),
    run(wacliBin(), [`--store=${storeDir()}`, "--read-only", "--json", "chats", "list", "--limit=20"], { timeoutMs: 10_000 }),
  ]);
  const doctor = parseDoctor(result.stdout) ?? { linked: false, unreadable: true, messages: 0, chats: 0 };
  // The live sync saves messages without touching last_sync_at, so the newest message is the honest date.
  const newest = newestMessage(chats.stdout);
  if (newest && !(Date.parse(doctor.lastSync) >= Date.parse(newest))) doctor.lastSync = newest;
  return { supported: true, installed: true, ...doctor };
}

/** The newest last_message_ts among the listed chats. Pinned chats come first, so it looks at all of them. */
export function newestMessage(stdout) {
  try {
    const chats = JSON.parse(stdout)?.data;
    if (!Array.isArray(chats)) return null;
    const times = chats
      .map((chat) => chat?.last_message_ts)
      .filter((ts) => typeof ts === "string" && !ts.startsWith("0001-") && !Number.isNaN(Date.parse(ts)));
    return times.length ? new Date(Math.max(...times.map((ts) => Date.parse(ts)))).toISOString() : null;
  } catch {
    return null;
  }
}

function parseEnvelope(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Why a wacli command failed, or null if it worked. It can exit 0 and still report success:false. */
export function failureDetail({ code, stdout = "", stderr = "" }) {
  const envelope = parseEnvelope(stdout);
  if (code === 0 && envelope?.success !== false) return null;
  const error = parseEnvelope(stderr)?.error ?? envelope?.error;
  return String(error || stderr || stdout).trim().slice(-400);
}

export async function syncWhatsApp() {
  const result = await run(wacliBin(), [`--store=${storeDir()}`, "--json", "sync", "--once", "--idle-exit=30s"], {
    timeoutMs: 240_000,
  });
  const detail = failureDetail(result);
  if (detail !== null) throw new Error(result.timedOut ? "The sync took too long." : detail || "Could not sync.");
}

/**
 * Keeps `wacli sync --follow` running so new messages land in the local database as they arrive,
 * not only when someone asks for a sync. While it runs it owns the store lock, and wacli hands
 * sends and media downloads from other wacli commands to it. If it exits, it starts again with
 * growing waits, and it never runs twice. Dependencies are injectable for tests.
 */
export function createLiveSync({
  spawnFn = spawn,
  bin = wacliBin,
  store = storeDir,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  log = (message) => console.error(message),
} = {}) {
  let child = null;
  let wanted = false;
  let held = 0;
  let retryTimer = null;
  let retryMs = LIVE_FIRST_RETRY_MS;
  let exited = null;

  const launch = () => {
    retryTimer = null;
    if (!wanted || held > 0 || child) return;
    const startedAt = now();
    let tail = "";
    let proc;
    try {
      proc = spawnFn(bin(), [`--store=${store()}`, "sync", "--follow", "--max-reconnect=0"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      log(`whatsapp live sync: ${error.message}`);
      return scheduleRetry(0);
    }
    child = proc;
    let resolveExit;
    exited = new Promise((resolve) => (resolveExit = resolve));
    proc.stderr?.on("data", (chunk) => {
      tail = (tail + chunk.toString("utf8")).slice(-LIVE_TAIL_CHARS);
    });
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      child = null;
      resolveExit();
      if (!wanted || held > 0) return;
      log(`whatsapp live sync stopped (${reason}): ${tail.trim().split("\n").pop() ?? ""}`);
      scheduleRetry(now() - startedAt);
    };
    proc.on("error", (error) => finish(error.message));
    proc.on("close", (code, signal) => finish(signal ?? `exit ${code}`));
  };

  const scheduleRetry = (ranMs) => {
    if (retryTimer || !wanted || held > 0) return;
    if (ranMs >= LIVE_HEALTHY_MS) retryMs = LIVE_FIRST_RETRY_MS;
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, LIVE_MAX_RETRY_MS);
    retryTimer = setTimer(launch, wait);
    retryTimer?.unref?.();
  };

  const cancelRetry = () => {
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
  };

  const halt = async () => {
    cancelRetry();
    const proc = child;
    if (!proc) return;
    const gone = exited;
    proc.kill("SIGTERM");
    const timer = setTimer(() => proc.kill("SIGKILL"), LIVE_STOP_GRACE_MS);
    await gone;
    clearTimer(timer);
  };

  return {
    /** Starts it if it is not running. Calling it again is harmless. */
    start() {
      if (!wanted) retryMs = LIVE_FIRST_RETRY_MS;
      wanted = true;
      if (!child && !retryTimer) launch();
    },
    /** Stops it and keeps it stopped until start() is called again. */
    async stop() {
      wanted = false;
      await halt();
    },
    /** Stops it while `task` runs (for example to log out, which needs the lock), then lets it run again if wanted. */
    async pause(task) {
      held += 1;
      try {
        await halt();
        return await task();
      } finally {
        held -= 1;
        if (held === 0 && wanted && !child && !retryTimer) launch();
      }
    },
    running: () => child !== null,
  };
}

export async function logoutWhatsApp() {
  const result = await run(wacliBin(), [`--store=${storeDir()}`, "--json", "auth", "logout"], { timeoutMs: 30_000 });
  if (failureDetail(result) !== null) {
    throw new Error("Could not disconnect WhatsApp. Check your connection and try again.");
  }
  // Voice note transcripts are message content, so they leave with the session.
  rmSync(transcriptsPath(), { force: true });
}

/** Extracts the QR payload from one NDJSON line of `wacli auth --events`. */
export function qrFromEventLine(line) {
  try {
    const event = JSON.parse(line);
    const name = event.event ?? event.type ?? event.name;
    return name === "qr_code" ? (event.data?.code ?? null) : null;
  } catch {
    return null;
  }
}

/** Starts pairing. Returns a function that cancels it. */
export function startLogin({ onQr, onDone }) {
  const child = spawn(wacliBin(), [`--store=${storeDir()}`, "--events", "auth", "--qr-format=text"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let buffer = "";
  child.stderr.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const code = qrFromEventLine(line);
      if (code) onQr(code);
    }
  });
  const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
  child.on("error", (error) => {
    clearTimeout(timer);
    onDone(error.message);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    onDone(code === 0 ? null : signal ? "Linking was canceled." : "Could not link WhatsApp.");
  });
  return () => child.kill();
}
