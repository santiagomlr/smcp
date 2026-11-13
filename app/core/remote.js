// Remote MCP endpoint for clients that connect from their own cloud (Claude web and mobile, ChatGPT).
// Only reachable with an OAuth token, and a token requires a pairing code shown in the SMCP app.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

export const REMOTE_PORT = 47821;

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_CLIENTS = 50;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function defaultRemoteStatePath() {
  return join(homedir(), ".smcp", "remote.json");
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--bg:oklch(.975 .005 172);--ink:oklch(.25 .022 172);--muted:oklch(.5 .018 172);--rule:oklch(.86 .012 172);--accent:oklch(.45 .08 172);--on:oklch(.98 .006 172);--warn:oklch(.54 .12 48)}
@media(prefers-color-scheme:dark){:root{--bg:oklch(.2 .012 172);--ink:oklch(.94 .008 172);--muted:oklch(.71 .016 172);--rule:oklch(.36 .015 172);--accent:oklch(.76 .085 172);--on:oklch(.2 .02 172);--warn:oklch(.76 .11 55)}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{width:100%;max-width:360px}h1{margin:0 0 8px;font-size:24px;font-weight:600;line-height:1.2}p{margin:0 0 20px;color:var(--muted)}
label{display:block;margin-bottom:6px;font-size:13px;font-weight:500}input{width:100%;padding:12px;font:600 20px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;text-align:center;color:inherit;background:transparent;border:1px solid var(--rule);border-radius:9px}
button{width:100%;margin-top:12px;padding:12px;font:600 15px/1 system-ui,sans-serif;color:var(--on);background:var(--accent);border:0;border-radius:9px;cursor:pointer}.err{color:var(--warn);font-weight:500}
</style></head><body><main>${body}</main></body></html>`;
}

function pairingPage(clientName, requestId, error = "") {
  return page(
    "Connect to SMCP",
    `<h1>Connect to SMCP</h1><p>${escapeHtml(clientName)} wants to access your computer. Open the SMCP app and enter the Remote access code here.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/pair"><input type="hidden" name="request" value="${escapeHtml(requestId)}">
<label for="code">Code</label><input id="code" name="code" required maxlength="12" autocomplete="off" autocapitalize="characters" autofocus>
<button type="submit">Connect</button></form>`,
  );
}

/** Persists clients and hashed tokens. Raw tokens are never written to disk. */
function createPersistence(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    data = {};
  }
  data.clients ??= {};
  data.tokens ??= {};
  // Clients registered before secrets stopped expiring would still be locked out after 30 days.
  for (const client of Object.values(data.clients)) if (client.client_secret_expires_at) client.client_secret_expires_at = 0;
  return {
    data,
    save() {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}

const HEALTH_PER_MINUTE = 30;

export function createRemote({ baseUrl, buildServer, statePath = defaultRemoteStatePath(), port = REMOTE_PORT, host = "127.0.0.1", now = Date.now, healthCheck = null }) {
  const store = createPersistence(statePath);
  const pending = new Map();
  const authCodes = new Map();
  let pairing = null;
  let listener = null;
  // When a request last got in, and when one was last turned away, so the app can tell
  // "nothing reaches SMCP" from "something reaches it but is not let in".
  const activity = { lastRequestAt: null, lastClient: null, lastRejectedAt: null, lastHealthAt: null };
  let healthHits = [];

  const issueTokens = (clientId) => {
    const access = token();
    const refresh = token();
    store.data.tokens[hash(access)] = { type: "access", clientId, expiresAt: now() + ACCESS_TTL_MS };
    store.data.tokens[hash(refresh)] = { type: "refresh", clientId, expiresAt: now() + REFRESH_TTL_MS };
    for (const [key, entry] of Object.entries(store.data.tokens)) {
      if (entry.expiresAt < now()) delete store.data.tokens[key];
    }
    const client = store.data.clients[clientId];
    if (client) client.smcp_connected_at ??= now();
    store.save();
    return { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: ACCESS_TTL_MS / 1000 };
  };

  const clientsStore = {
    getClient: (id) => store.data.clients[id],
    registerClient(client) {
      const entries = Object.entries(store.data.clients);
      if (entries.length >= MAX_CLIENTS) {
        // Registration is open by design, so drop the oldest clients that never finished pairing.
        const stale = entries.find(([, item]) => !item.smcp_connected_at);
        if (!stale) throw new Error("Too many clients are registered.");
        delete store.data.clients[stale[0]];
      }
      store.data.clients[client.client_id] = client;
      store.save();
      return client;
    },
  };

  const provider = {
    clientsStore,
    async authorize(client, params, res) {
      for (const [id, item] of pending) if (item.expiresAt < now()) pending.delete(id);
      const requestId = token();
      pending.set(requestId, { client, params, expiresAt: now() + PENDING_TTL_MS });
      res.status(200).type("html").send(pairingPage(client.client_name || "An app", requestId));
    },
    async challengeForAuthorizationCode(_client, code) {
      const item = authCodes.get(code);
      if (!item || item.expiresAt < now()) throw new InvalidGrantError("Invalid or expired code.");
      return item.params.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const item = authCodes.get(code);
      authCodes.delete(code);
      if (!item || item.expiresAt < now() || item.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired code.");
      if (redirectUri && redirectUri !== item.params.redirectUri) throw new InvalidGrantError("The redirect address does not match.");
      return issueTokens(client.client_id);
    },
    async exchangeRefreshToken(client, refreshToken) {
      const key = hash(refreshToken);
      const entry = store.data.tokens[key];
      if (!entry || entry.type !== "refresh" || entry.clientId !== client.client_id || entry.expiresAt < now()) {
        throw new InvalidGrantError("Session expired. Connect again.");
      }
      delete store.data.tokens[key];
      return issueTokens(client.client_id);
    },
    async verifyAccessToken(accessToken) {
      const entry = store.data.tokens[hash(accessToken)];
      if (!entry || entry.type !== "access" || entry.expiresAt < now()) throw new InvalidTokenError("Invalid or expired token.");
      const client = store.data.clients[entry.clientId];
      // Saved at most once a minute, so the app can show when each app last used SMCP.
      if (client && now() - (client.smcp_last_used_at ?? 0) > 60_000) {
        client.smcp_last_used_at = now();
        store.save();
      }
      return { token: accessToken, clientId: entry.clientId, scopes: [], expiresAt: Math.floor(entry.expiresAt / 1000) };
    },
    async revokeToken(client, { token: value }) {
      const key = hash(value);
      if (store.data.tokens[key]?.clientId === client.client_id) {
        delete store.data.tokens[key];
        store.save();
      }
    },
  };

  const checkPairing = (code) => {
    if (!pairing || pairing.expiresAt < now()) return "There is no active code. Generate one in the SMCP app.";
    const given = Buffer.from(hash(String(code ?? "").trim().toUpperCase()));
    const expected = Buffer.from(hash(pairing.code));
    if (timingSafeEqual(given, expected)) {
      pairing = null; // One use only.
      return null;
    }
    pairing.attempts += 1;
    if (pairing.attempts >= MAX_PAIRING_ATTEMPTS) {
      pairing = null;
      return "Too many attempts. Generate a new code in the SMCP app.";
    }
    return "That code is not correct.";
  };

  const buildApp = () => {
    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", 1); // Tailscale Funnel is the one proxy in front of this server.
    app.use((_req, res, next) => {
      res.set({
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action https: http:; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      next();
    });

    const mcpUrl = new URL("/mcp", baseUrl);
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(baseUrl),
        resourceServerUrl: mcpUrl,
        resourceName: "SMCP",
        // The SDK's default is 30 days, which would end a 90-day session early. Revoking a client is what ends it.
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
      }),
    );

    app.post("/pair", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
      const item = pending.get(String(req.body?.request ?? ""));
      if (!item || item.expiresAt < now()) {
        res.status(400).type("html").send(page("Connect to SMCP", "<h1>Try again</h1><p>This request expired. Start the connection again from your AI app.</p>"));
        return;
      }
      const error = checkPairing(req.body.code);
      if (error) {
        res.status(400).type("html").send(pairingPage(item.client.client_name || "An app", String(req.body.request), error));
        return;
      }
      pending.delete(String(req.body.request));
      const code = token();
      authCodes.set(code, { clientId: item.client.client_id, params: item.params, expiresAt: now() + AUTH_CODE_TTL_MS });
      const target = new URL(item.params.redirectUri);
      target.searchParams.set("code", code);
      if (item.params.state) target.searchParams.set("state", item.params.state);
      res.redirect(302, target.href);
    });

    const bearer = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    });
    const auth = (req, res, next) => {
      res.on("finish", () => {
        if (res.statusCode === 401 || res.statusCode === 403) activity.lastRejectedAt = now();
      });
      bearer(req, res, next);
    };

    /**
     * A page the person can open from the phone's browser, with no sign-in, to see whether the whole
     * path works: the public URL, SMCP, and a tool. It says only yes or no, and nothing about them.
     */
    app.get("/health", async (_req, res) => {
      const cutoff = now() - 60_000;
      healthHits = healthHits.filter((at) => at > cutoff);
      if (healthHits.length >= HEALTH_PER_MINUTE) return res.status(429).json({ ok: false, reason: "Too many checks. Wait a minute." });
      healthHits.push(now());
      activity.lastHealthAt = now();
      let tool = "not checked";
      try {
        if (healthCheck) tool = (await healthCheck()) ? "ok" : "failed";
      } catch {
        tool = "failed";
      }
      res.status(tool === "failed" ? 503 : 200).json({ ok: tool !== "failed", smcp: "running", tool, at: new Date(now()).toISOString() });
    });

    // Stateless: every request gets its own server, so no session can outlive a revoked token.
    app.post("/mcp", auth, express.json({ limit: "2mb" }), async (req, res) => {
      const clientId = req.auth?.clientId ?? null;
      const name = store.data.clients[clientId]?.client_name || "Unnamed app";
      activity.lastRequestAt = now();
      activity.lastClient = name;
      // Who is calling, for the limits and the activity log: the app's name and the start of its id.
      const server = buildServer({ client: clientId ? `${name} · ${String(clientId).slice(0, 8)}` : name });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
      }
    });
    const notAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    app.get("/mcp", auth, notAllowed);
    app.delete("/mcp", auth, notAllowed);
    return app;
  };

  return {
    start: () =>
      new Promise((resolve, reject) => {
        if (listener) return resolve(listener.address().port);
        const server = buildApp().listen(port, host, () => {
          listener = server;
          resolve(server.address().port);
        });
        server.once("error", reject);
      }),
    stop: () =>
      new Promise((resolve) => {
        if (!listener) return resolve();
        listener.close(() => resolve());
        listener.closeAllConnections?.();
        listener = null;
      }),
    running: () => Boolean(listener),
    newPairingCode() {
      const code = Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("");
      pairing = { code, attempts: 0, expiresAt: now() + PAIRING_TTL_MS };
      return { code, expiresAt: pairing.expiresAt };
    },
    activePairing() {
      if (!pairing || pairing.expiresAt < now()) return null;
      return { code: pairing.code, expiresAt: pairing.expiresAt };
    },
    /** Only clients that completed pairing; bare registrations are not connections. */
    listClients() {
      return Object.values(store.data.clients)
        .filter((client) => client.smcp_connected_at)
        .map((client) => ({
          id: client.client_id,
          name: client.client_name || "Unnamed app",
          connectedAt: client.smcp_connected_at,
          lastUsedAt: client.smcp_last_used_at ?? null,
        }));
    },
    revokeClient(id) {
      delete store.data.clients[id];
      for (const [key, entry] of Object.entries(store.data.tokens)) {
        if (entry.clientId === id) delete store.data.tokens[key];
      }
      store.save();
    },
    /** Signs out every connected app at once. Each one has to pair again with a new code. */
    revokeAll() {
      const count = Object.values(store.data.clients).filter((client) => client.smcp_connected_at).length;
      store.data.clients = {};
      store.data.tokens = {};
      pairing = null;
      pending.clear();
      authCodes.clear();
      store.save();
      return count;
    },
    activity: () => ({ ...activity }),
  };
}
