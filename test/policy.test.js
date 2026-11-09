import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { denialFor, readPolicy, toolGroup, writePolicy } from "../src/policy.js";
import { resolveSafe } from "../src/tools/files.js";

const READ = { readOnlyHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true };
const LOCAL = { readOnlyHint: false, destructiveHint: false };
const base = () => ({ paused: false, readOnly: false, disabled: { whatsapp: false, gmail: false, notes: false, tasks: false, files: false, terminal: false, apps: false }, whatsapp: { read: true, send: true } });

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-policy-"));
});
after(() => rm(dir, { recursive: true, force: true }));

test("clasifica cada herramienta en su grupo", () => {
  assert.equal(toolGroup("whatsapp_send"), "whatsapp");
  assert.equal(toolGroup("file_read"), "files");
  assert.equal(toolGroup("run_command"), "terminal");
  for (const name of ["ui_click", "app_list", "window_list", "screenshot"]) assert.equal(toolGroup(name), "apps");
});

test("la pausa bloquea todo, incluso lecturas", () => {
  assert.match(denialFor("file_read", READ, { ...base(), paused: true }), /pausa/);
});

test("solo lectura permite leer y bloquea acciones", () => {
  const policy = { ...base(), readOnly: true };
  assert.equal(denialFor("file_read", READ, policy), null);
  assert.match(denialFor("whatsapp_send", WRITE, policy), /solo lectura/);
  assert.match(denialFor("run_command", WRITE, policy), /solo lectura/);
  assert.equal(denialFor("whatsapp_sync", LOCAL, policy), null);
  assert.match(denialFor("algo_nuevo", undefined, policy), /solo lectura/);
});

test("desactivar un grupo bloquea solo ese grupo", () => {
  const policy = base();
  policy.disabled.terminal = true;
  assert.match(denialFor("run_command", WRITE, policy), /desactivado/);
  assert.equal(denialFor("file_write", WRITE, policy), null);
});

test("sin archivo no hay restricciones; un archivo dañado pausa todo", async () => {
  assert.equal(readPolicy(join(dir, "no-existe.json")).paused, false);
  const broken = join(dir, "roto.json");
  await writeFile(broken, "{ no json");
  assert.equal(readPolicy(broken).paused, true);
});

test("guarda y lee; ignora valores que no son booleanos", async () => {
  const path = join(dir, "c.json");
  writePolicy({ ...base(), readOnly: true }, path);
  assert.equal(readPolicy(path).readOnly, true);
  await writeFile(path, JSON.stringify({ paused: "yes", disabled: { files: 1, terminal: true } }));
  const policy = readPolicy(path);
  assert.equal(policy.paused, false);
  assert.equal(policy.disabled.files, false);
  assert.equal(policy.disabled.terminal, true);
});

test("las herramientas de archivos no pueden tocar los ajustes de SMCP", async () => {
  await assert.rejects(resolveSafe(join(homedir(), ".smcp", "config.json")), /bloqueada/);
});

test("el servidor aplica los cambios en la siguiente llamada, sin reiniciar", async () => {
  const config = join(dir, "server.json");
  const entry = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "index.js");
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, SMCP_CONFIG: config } }),
  );
  const command = { name: "run_command", arguments: { command: "echo corrio" } };
  try {
    assert.match((await client.callTool(command)).content[0].text, /desactivado/);
    writePolicy(base(), config);
    assert.match((await client.callTool(command)).content[0].text, /corrio/);
    writePolicy({ ...base(), paused: true }, config);
    const paused = await client.callTool(command);
    assert.equal(paused.isError, true);
    assert.match(paused.content[0].text, /pausa/);
    writePolicy({ ...base(), readOnly: true }, config);
    assert.match((await client.callTool(command)).content[0].text, /solo lectura/);
    writePolicy(base(), config);
    assert.match((await client.callTool(command)).content[0].text, /corrio/);
  } finally {
    await client.close();
  }
});
