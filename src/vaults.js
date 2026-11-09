// Notes: Obsidian vaults or any folder of Markdown. Only folders the person switched on are reachable.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const NOTE_EXTENSIONS = new Set([".md", ".txt", ".canvas"]);
const MAX_FILES = 30_000;
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_READ_CHARS = 200_000;
const SKIP_DIRS = new Set(["node_modules"]);

export function vaultsConfigPath() {
  return process.env.SMCP_VAULTS || join(homedir(), ".smcp", "vaults.json");
}

export function obsidianRegistryPath(home = homedir()) {
  return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
}

/** Vaults Obsidian knows about on this computer, most recently opened first. */
export function detectVaults(registry = obsidianRegistryPath()) {
  try {
    const data = JSON.parse(readFileSync(registry, "utf8"));
    return Object.values(data.vaults ?? {})
      .filter((vault) => typeof vault.path === "string" && existsSync(vault.path))
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .map((vault) => vault.path);
  } catch {
    return [];
  }
}

export function readVaultConfig(path = vaultsConfigPath()) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data.vaults) ? data.vaults.filter((vault) => typeof vault.path === "string") : [];
  } catch {
    return [];
  }
}

function writeVaultConfig(vaults, path = vaultsConfigPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ vaults }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Folders too broad to hand over as a single vault. */
export function isTooBroad(path, home = homedir()) {
  const clean = resolve(path);
  return clean === sep || clean === home || clean === dirname(home) || ["/System", "/Library", "/Applications", "/Users"].includes(clean);
}

export function setVault(path, enabled, configPath = vaultsConfigPath()) {
  if (!isAbsolute(path)) throw new Error("Ruta inválida.");
  if (enabled && isTooBroad(path)) throw new Error("Esa carpeta es demasiado amplia. Elige la carpeta de tus notas.");
  const vaults = readVaultConfig(configPath).filter((vault) => vault.path !== path);
  vaults.push({ path, enabled: Boolean(enabled) });
  writeVaultConfig(vaults, configPath);
}

/** Display names: the folder name, plus its parent when two vaults share a name. */
export function nameVaults(paths) {
  const counts = new Map();
  for (const path of paths) counts.set(basename(path), (counts.get(basename(path)) ?? 0) + 1);
  return paths.map((path) => ({
    path,
    name: counts.get(basename(path)) > 1 ? `${basename(path)} (${basename(dirname(path))})` : basename(path),
  }));
}

/** A short, readable place for a vault, instead of a long storage path. */
export function vaultLocation(path, home = homedir()) {
  const parent = dirname(path);
  const icloud = join(home, "Library", "Mobile Documents");
  const drives = join(home, "Library", "CloudStorage");
  if (parent.startsWith(join(icloud, "iCloud~md~obsidian"))) return "iCloud · Obsidian";
  if (parent.startsWith(icloud)) return "iCloud Drive";
  if (parent.startsWith(drives)) {
    const provider = relative(drives, parent).split(sep)[0].split("-")[0];
    const names = { GoogleDrive: "Google Drive", OneDrive: "OneDrive", Dropbox: "Dropbox", Box: "Box" };
    const folder = basename(parent);
    return `${names[provider] ?? provider} · ${folder}`;
  }
  return parent.startsWith(home) ? `~${parent.slice(home.length)}` : parent;
}

/** Every vault to show in the app: detected ones and added ones, with their switch. */
export function listVaultChoices({ registry, configPath } = {}) {
  const config = readVaultConfig(configPath);
  const enabled = new Map(config.map((vault) => [vault.path, vault.enabled]));
  const paths = [...new Set([...detectVaults(registry), ...config.map((vault) => vault.path)])].filter((path) => existsSync(path));
  return nameVaults(paths).map((vault) => ({ ...vault, enabled: enabled.get(vault.path) === true }));
}

export function enabledVaults(options) {
  return listVaultChoices(options).filter((vault) => vault.enabled);
}

function findVault(vaults, reference) {
  const wanted = String(reference ?? "").trim().toLowerCase();
  const vault = vaults.find((item) => item.name.toLowerCase() === wanted);
  if (!vault) throw new Error("No hay una bóveda conectada con ese nombre. Usa notes_list_vaults.");
  return vault;
}

