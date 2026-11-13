// Lets one person's computers running SMCP talk to each other over Tailscale:
// see which version each one runs, ask one to update itself, or ask one to wake the PC.
import { createServer } from "node:http";
import { callPeer, PEER_OPERATIONS, PEER_PORT } from "../../src/peer-client.js";
import { identifyFromServe } from "./tasks-hub.js";

export { callPeer, PEER_OPERATIONS, PEER_PORT };
export const PEER_LOCAL_PORT = 47825;
// Large enough for a tool call that writes a file, which is capped at a million characters.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Answers only the owner's own devices: Tailscale Serve sets the login header itself and discards any value
 * a client sends, so another tailnet user, or anything outside the tailnet, gets a 403.
 */
export function createPeerHub({ handlers, owner, host = "127.0.0.1", port = PEER_LOCAL_PORT, identify = identifyFromServe }) {
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/peer") return send(404, { error: "Not found." });
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
        if (!user || user !== owner) return send(403, { error: "This device does not belong to your account." });
        const { op, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!PEER_OPERATIONS.includes(op) || !handlers[op]) return send(400, { error: "Unknown operation." });
        send(200, { value: await handlers[op](args ?? {}) });
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

/** What a computer tells the others about itself. Only plain facts, never paths or accounts. */
export function peerInfo({ version, platform, update, whatsapp = null, tools = false }) {
  return {
    version,
    platform,
    update: { status: update.status, latest: update.latest, canInstall: Boolean(update.canInstall) },
    // Whether WhatsApp is linked here, so the others know whom to ask. Never the number or the chats.
    whatsapp: { linked: Boolean(whatsapp?.linked), live: Boolean(whatsapp?.live) },
    // Whether this computer lets the person's other computers run tools on it, so it can be their server.
    tools: Boolean(tools),
  };
}

/**
 * The computer the others should ask for WhatsApp: online, with SMCP answering, and linked.
 * One that keeps it syncing live wins over one that does not.
 */
export function whatsappHost(machines, peers) {
  const candidates = machines
    .filter((machine) => !machine.self && machine.online && machine.dns && peers.get(machine.name)?.whatsapp?.linked)
    .map((machine) => ({ machine, live: Boolean(peers.get(machine.name).whatsapp.live) }));
  candidates.sort((a, b) => Number(b.live) - Number(a.live));
  return candidates[0]?.machine ?? null;
}
