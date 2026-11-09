// Runs the test suite the same way on macOS, Linux and Windows, where npm scripts run in cmd.exe
// and cannot set variables inline or expand test/*.test.js.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(ROOT, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("test", name));

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, SMCP_AUDIT: process.env.SMCP_AUDIT ?? join(tmpdir(), "smcp-test-audit.jsonl") },
});
process.exit(result.status ?? 1);
