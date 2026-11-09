import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { storeDir, transcriptsPath, wacliBin } from "../../src/tools/whatsapp.js";
import { run } from "../../src/util.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

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
  const result = await run(wacliBin(), [`--store=${storeDir()}`, "--read-only", "--json", "doctor"], {
    timeoutMs: 10_000,
  });
  return { supported: true, installed: true, ...(parseDoctor(result.stdout) ?? { linked: false, messages: 0, chats: 0 }) };
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
