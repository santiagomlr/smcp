import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listDir, readText, resolveSafe, searchFiles, writeText } from "../src/tools/files.js";
import { runCommand } from "../src/tools/terminal.js";

let dir;
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "smcp-test-")));
});
after(() => rm(dir, { recursive: true, force: true }));

const payload = (result) => JSON.parse(result.content[0].text);

test("bloquea credenciales, también a través de symlinks y ..", async () => {
  const ssh = join(homedir(), ".ssh", "id_rsa");
  await assert.rejects(resolveSafe(ssh), /blocked/);
  await assert.rejects(resolveSafe("~/.aws/credentials"), /blocked/);
  await assert.rejects(resolveSafe(join(homedir(), "x", "..", ".wacli", "session.db")), /blocked/);
  const link = join(dir, "link-a-ssh");
  await symlink(join(homedir(), ".gnupg"), link);
  await assert.rejects(resolveSafe(join(link, "nuevo.txt")), /blocked/);
});

test("rechaza rutas relativas", async () => {
  await assert.rejects(resolveSafe("algo/archivo.txt"), /absolute/);
});

test("create no sobrescribe; overwrite y append sí cambian", async () => {
  const file = join(dir, "sub", "a.txt");
  await writeText({ path: file, content: "uno", mode: "create" });
  await assert.rejects(writeText({ path: file, content: "dos", mode: "create" }), /EEXIST/);
  assert.equal(await readFile(file, "utf8"), "uno");
  await writeText({ path: file, content: "-dos", mode: "append" });
  assert.equal(await readFile(file, "utf8"), "uno-dos");
  await writeText({ path: file, content: "tres", mode: "overwrite" });
  assert.equal(await readFile(file, "utf8"), "tres");
});

test("lee por partes y rechaza binarios", async () => {
  const file = join(dir, "largo.txt");
  await writeFile(file, "abcdefghij");
  const first = payload(await readText({ path: file, offset: 0, max_bytes: 4 }));
  assert.equal(first.data.content, "abcd");
  assert.equal(first.data.next_offset, 4);
  const last = payload(await readText({ path: file, offset: 8, max_bytes: 4 }));
  assert.equal(last.data.content, "ij");
  assert.equal(last.data.next_offset, null);
  const binary = join(dir, "b.bin");
  await writeFile(binary, Buffer.from([1, 0, 2]));
  await assert.rejects(readText({ path: binary, offset: 0, max_bytes: 10 }), /binary/);
});

test("lista y busca por nombre", async () => {
  await writeText({ path: join(dir, "x", "y", "Reporte-Final.txt"), content: "z", mode: "create" });
  const found = payload(await searchFiles({ root: dir, name: "reporte", limit: 10 }));
  assert.equal(found.data.matches.length, 1);
  assert.equal(found.data.complete, true);
  const listed = payload(await listDir({ path: join(dir, "x"), limit: 10 }));
  assert.equal(listed.data.items[0].name, "y");
  assert.equal(listed.data.items[0].type, "dir");
});

test("run_command devuelve salida y código de salida", async () => {
  const ok = payload(await runCommand({ command: "echo hola; echo mal >&2; exit 3", cwd: dir, timeout_seconds: 10 }));
  assert.equal(ok.stdout.trim().split("\n").at(-1), "hola");
  assert.match(ok.stderr, /mal/);
  assert.equal(ok.exit_code, 3);
});

test("run_command detiene también a los procesos hijos al agotar el tiempo", async () => {
  const marker = join(dir, "no-debe-existir");
  const started = Date.now();
  const result = payload(
    await runCommand({ command: `(sleep 3; touch '${marker}') & sleep 30`, cwd: dir, timeout_seconds: 1 }),
  );
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - started < 10_000);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await assert.rejects(readFile(marker));
});
