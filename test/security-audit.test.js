// Regressions for the findings of the security audit in SECURITY.md.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPeerHub } from "../app/core/peers.js";
import { createRemote, redirectHost } from "../app/core/remote.js";
import { createTasksHub, fromBrowser } from "../app/core/tasks-hub.js";
import { isBlocked } from "../src/tools/files.js";

// A page that rebinds its own name to 127.0.0.1 sends a same-origin POST: it may set any header,
// but the browser always adds Origin. The forged header is what Tailscale Serve would normally set.
const rebound = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { origin: "http://attacker.example:" + port, "sec-fetch-site": "same-origin", "tailscale-user-login": "owner", "content-type": "text/plain" },
    body: JSON.stringify(body),
  });

test("SEC-1: el hub de computadoras rechaza páginas web aunque falsifiquen la identidad de Tailscale", async () => {
  let read = 0;
  const hub = createPeerHub({
    owner: "owner",
    port: 47871,
    handlers: { info: () => ({ ok: true }), whatsapp: async () => (read += 1) },
  });
  await hub.start();
  try {
    const res = await rebound(47871, "/peer", { op: "whatsapp", args: { args: ["messages", "list"] } });
    assert.equal(res.status, 403);
    assert.equal(read, 0);
    // SMCP's own calls carry no Origin, so they keep working.
    const own = await fetch("http://127.0.0.1:47871/peer", { method: "POST", headers: { "tailscale-user-login": "owner" }, body: JSON.stringify({ op: "info" }) });
    assert.deepEqual(await own.json(), { value: { ok: true } });
  } finally {
    await hub.stop();
  }
});

test("SEC-1: el hub de tareas rechaza páginas web aunque falsifiquen la identidad de Tailscale", async () => {
  let calls = 0;
  const store = { summary: () => (calls += 1) };
  const hub = createTasksHub({ store, port: 47872, owner: "owner" });
  await hub.start();
  try {
    const res = await rebound(47872, "/tasks", { op: "summary" });
    assert.equal(res.status, 403);
    assert.equal(calls, 0);
  } finally {
    await hub.stop();
  }
  assert.equal(fromBrowser({ headers: {} }), false);
  assert.equal(fromBrowser({ headers: { origin: "null" } }), true);
  assert.equal(fromBrowser({ headers: { "sec-fetch-site": "same-origin" } }), true);
  // Node's fetch, which SMCP uses between computers, sends Sec-Fetch-Mode but no Origin.
  assert.equal(fromBrowser({ headers: { "sec-fetch-mode": "cors" } }), false);
});

test("SEC-2: la página de emparejamiento dice a dónde se enviará el acceso", async () => {
  assert.equal(redirectHost("https://evil.example/cb?x=1"), "evil.example");
  assert.equal(redirectHost("not a url"), "not a url");
  const dir = await mkdtemp(join(tmpdir(), "smcp-audit-"));
  const port = 47873;
  const base = `http://127.0.0.1:${port}`;
  const remote = createRemote({ baseUrl: base, buildServer: () => null, statePath: join(dir, "remote.json"), port });
  await remote.start();
  try {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
    });
    const client = await reg.json();
    const params = new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: "https://evil.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    const html = await (await fetch(`${base}/authorize?${params}`)).text();
    assert.match(html, /Access will be sent to <strong>evil\.example<\/strong>/);
  } finally {
    await remote.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SEC-3: la lista de rutas bloqueadas no se salta cambiando mayúsculas en discos que las ignoran", () => {
  const home = homedir();
  assert.equal(isBlocked(join(home, ".SSH", "id_ed25519"), { ignoreCase: true }), true);
  assert.equal(isBlocked(join(home, "library", "keychains", "login.keychain-db"), { ignoreCase: true }), true);
  // On a case-sensitive disk (Linux) ~/.SSH really is another folder.
  assert.equal(isBlocked(join(home, ".SSH", "id_ed25519"), { ignoreCase: false }), false);
  for (const path of [".git-credentials", ".pypirc", ".password-store", join(".local", "share", "keyrings"), join("Library", "Application Support", "BraveSoftware")]) {
    assert.equal(isBlocked(join(home, path)), true, path);
  }
  assert.equal(isBlocked(join(home, "Documents", "SSH notes.md"), { ignoreCase: true }), false);
});
