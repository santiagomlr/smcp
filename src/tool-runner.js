// Runs one tool on a server built for calls from outside, without a network in between. The person's
// other computers and the health check use it, so they go through exactly the same checks, limits and
// argument validation as the remote connector.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { errorResult } from "./util.js";

export async function callToolInProcess(server, name, args, { timeoutMs = 130_000 } = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smcp", version: "1" });
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    return await client.callTool({ name: String(name), arguments: args && typeof args === "object" ? args : {} }, undefined, { timeout: timeoutMs });
  } catch (error) {
    return errorResult(error?.message ?? "The tool could not run.");
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
