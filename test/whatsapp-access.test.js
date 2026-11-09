import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { denialFor, readPolicy, WHATSAPP_TOOL_ABILITIES, writePolicy } from "../src/policy.js";
import { buildRemoteServer } from "../src/remote-tools.js";
import { registerWhatsApp } from "../src/tools/whatsapp.js";

const READ = { readOnlyHint: true };
const SEND = { readOnlyHint: false, destructiveHint: true };
const LOCAL = { readOnlyHint: false, destructiveHint: false };
const JID = "5215512345678@s.whatsapp.net";

const allOn = { whatsapp: false, gmail: false, notes: false, tasks: false, files: false, terminal: false, apps: false };
const policyWith = (whatsapp, extra = {}) => ({ paused: false, readOnly: false, disabled: { ...allOn }, whatsapp, ...extra });

let dir;
let wacli;
let log;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-wa-access-"));
  wacli = join(dir, "wacli");
  log = join(dir, "calls.log");
  await writeFile(wacli, `#!/bin/sh\necho "$*" >> "${log}"\necho '{"success":true,"data":{"messages":[]}}'\n`);
  await chmod(wacli, 0o755);
});
after(() => rm(dir, { recursive: true, force: true }));

const calls = () => readFile(log, "utf8").catch(() => "");

test("cada herramienta de WhatsApp tiene un permiso definido", () => {
  const names = [];
  registerWhatsApp({ registerTool: (name) => names.push(name) });
  assert.deepEqual(names.sort(), Object.keys(WHATSAPP_TOOL_ABILITIES).sort());
});

test("una herramienta nueva sin permiso definido se niega", () => {
  assert.match(denialFor("whatsapp_borrar_todo", READ, policyWith({ read: true, send: true })), /no tiene un permiso/);
});

test("solo leer permite leer y bloquea escribir con un error claro", () => {
  const policy = policyWith({ read: true, send: false });
  for (const name of ["whatsapp_status", "whatsapp_list_chats", "whatsapp_read_messages", "whatsapp_search_messages", "whatsapp_search_contacts"]) {
    assert.equal(denialFor(name, READ, policy), null, name);
  }
  assert.equal(denialFor("whatsapp_sync", LOCAL, policy), null);
  assert.match(denialFor("whatsapp_send", SEND, policy), /Escribir por WhatsApp está apagado.*no se envió nada/);
});

test("solo escribir encuentra el chat, pero no lee mensajes", () => {
  const policy = policyWith({ read: false, send: true });
  assert.equal(denialFor("whatsapp_send", SEND, policy), null);
  assert.equal(denialFor("whatsapp_list_chats", READ, policy), null);
  assert.equal(denialFor("whatsapp_search_contacts", READ, policy), null);
  for (const name of ["whatsapp_read_messages", "whatsapp_search_messages"]) {
    assert.match(denialFor(name, READ, policy), /Leer los chats de WhatsApp está apagado/, name);
  }
  assert.match(denialFor("whatsapp_sync", LOCAL, policy), /Leer los chats/);
});

test("con todo apagado solo queda el estado de la vinculación", () => {
  const policy = policyWith({ read: false, send: false });
  assert.equal(denialFor("whatsapp_status", READ, policy), null);
  assert.match(denialFor("whatsapp_list_chats", READ, policy), /Leer y escribir por WhatsApp están apagados/);
  assert.match(denialFor("whatsapp_send", SEND, policy), /apagado/);
});

test("la pausa, el grupo apagado y solo lectura siguen ganando sobre la elección", () => {
  const open = { read: true, send: true };
  assert.match(denialFor("whatsapp_send", SEND, policyWith(open, { paused: true })), /pausa/);
  assert.match(denialFor("whatsapp_send", SEND, policyWith(open, { readOnly: true })), /solo lectura/);
  assert.match(denialFor("whatsapp_read_messages", READ, policyWith(open, { disabled: { ...allOn, whatsapp: true } })), /desactivado/);
});

test("una instalación nueva lee, pero escribir hay que encenderlo", () => {
  assert.deepEqual(readPolicy(join(dir, "no-existe.json")).whatsapp, { read: true, send: false, audio: false });
});

test("los ajustes guardados antes de esta opción conservan lo que ya hacían", async () => {
  const path = join(dir, "antes.json");
  await writeFile(path, JSON.stringify({ paused: false, readOnly: false, disabled: {} }));
  assert.deepEqual(readPolicy(path).whatsapp, { read: true, send: true, audio: false });
});

test("guarda la elección; lo que no sea true queda apagado y no admite campos extra", async () => {
  const path = join(dir, "eleccion.json");
  writePolicy(policyWith({ read: false, send: true }), path);
  assert.deepEqual(readPolicy(path).whatsapp, { read: false, send: true, audio: false });
  await writeFile(path, JSON.stringify({ whatsapp: { read: "yes", send: 1, sinConfirmar: true } }));
  assert.deepEqual(readPolicy(path).whatsapp, { read: false, send: false, audio: false });
  await writeFile(path, JSON.stringify({ whatsapp: null }));
  assert.deepEqual(readPolicy(path).whatsapp, { read: false, send: false, audio: false });
});

test("el servidor aplica la elección en cada llamada, sin llegar a wacli ni a la confirmación", async () => {
  const config = join(dir, "server.json");
  writePolicy(policyWith({ read: true, send: false }), config);
  const entry = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "index.js");
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, SMCP_CONFIG: config, WACLI_BIN: wacli, WACLI_STORE_DIR: join(dir, "store"), SMCP_SOCKET: join(dir, "no.sock") },
    }),
  );
  const readTool = { name: "whatsapp_read_messages", arguments: { chat: JID } };
  try {
    const denied = await client.callTool({ name: "whatsapp_send", arguments: { to: JID, message: "hola" } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /no se envió nada/);
    assert.doesNotMatch(await calls(), /send/);

    assert.equal((await client.callTool(readTool)).isError, undefined);
    assert.match(await calls(), /messages list/);

    await writeFile(log, "");
    writePolicy(policyWith({ read: false, send: false }), config);
    const off = await client.callTool(readTool);
    assert.equal(off.isError, true);
    assert.match(off.content[0].text, /Leer los chats/);
    assert.equal(await calls(), "");
  } finally {
    await client.close();
  }
});

test("el acceso remoto respeta la misma elección", async () => {
  const config = join(dir, "remoto.json");
  writePolicy(policyWith({ read: false, send: false }), config);
  const previous = { config: process.env.SMCP_CONFIG, bin: process.env.WACLI_BIN };
  process.env.SMCP_CONFIG = config;
  process.env.WACLI_BIN = wacli;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildRemoteServer();
  const client = new Client({ name: "test", version: "1" });
  try {
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const denied = await client.callTool({ name: "whatsapp_read_messages", arguments: { chat: JID } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Leer los chats/);
    const { tools } = await client.listTools();
    assert.ok(!tools.some((tool) => tool.name === "whatsapp_send"));
  } finally {
    await client.close();
    for (const [key, value] of [["SMCP_CONFIG", previous.config], ["WACLI_BIN", previous.bin]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
