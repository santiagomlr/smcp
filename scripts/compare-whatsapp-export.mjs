// Checks, on real data, that SMCP's WhatsApp export writes exactly what the vault's older Python
// scripts write, before those scripts are retired. It never touches the real vault or the real
// WhatsApp store: it works on two copies in a temporary folder and compares them byte for byte.
//
// Usage, on the computer that has WhatsApp linked:
//   node scripts/compare-whatsapp-export.mjs --vault ~/Server/brain --own-name Ana
//
// Options: --store <wacli.db> (default ~/.smcp/wacli/wacli.db), --time-zone <IANA zone> (default
// America/Monterrey, the zone the reference scripts use), --keep (leave the copies for inspection).
// It prints only counts and file names, never message text. Exit code 0 means identical.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { exportWhatsApp } from "../src/brain/whatsapp-export.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const expand = (path) => (path?.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

const vault = expand(option("vault"));
const store = expand(option("store", "~/.smcp/wacli/wacli.db"));
const ownName = option("own-name");
const timeZone = option("time-zone", "America/Monterrey");
const FOLDER = "raw/Personal/whatsapp";
const SCRIPTS = ["whatsapp-mcp-pull.py", "whatsapp-mcp-format.py"];
const STATE = [".whatsapp-mcp-state.json", "whatsapp-jid-aliases.json", "whatsapp-alias-map.json"];

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!vault || !ownName) fail("Usage: node scripts/compare-whatsapp-export.mjs --vault <vault folder> --own-name <your name in the notes> [--store <wacli.db>] [--time-zone <zone>] [--keep]");
if (!existsSync(store)) fail(`The WhatsApp store was not found at ${store}.`);
for (const script of SCRIPTS) if (!existsSync(join(vault, "scripts", script))) fail(`The reference script ${script} was not found in ${join(vault, "scripts")}.`);

const work = mkdtempSync(join(tmpdir(), "smcp-wa-compare-"));
const reference = join(work, "reference");
const smcp = join(work, "smcp");

/** One frozen copy of the store, so both sides read exactly the same messages. */
const frozen = join(work, "wacli.db");
const backup = spawnSync(existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3", ["-readonly", store, `.backup '${frozen.replace(/'/g, "''")}'`], { encoding: "utf8" });
if (backup.status !== 0) {
  // macOS's sqlite3 cannot open the store read-only while nothing else has it open; a plain copy of
  // the file and its write-ahead log holds the same messages.
  cpSync(store, frozen);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(store + suffix)) cpSync(store + suffix, frozen + suffix);
}

/** A copy of the part of the vault both exports use: the notes, the reference scripts and their state. */
function copyVault(target) {
  mkdirSync(join(target, "scripts"), { recursive: true });
  mkdirSync(join(target, "raw", "Personal"), { recursive: true });
  if (existsSync(join(vault, FOLDER))) cpSync(join(vault, FOLDER), join(target, FOLDER), { recursive: true });
  for (const name of [...SCRIPTS, ...STATE]) {
    const source = join(vault, "scripts", name);
    if (existsSync(source)) cpSync(source, join(target, "scripts", name));
  }
}
copyVault(reference);
copyVault(smcp);

const python = (script, ...rest) => {
  const result = spawnSync("python3", [join(reference, "scripts", script), ...rest], { encoding: "utf8", env: { ...process.env, SMCP_WACLI_DB: frozen } });
  if (result.status !== 0) fail(`${script} failed:\n${result.stderr}`);
  return result.stdout.trim();
};
const payload = join(work, "payload.json");
const startedAt = new Date();
console.log(`reference pull:   ${python("whatsapp-mcp-pull.py", "--store", frozen, "--out", payload).replace(/→.*$/, "")}`);
console.log(`reference apply:  ${python("whatsapp-mcp-format.py", "--apply", payload).split("\n")[0]}`);

const optional = (path) => (existsSync(path) ? path : undefined);
const result = await exportWhatsApp({
  storePath: frozen,
  vault: smcp,
  folder: FOLDER,
  statePath: join(work, "smcp-state.json"),
  aliasesPath: join(work, "smcp-aliases.json"),
  seedStatePath: optional(join(smcp, "scripts", STATE[0])),
  seedAliasesPath: optional(join(smcp, "scripts", STATE[1])),
  senderAliasesPath: optional(join(smcp, "scripts", STATE[2])),
  ownName,
  timeZone,
  // The same moment the reference started, so the 90-day horizon for new chats falls in the same place.
  now: () => startedAt,
});
console.log(`SMCP export:      ${result.report.messagesWritten} message(s) in ${result.report.chatsTouched} chat(s); ${result.report.notesCreated} new note(s)`);

function listFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, path, out);
    else out.push(relative(root, path));
  }
  return out.sort();
}
const left = existsSync(join(reference, FOLDER)) ? listFiles(join(reference, FOLDER)) : [];
const right = existsSync(join(smcp, FOLDER)) ? listFiles(join(smcp, FOLDER)) : [];
const onlyReference = left.filter((file) => !right.includes(file));
const onlySmcp = right.filter((file) => !left.includes(file));
const different = left.filter((file) => right.includes(file) && !readFileSync(join(reference, FOLDER, file)).equals(readFileSync(join(smcp, FOLDER, file))));

console.log(`\nfiles compared:   ${left.filter((file) => right.includes(file)).length} (${left.reduce((sum, file) => sum + statSync(join(reference, FOLDER, file)).size, 0)} bytes)`);
const show = (title, files) => {
  if (!files.length) return;
  console.log(`\n${title} (${files.length}):`);
  for (const file of files.slice(0, 30)) console.log(`  ${file}`);
  if (files.length > 30) console.log(`  … and ${files.length - 30} more`);
};
show("only the reference scripts wrote", onlyReference);
show("only SMCP wrote", onlySmcp);
show("different content", different);

const identical = !onlyReference.length && !onlySmcp.length && !different.length;
console.log(identical ? "\nIDENTICAL: SMCP's export wrote exactly what the reference scripts wrote." : "\nDIFFERENT: do not retire the reference scripts yet.");
if (args.includes("--keep") || !identical) console.log(`The two copies are in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(identical ? 0 : 1);
