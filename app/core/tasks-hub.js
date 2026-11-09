// Lets one person's computers share a single task list over Tailscale.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { run } from "../../src/util.js";
import { tailscaleCandidates } from "./machines.js";
import { TASK_OPERATIONS } from "./tasks.js";

export const TASKS_PORT = 47822;
const LOCAL_PORT = 47823;
const MAX_BODY_BYTES = 1024 * 1024;
const CALL_TIMEOUT_MS = 15_000;

function tailscaleBin() {
  const path = tailscaleCandidates().find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Tailscale no está instalado.");
  return path;
}

export function loginFromStatus(status) {
  return status?.User?.[String(status?.Self?.UserID)]?.LoginName ?? null;
}

export async function tailscaleLogin() {
  const result = await run(tailscaleBin(), ["status", "--json"], { timeoutMs: 8_000 });
  if (result.code !== 0) throw new Error("Tailscale no está conectado.");
  return loginFromStatus(JSON.parse(result.stdout));
}

/**
 * Tailscale Serve receives connections from the tailnet and hands them to this computer's localhost,
 * so no firewall rule is needed. It sets this header itself and discards any value a client sends.
 */
export const identifyFromServe = (req) => req.headers["tailscale-user-login"] ?? null;

export async function enableServe(port = TASKS_PORT, localPort = LOCAL_PORT) {
  const result = await run(tailscaleBin(), ["serve", "--bg", "--yes", `--http=${port}`, `http://127.0.0.1:${localPort}`], { timeoutMs: 20_000 });
  if (result.code !== 0) throw new Error("No se pudo compartir la lista por Tailscale.");
}

export async function disableServe(port = TASKS_PORT) {
  await run(tailscaleBin(), ["serve", `--http=${port}`, "off"], { timeoutMs: 15_000 });
}

export function createTasksHub({ store, host = "127.0.0.1", port = LOCAL_PORT, owner, identify = identifyFromServe }) {
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/tasks") return send(404, { error: "No encontrado." });
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", async () => {
      try {
        const user = identify(req);
        if (!user || user !== owner) return send(403, { error: "Este equipo no pertenece a tu cuenta." });
        const { op, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!TASK_OPERATIONS.includes(op)) return send(400, { error: "Operación desconocida." });
        send(200, { value: store[op](args ?? {}) });
      } catch (error) {
        send(200, { error: error.message });
      }
    });
  });
  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address().port));
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

const UNREACHABLE = "No se puede llegar a la computadora donde viven tus tareas. Revisa que esté encendida, con Tailscale y con SMCP abierta.";

/** Same operations as a local store, but on another computer. Never falls back to a second list. */
export function createRemoteTasks({ host, port = TASKS_PORT, fetchImpl = fetch }) {
  const call = async (op, args) => {
    let body;
    try {
      const response = await fetchImpl(`http://${host}:${port}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      // With SMCP closed, Tailscale Serve still answers, with an empty 502 instead of JSON.
      body = await response.json();
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (body.error) throw new Error(body.error);
    return body.value;
  };
  return Object.fromEntries(TASK_OPERATIONS.map((op) => [op, (args) => call(op, args)]));
}
