// Settings for "SMCP pulls": which vault receives the raw exports, which sources are on, how often
// they run and where each one writes. SMCP only ever writes inside the vault's raw/ folder.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const WHATSAPP_FOLDER = "raw/Personal/whatsapp";
const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;
const MAX_ACCOUNTS = 20;
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function brainConfigPath() {
  return process.env.SMCP_BRAIN_CONFIG || join(homedir(), ".smcp", "brain.json");
}

/** Where the exporters keep their own state: watermarks, the heartbeat and the journal. Never inside the vault. */
export function brainStateDir() {
  return process.env.SMCP_BRAIN_DIR || join(homedir(), ".smcp", "brain");
}

/**
 * A folder inside the vault where an exporter may write: relative, under raw/, with no way out.
 * Returns the cleaned path, or throws.
 */
export function rawFolder(value) {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  const parts = text.split("/");
  // A dot at the start covers "..", "." and hidden folders; a backslash would be a way around the split.
  const unsafe = (part) => !part || part.startsWith(".") || /[\\\0]/.test(part);
  if (!text || isAbsolute(text) || /^[A-Za-z]:/.test(text) || parts[0] !== "raw" || parts.length < 2 || parts.some(unsafe)) {
    throw new Error("The folder must be inside the vault's raw/ folder, for example raw/Personal/gmail.");
  }
  if (text.length > 200) throw new Error("That folder name is too long.");
  return parts.join("/");
}

/** `raw/Personal/gmail` → "personal"; `raw/Acme/gmail` → "de Acme". It becomes part of each day file's title. */
export function defaultMailLabel(folder) {
  const owner = String(folder ?? "").split("/")[1] ?? "";
  return owner.toLowerCase() === "personal" ? "personal" : `de ${owner}`;
}

/** The name written for the person's own messages. Their first name is the usual choice. */
export function defaultOwnName() {
  try {
    const name = userInfo().username.split(/[._\s-]/)[0];
    return name ? name[0].toUpperCase() + name.slice(1) : "Me";
  } catch {
    return "Me";
  }
}

const minutes = (value, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(Math.max(number, MIN_MINUTES), MAX_MINUTES) : fallback;
};

function cleanFolder(value, fallback) {
  try {
    return rawFolder(value);
  } catch {
    return fallback;
  }
}

/** Fills in defaults and drops anything that is not a valid setting. Everything starts off. */
export function normalizeBrainConfig(saved = {}) {
  const accounts = {};
  for (const [email, entry] of Object.entries(saved.gmail?.accounts ?? {}).slice(0, MAX_ACCOUNTS)) {
    const address = String(email).trim().toLowerCase();
    const folder = cleanFolder(entry?.folder, null);
    if (!EMAIL.test(address) || !folder) continue;
    const label = String(entry.label ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 60) || defaultMailLabel(folder);
    accounts[address] = { folder, label };
  }
  const zone = typeof saved.timeZone === "string" && saved.timeZone.length <= 64 ? saved.timeZone : null;
  return {
    vault: typeof saved.vault === "string" && isAbsolute(saved.vault) ? saved.vault : null,
    timeZone: zone,
    whatsapp: {
      enabled: saved.whatsapp?.enabled === true,
      everyMinutes: minutes(saved.whatsapp?.everyMinutes, 30),
      folder: cleanFolder(saved.whatsapp?.folder, WHATSAPP_FOLDER),
      ownName: String(saved.whatsapp?.ownName ?? "").replace(/[\r\n:]+/g, " ").trim().slice(0, 60) || defaultOwnName(),
    },
    gmail: {
      enabled: saved.gmail?.enabled === true,
      everyMinutes: minutes(saved.gmail?.everyMinutes, 60),
      accounts,
    },
  };
}

export function readBrainConfig(path = brainConfigPath()) {
  try {
    return normalizeBrainConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeBrainConfig();
  }
}

export function writeBrainConfig(config, path = brainConfigPath()) {
  const clean = normalizeBrainConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return clean;
}

/** Every source the settings turn on, as `{ id, kind, everyMinutes, folder, ... }`. */
export function enabledSources(config) {
  const sources = [];
  if (!config.vault) return sources;
  if (config.whatsapp.enabled) sources.push({ id: "whatsapp", kind: "whatsapp", everyMinutes: config.whatsapp.everyMinutes, folder: config.whatsapp.folder });
  if (config.gmail.enabled) {
    for (const [email, entry] of Object.entries(config.gmail.accounts)) {
      sources.push({ id: `gmail:${email}`, kind: "gmail", account: email, everyMinutes: config.gmail.everyMinutes, folder: entry.folder, label: entry.label });
    }
  }
  return sources;
}
