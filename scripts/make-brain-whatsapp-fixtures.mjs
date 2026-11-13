// Rebuilds the golden files of the WhatsApp exporter's tests by running the reference scripts
// (the two Python programs the exporter replaces) on the synthetic scenario.
//
//   node scripts/make-brain-whatsapp-fixtures.mjs /path/to/the/folder/with/the/reference/scripts
//
// It needs python3 and the sqlite3 command-line tool. Nothing from the reference scripts is
// copied into this repository: they run in a temporary folder that is deleted at the end, and
// only what they wrote from the invented data is kept.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REFERENCE_SCRIPTS, WA_FOLDER, findCommand, loadSql, readTree, runReference, writeTree } from "../test/fixtures/brain-whatsapp/harness.mjs";
import { buildScenario } from "../test/fixtures/brain-whatsapp/scenario.mjs";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "brain-whatsapp", "golden");

const scriptsDir = process.argv[2] ? resolve(process.argv[2]) : "";
if (!scriptsDir || REFERENCE_SCRIPTS.some((name) => !existsSync(join(scriptsDir, name)))) {
  console.error(`Give the folder that holds ${REFERENCE_SCRIPTS.join(" and ")}.`);
  process.exit(1);
}
const python = findCommand(["python3", "python"], "--version");
if (!python || !findCommand(["sqlite3"], "-version")) {
  console.error("python3 and sqlite3 are both needed to rebuild the golden files.");
  process.exit(1);
}

const scenario = buildScenario(new Date());
const work = mkdtempSync(join(tmpdir(), "smcp-wa-golden-"));
try {
  const vault = join(work, "vault");
  const storePath = join(work, "store", "wacli.db");
  mkdirSync(dirname(storePath), { recursive: true });
  writeTree(vault, scenario.seed);

  rmSync(GOLDEN, { recursive: true, force: true });
  writeTree(GOLDEN, { "run1.sql": scenario.run1, "run2.sql": scenario.run2 });
  writeTree(join(GOLDEN, "seed"), scenario.seed);

  for (const [index, sql] of [scenario.run1, scenario.run2].entries()) {
    const run = index + 1;
    // The reference reads the real clock; the tests give this same moment to the exporter.
    const now = new Date().toISOString();
    loadSql(storePath, sql);
    const reference = runReference({ python, scriptsDir, vault, storePath });
    writeTree(join(GOLDEN, `expected-${run}`), readTree(join(vault, ...WA_FOLDER.split("/"))));
    writeFileSync(join(GOLDEN, `reference-${run}.json`), `${JSON.stringify({ now, ...reference }, null, 2)}\n`);
    console.log(`run ${run}: ${reference.report.messages_written} messages in ${reference.report.chats_touched} chats, ${Object.keys(readTree(join(GOLDEN, `expected-${run}`))).length} files`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Golden files written to ${GOLDEN}`);
