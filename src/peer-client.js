// Calls SMCP on another of the person's computers over Tailscale. It lives here, outside the app, so
// the MCP server a client starts can reach the person's server computer on its own.
export const PEER_PORT = 47824;
export const PEER_OPERATIONS = ["info", "update", "wake", "whatsapp", "tool"];

const UNREACHABLE = "Cannot reach SMCP on that computer. Check that it is on and has SMCP open.";

/** Thrown when the other computer did not answer at all, as opposed to answering with an error. */
export class PeerUnreachable extends Error {}

/** Calls another computer's SMCP. Throws a plain message when it does not answer. */
export async function callPeer(host, op, args = {}, { port = PEER_PORT, timeoutMs = 4_000, fetchImpl = fetch } = {}) {
  if (!PEER_OPERATIONS.includes(op)) throw new Error("Unknown operation.");
  let body;
  try {
    const response = await fetchImpl(`http://${host}:${port}/peer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // With SMCP closed, Tailscale Serve still answers, with an empty 502 instead of JSON.
    body = await response.json();
  } catch {
    throw new PeerUnreachable(UNREACHABLE);
  }
  if (body.error) throw new Error(body.error);
  return body.value;
}
