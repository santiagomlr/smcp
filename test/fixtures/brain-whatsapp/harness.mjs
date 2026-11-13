// Shared by the tests and by the script that rebuilds the golden files: loading a store from
// SQL text, reading a folder tree, and running the reference scripts on a temporary vault.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WA_FOLDER = "raw/Personal/whatsapp";
export const REFERENCE_SCRIPTS = ["whatsapp-mcp-pull.py", "whatsapp-mcp-format.py"];

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

/** The name of a working command, or null: `sqlite3` or one of the Python launchers. */
export function findCommand(candidates, versionFlag) {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, [versionFlag], { encoding: "utf8" });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

/** Runs SQL text against a store. The text goes through a file next to the store, so nothing needs quoting. */
export function loadSql(storePath, sql) {
  const dir = dirname(storePath);
  writeFileSync(join(dir, "load.sql"), sql);
  command("sqlite3", [storePath, ".read load.sql"], { cwd: dir });
}

/** Writes `{ "relative/path": text }` under `root`. */
export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** Every file under `root` as `{ "relative/path": Buffer }`, hidden ones included, sorted by path. */
export function readTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), next);
      else out[next.normalize("NFC")] = readFileSync(join(dir, entry.name));
    }
  };
  if (existsSync(root)) walk(root, "");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * One run of the reference: pull, then apply. The scripts find the vault from their own location,
 * so they are copied into `<vault>/scripts/` first. Returns what they reported and the state and
 * identities they left, with the parts that change on every run (clock, paths) removed.
 */
export function runReference({ python, scriptsDir, vault, storePath }) {
  const scripts = join(vault, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of REFERENCE_SCRIPTS) {
    if (!existsSync(join(scripts, name))) copyFileSync(join(scriptsDir, name), join(scripts, name));
  }
  const payloadPath = join(dirname(storePath), "payload.json");
  command(python, [join(scripts, REFERENCE_SCRIPTS[0]), "--store", storePath, "--out", payloadPath]);
  const report = JSON.parse(command(python, [join(scripts, REFERENCE_SCRIPTS[1]), "--apply", payloadPath, "--json"]));
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  const state = JSON.parse(readFileSync(join(scripts, ".whatsapp-mcp-state.json"), "utf8"));
  const aliasesPath = join(scripts, "whatsapp-jid-aliases.json");
  const aliases = existsSync(aliasesPath) ? JSON.parse(readFileSync(aliasesPath, "utf8")).aliases : {};
  return { stats: payload.stats, ambiguous: payload.identidades_ambiguas, report, chats: state.chats, aliases };
}

/** The reference's numbers under the names the exporter uses, to compare the two results field by field. */
export function expectedResult(reference) {
  const { stats, report, ambiguous } = reference;
  return {
    stats: {
      chatsScanned: stats.chats_scanned,
      chatsWithNew: stats.chats_with_new,
      messages: stats.messages,
      skippedChats: stats.skipped_chats,
      identitiesMerged: stats.identidades_unidas,
      identitiesAmbiguous: stats.identidades_ambiguas,
      storeLastMessage: stats.store_ultimo_mensaje,
    },
    report: {
      chatsTouched: report.chats_touched,
      messagesWritten: report.messages_written,
      notesCreated: report.notes_created,
      skippedChats: report.skipped_chats,
      quarantinedAppends: report.quarantined_appends,
      duplicatesSkipped: report.duplicates_skipped,
      detail: report.detail,
    },
    ambiguous: ambiguous.map((item) => ({ wacliJid: item.wacli_jid, name: item.nombre, candidates: item.candidatos })),
  };
}

/** A state's chats with the remembered ids sorted: the reference keeps them in no particular order. */
export function comparableChats(chats) {
  return Object.entries(chats).map(([jid, entry]) => [jid, { ...entry, ...(Array.isArray(entry.seen_ids) ? { seen_ids: [...entry.seen_ids].sort() } : {}) }]);
}
