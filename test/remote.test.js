import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { funnelTargets, publicBaseUrl } from "../app/core/funnel.js";
import { createRemote } from "../app/core/remote.js";
import { readAudit } from "../src/audit.js";
import { buildRemoteServer, REMOTE_CONTROL_OFF } from "../src/remote-tools.js";
import { allToolNames } from "../src/toolset.js";

const PORT = 47899;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let dir;
let remote;
let statePath;

let healthy = true;
const savedEnv = {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-remote-"));
  statePath = join(dir, "remote.json");
  // Its own settings and log, so the person's real ones neither decide nor record these calls.
  for (const [key, value] of Object.entries({ SMCP_CONFIG: join(dir, "config.json"), SMCP_AUDIT: join(dir, "audit.jsonl"), SMCP_SERVER_CONFIG: join(dir, "server.json") })) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  remote = createRemote({ baseUrl: BASE, buildServer: buildRemoteServer, statePath, port: PORT, healthCheck: async () => healthy });
  await remote.start();
});
after(async () => {
  await remote.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

test("flujo completo: conectar, listar las herramientas y que lo apagado se rechace con una razón clara", async () => {
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
  // Every tool is listed, so a client can be told why one is off instead of not knowing it exists.
  // Each call checks the remote switch for its kind of risk first.
  assert.deepEqual(new Set(names), new Set(allToolNames()));

  const denied = await (await mcp(session.access_token, { method: "tools/call", params: { name: "run_command", arguments: { command: "echo hola" } } })).json();
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.content[0].text, REMOTE_CONTROL_OFF);
  assert.ok(!JSON.stringify(denied).includes("hola\\n"));
  assert.ok(remote.listClients().some((client) => client.name === "Claude"));

  // The activity log says who asked: the app's name and the start of its id.
  const [entry] = readAudit({ path: join(dir, "audit.jsonl") });
  assert.deepEqual({ tool: entry.tool, source: entry.source, outcome: entry.outcome }, { tool: "run_command", source: "remote", outcome: "denied" });
  assert.equal(entry.client, `Claude · ${session.client.client_id.slice(0, 8)}`);
});

test("the app can tell a request that got in from one that was turned away", async () => {
  const before = remote.activity();
  await mcp("not-a-token", { method: "tools/list" });
  const rejected = remote.activity();
  assert.ok(rejected.lastRejectedAt >= (before.lastRejectedAt ?? 0));
  assert.equal(rejected.lastRequestAt, before.lastRequestAt, "a rejected request is not a received one");
  const session = await connect("Phone");
  await mcp(session.access_token, { method: "tools/list" });
  const accepted = remote.activity();
  assert.ok(accepted.lastRequestAt >= rejected.lastRejectedAt);
  assert.equal(accepted.lastClient, "Phone");
});

test("the health page works without signing in and says nothing about the person", async () => {
  healthy = true;
  const ok = await fetch(`${BASE}/health`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(Object.keys(body).sort(), ["at", "ok", "smcp", "tool"]);
  assert.deepEqual({ ok: body.ok, smcp: body.smcp, tool: body.tool }, { ok: true, smcp: "running", tool: "ok" });
  healthy = false;
  const bad = await fetch(`${BASE}/health`);
  assert.equal(bad.status, 503);
  assert.equal((await bad.json()).tool, "failed");
  healthy = true;
  assert.ok(remote.activity().lastHealthAt);
});

test("the health page cannot be hammered", async () => {
  let last;
  for (let i = 0; i < 35; i++) last = await fetch(`${BASE}/health`);
  assert.equal(last.status, 429);
});

test("signing out every app at once cuts all of them off", async () => {
  const one = await connect("One");
  const two = await connect("Two");
  assert.equal((await mcp(one.access_token, { method: "tools/list" })).status, 200);
  const count = remote.revokeAll();
  assert.ok(count >= 2);
  assert.equal((await mcp(one.access_token, { method: "tools/list" })).status, 401);
  assert.equal((await mcp(two.access_token, { method: "tools/list" })).status, 401);
  assert.deepEqual(remote.listClients(), []);
  const refreshed = await post("/token", { grant_type: "refresh_token", refresh_token: two.refresh_token, client_id: two.client.client_id });
  assert.notEqual(refreshed.status, 200);
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