/** Resolves a note path and refuses anything outside the vault or inside hidden folders. */
export async function resolveNote(vault, notePath, { mustExist = true } = {}) {
  const root = await realpath(vault.path);
  const target = resolve(root, String(notePath ?? ""));
  const parts = relative(root, target).split(sep);
  if (!target.startsWith(root + sep) || parts.some((part) => part === ".." || part.startsWith("."))) {
    throw new Error("Esa ruta está fuera de la bóveda.");
  }
  if (!NOTE_EXTENSIONS.has(extname(target).toLowerCase())) throw new Error("Solo se pueden usar notas .md, .txt o .canvas.");
  let existing = target;
  const missing = [];
  for (;;) {
    try {
      const real = join(await realpath(existing), ...missing);
      if (!real.startsWith(root + sep)) throw new Error("Esa ruta está fuera de la bóveda.");
      return real;
    } catch (error) {
      if (error.code !== "ENOENT" || mustExist) throw error.code === "ENOENT" ? new Error("No existe esa nota.") : error;
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}

async function* walkNotes(root) {
  const pending = [root];
  let seen = 0;
  while (pending.length && seen < MAX_FILES) {
    const dir = pending.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && NOTE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        seen += 1;
        yield full;
      }
    }
  }
}

async function readHead(file, bytes) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function snippet(text, term) {
  const index = text.toLowerCase().indexOf(term);
  if (index < 0) return text.slice(0, 160).replace(/\s+/g, " ").trim();
  const start = Math.max(0, index - 60);
  return `${start ? "…" : ""}${text.slice(start, index + 100).replace(/\s+/g, " ").trim()}…`;
}

export function createNotes({ vaults = () => enabledVaults() } = {}) {
  const targets = (reference) => {
    const list = vaults();
    if (!list.length) throw new Error("No hay bóvedas conectadas. Enciende una en la app SMCP, en Conexiones > Notas.");
    return reference ? [findVault(list, reference)] : list;
  };

  return {
    listVaults: () => vaults().map(({ name, path }) => ({ name, path: path.replace(homedir(), "~") })),

    async search({ query, vault, limit = 20 }) {
      const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      if (!terms.length) throw new Error("Escribe qué buscar.");
      const max = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const results = [];
      for (const target of targets(vault)) {
        const root = await realpath(target.path);
        for await (const file of walkNotes(root)) {
          const title = basename(file, extname(file)).toLowerCase();
          const text = await readHead(file, MAX_SEARCH_BYTES).catch(() => "");
          const lower = text.toLowerCase();
          if (!terms.every((term) => title.includes(term) || lower.includes(term))) continue;
          const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 10 : 0) + Math.min(lower.split(term).length - 1, 20), 0);
          const info = await stat(file);
          results.push({ vault: target.name, path: relative(root, file), score, modified: info.mtime, snippet: snippet(text, terms[0]) });
        }
      }
      results.sort((a, b) => b.score - a.score || b.modified - a.modified);
      return { total: results.length, notes: results.slice(0, max).map(({ score, ...note }) => note) };
    },

    async recent({ vault, limit = 20 }) {
      const max = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const notes = [];
      for (const target of targets(vault)) {
        const root = await realpath(target.path);
        for await (const file of walkNotes(root)) {
          const info = await stat(file);
          notes.push({ vault: target.name, path: relative(root, file), modified: info.mtime });
        }
      }
      return notes.sort((a, b) => b.modified - a.modified).slice(0, max);
    },

    async read({ vault, path }) {
      const [target] = targets(vault);
      const file = await resolveNote(target, path);
      const text = await readHead(file, MAX_READ_CHARS * 4);
      return { vault: target.name, path, content: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS };
    },

    async write({ vault, path, content, mode = "create" }) {
      const [target] = targets(vault);
      const file = await resolveNote(target, path, { mustExist: false });
      await mkdir(dirname(file), { recursive: true });
      if (mode === "append") await appendFile(file, content, "utf8");
      else await writeFile(file, content, { encoding: "utf8", flag: mode === "overwrite" ? "w" : "wx" }).catch((error) => {
        throw error.code === "EEXIST" ? new Error("Esa nota ya existe. Usa mode append u overwrite.") : error;
      });
      return { written: true, vault: target.name, path, mode };
    },
  };
}
