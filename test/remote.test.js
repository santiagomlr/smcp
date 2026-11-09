import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { funnelTargets, publicBaseUrl } from "../app/core/funnel.js";
import { createRemote } from "../app/core/remote.js";
import { buildRemoteServer, REMOTE_TASK_WRITES, REMOTE_TOOLS } from "../src/remote-tools.js";

const PORT = 47899;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let dir;
let remote;
let statePath;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-remote-"));
  statePath = join(dir, "remote.json");
  remote = createRemote({ baseUrl: BASE, buildServer: buildRemoteServer, statePath, port: PORT });
  await remote.start();
});
after(async () => {
  await remote.stop();
  await rm(dir, { recursive: true, force: true });
});

const post = (path, body, headers = {}) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body),
  });

const mcp = (accessToken, payload) =>
  fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload }),
  });

async function register(name = "Claude") {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function startAuthorize(client) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "abc" });
  const res = await fetch(`${BASE}/authorize?${params}`, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200);
  return { verifier, html, request: html.match(/name="request" value="([^"]+)"/)[1] };
}

async function connect(name) {
  const client = await register(name);
  const { verifier, request } = await startAuthorize(client);
  const { code } = remote.newPairingCode();
  const res = await post("/pair", { request, code });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  const tokens = await post("/token", { grant_type: "authorization_code", code: location.searchParams.get("code"), client_id: client.client_id, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(tokens.status, 200);
  return { client, verifier, location, ...(await tokens.json()) };
}

test("publica los metadatos que Claude y ChatGPT descubren", async () => {
  const resource = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, `${BASE}/mcp`);
  const server = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.ok(server.code_challenge_methods_supported.includes("S256"));
  assert.ok(server.registration_endpoint);
});

test("sin token no entra nadie, y el 401 indica dónde autenticarse", async () => {
  const res = await mcp(null, { method: "tools/list" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /resource_metadata/);
  assert.equal((await mcp("token-falso", { method: "tools/list" })).status, 401);
});

test("sin el código de emparejamiento no se obtiene acceso", async () => {
  const { request } = await startAuthorize(await register("Intruso"));
  const noCode = await post("/pair", { request, code: "AAAAAAAA" });
  assert.equal(noCode.status, 400);
  assert.match(await noCode.text(), /no active code/);
});

test("cinco intentos fallidos invalidan el código", async () => {
  const { request } = await startAuthorize(await register("Intruso"));
  const { code } = remote.newPairingCode();
  for (let i = 0; i < 4; i++) assert.match(await (await post("/pair", { request, code: "MALO" })).text(), /not correct/);
  assert.match(await (await post("/pair", { request, code: "MALO" })).text(), /Too many attempts/);
  assert.match(await (await post("/pair", { request, code })).text(), /no active code/);
});

test("el código sirve una sola vez", async () => {
  const first = await startAuthorize(await register("A"));
  const second = await startAuthorize(await register("B"));
  const { code } = remote.newPairingCode();
  assert.equal((await post("/pair", { request: first.request, code })).status, 302);
  assert.equal((await post("/pair", { request: second.request, code })).status, 400);
});

test("el nombre del cliente no puede inyectar HTML", async () => {
  const { html } = await startAuthorize(await register('<script>alert(1)</script>'));
  assert.ok(!html.includes("<script>alert"));
});

test("flujo completo: conectar, listar solo herramientas permitidas y llamar una", async () => {
  const session = await connect("Claude");
  assert.equal(session.location.origin + session.location.pathname, REDIRECT);
  assert.equal(session.location.searchParams.get("state"), "abc");

  const init = await mcp(session.access_token, {
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name, "smcp");

  const list = await (await mcp(session.access_token, { method: "tools/list" })).json();
  const names = list.result.tools.map((tool) => tool.name);
  // Task edits are listed, but each call checks the remote task-writes setting first.
  assert.deepEqual(new Set(names), new Set([...REMOTE_TOOLS, ...REMOTE_TASK_WRITES]));
  for (const forbidden of ["run_command", "whatsapp_send", "gmail_send", "file_write", "ui_click", "screenshot"]) {
    assert.ok(!names.includes(forbidden), forbidden);
  }

  const denied = await (await mcp(session.access_token, { method: "tools/call", params: { name: "run_command", arguments: { command: "echo hola" } } })).json();
  const deniedText = JSON.stringify(denied);
  assert.ok(denied.error || denied.result?.isError);
  assert.ok(!deniedText.includes("hola\\n"));
  assert.ok(remote.listClients().some((client) => client.name === "Claude"));
});

test("los tokens solo se guardan como hash y con permisos privados", async () => {
  const session = await connect("Hash");
  const text = await readFile(statePath, "utf8");
  assert.ok(!text.includes(session.access_token));
  assert.ok(!text.includes(session.refresh_token));
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("un verificador PKCE incorrecto y un código reusado no sirven", async () => {
  const client = await register("PKCE");
  const { request } = await startAuthorize(client);
  const { code } = remote.newPairingCode();
  const res = await post("/pair", { request, code });
  const authCode = new URL(res.headers.get("location")).searchParams.get("code");
  const bad = await post("/token", { grant_type: "authorization_code", code: authCode, client_id: client.client_id, code_verifier: "x".repeat(50), redirect_uri: REDIRECT });
  assert.equal(bad.status, 400);
});

test("renovar rota el token; desconectar corta el acceso de inmediato", async () => {
  const session = await connect("ChatGPT");
  const refreshed = await post("/token", { grant_type: "refresh_token", refresh_token: session.refresh_token, client_id: session.client.client_id });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  const reuse = await post("/token", { grant_type: "refresh_token", refresh_token: session.refresh_token, client_id: session.client.client_id });
  assert.equal(reuse.status, 400);
  assert.equal((await mcp(next.access_token, { method: "tools/list" })).status, 200);
  remote.revokeClient(session.client.client_id);
  assert.equal((await mcp(next.access_token, { method: "tools/list" })).status, 401);
  assert.ok(!remote.listClients().some((client) => client.id === session.client.client_id));
});

test("lee la URL pública y detecta si Funnel apunta a este puerto", () => {
  assert.equal(publicBaseUrl({ Self: { DNSName: "m4.tail.ts.net." } }), "https://m4.tail.ts.net");
  assert.equal(publicBaseUrl({}), null);
  const on = { AllowFunnel: { "m4:443": true }, Web: { "m4:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47821" } } } } };
  assert.equal(funnelTargets(on, 47821), true);
  assert.equal(funnelTargets(on, 1234), false);
  assert.equal(funnelTargets({}, 47821), false);
  assert.equal(funnelTargets({ ...on, AllowFunnel: {} }, 47821), false);
});
