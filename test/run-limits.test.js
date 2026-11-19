// A long-running SMCP must survive running out of file descriptors and must not keep pipes forever.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run, shareCalls } from "../src/util.js";
import { startInBackground } from "../src/vpn.js";

const posix = process.platform !== "win32";
const UTIL = pathToFileURL(fileURLToPath(new URL("../src/util.js", import.meta.url))).href;
let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-limits-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("out of file descriptors, run() reports the error instead of crashing the app", { skip: !posix }, async () => {
  const script = join(dir, "emfile.mjs");
  await writeFile(
    script,
    `import { closeSync, openSync } from "node:fs";
import { run } from ${JSON.stringify(UTIL)};
// Open stdout before running out: Node opens it lazily and would fail to print the result.
process.stdout.write("");
const held = [];
const release = () => { for (const fd of held.splice(0)) closeSync(fd); };
process.on("uncaughtException", (error) => { release(); console.log("CRASH " + error.message); process.exit(3); });
try { for (;;) held.push(openSync(process.execPath, "r")); } catch {}
// One free descriptor: too few for the pipes a child needs, so spawning must fail.
closeSync(held.pop());
const result = await run("/bin/echo", ["hi"]);
release();
console.log(result.spawnError ? "REPORTED " + result.spawnError.code : "RAN");
`,
  );
  const result = spawnSync("/bin/sh", ["-c", `ulimit -n 64 && exec "${process.execPath}" "${script}"`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /REPORTED E[MN]FILE/);
});

test("a child whose background job keeps the output open does not hold run() forever", { skip: !posix }, async () => {
  const started = Date.now();
  const result = await run("/bin/sh", ["-c", "sleep 6 & echo hi"], { timeoutMs: 20_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hi\n");
  assert.ok(Date.now() - started < 5_000, "finished after a short grace, not when the background job ended");
});

test("starting a VPN in the background does not keep the log open in SMCP", { skip: process.platform !== "linux" && process.platform !== "darwin" }, async () => {
  const count = async () => (await readdir("/dev/fd")).length;
  const start = startInBackground(join(dir, "vpn.log"));
  const before = await count();
  for (let i = 0; i < 5; i += 1) start("/bin/sh", ["-c", "exit 0"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok((await count()) <= before + 1, "no descriptor left behind per start");
});

test("shareCalls gives everyone asking at once the same answer, and asks again afterwards", async () => {
  let calls = 0;
  const shared = shareCalls(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return calls;
  });
  assert.deepEqual(await Promise.all([shared(), shared(), shared()]), [1, 1, 1]);
  assert.equal(await shared(), 2);
  let clock = 0;
  const reused = shareCalls(async () => (calls += 1), { reuseMs: 1_000, now: () => clock });
  const first = await reused();
  clock = 500;
  assert.equal(await reused(), first);
  reused.invalidate();
  assert.equal(await reused(), first + 1);
});
