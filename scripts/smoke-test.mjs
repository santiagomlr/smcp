// Starts the real SMCP app in smoke-test mode and exits with its result: 0 if every window opened cleanly.
// Usage: node scripts/smoke-test.mjs [path to a packaged SMCP executable]
// Without a path it runs the app from source with the Electron in node_modules.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 180_000;

const packaged = process.argv[2];
const command = packaged ?? createRequire(import.meta.url)("electron");
const args = packaged ? [] : [ROOT];
// From source, Electron's sandbox helper is not set up the way an installed package sets it up, so CI skips it.
// Packaged runs keep the sandbox, which is what people get.
if (process.env.SMCP_SMOKE_NO_SANDBOX) args.push("--no-sandbox");

// A fresh home so the check starts like a first launch and never touches the real ~/.smcp.
// On Windows, Chromium reads the profile folder from USERPROFILE while starting and crashes if it points
// at an empty folder, so it keeps the real one there (CI runners start empty anyway).
const home = mkdtempSync(join(tmpdir(), "smcp-smoke-"));
const homeEnv = process.platform === "win32" ? {} : { HOME: home };
const child = spawn(command, args, {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, ...homeEnv, SMCP_SMOKE_TEST: "1", ELECTRON_ENABLE_LOGGING: "1" },
});

const timer = setTimeout(() => {
  console.error(`SMCP smoke test failed: the app did not finish within ${TIMEOUT_MS / 1000}s.`);
  child.kill("SIGKILL");
  process.exitCode = 1;
}, TIMEOUT_MS);

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(`SMCP smoke test failed: could not start ${command}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  if (code !== 0) console.error(`SMCP exited with ${signal ?? `code ${code}`}.`);
  process.exitCode ||= code === 0 ? 0 : 1;
});
