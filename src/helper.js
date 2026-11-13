// macOS ties Accessibility and Screen Recording to the app that starts a process. The MCP server is
// started by Claude, so it asks SMCP.app over a private socket to run these actions under its own name.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cleanOrigin, currentOrigin, isAway, runWithOrigin } from "./origin.js";
import { run } from "./util.js";

const APP_BUNDLE_ID = "com.santiago.smcp";
const MAX_REQUEST_BYTES = 256 * 1024;
const LAUNCH_WAIT_MS = 6_000;
/** A call from outside this computer may wait for the person to approve it on their own device. */
const AWAY_WAIT_MS = 16 * 60 * 1000;

export function socketPath() {
  return process.env.SMCP_SOCKET || join(homedir(), ".smcp", "smcp.sock");
}

/**
 * App side. `ops` maps an operation name to an async function; nothing else can be called.
 * A request that began outside this computer says so, and its operation runs with that origin, so a
 * confirmation it needs is asked of the person where they are instead of in a window nobody sees.
 * Claiming an origin can only make a request stricter: it never skips a confirmation.
 */
export function startHelper(ops, path = socketPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      socket.removeAllListeners("data");
      let reply;
      try {
        const { op, params, origin } = JSON.parse(line);
        if (!Object.hasOwn(ops, op)) throw new Error("Unknown operation.");
        const from = cleanOrigin(origin);
        reply = { value: await (from ? runWithOrigin(from, () => ops[op](params)) : ops[op](params)) };
      } catch (error) {
        reply = { error: error.message };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve(server);
    });
  });
}

export class HelperUnavailable extends Error {}

/** One request and one reply over the socket. */
export function requestHelper(op, params, { path = socketPath(), timeoutMs = 140_000 } = {}) {
  const origin = currentOrigin();
  if (isAway(origin)) timeoutMs = Math.max(timeoutMs, AWAY_WAIT_MS);
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("SMCP took too long to respond.")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(origin ? { op, params, origin } : { op, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      try {
        const reply = JSON.parse(buffer);
        if (reply.error) finish(reject, new Error(reply.error));
        else finish(resolve, reply.value);
      } catch {
        finish(reject, new Error("Invalid response from SMCP."));
      }
    });
    socket.on("error", (error) => finish(reject, new HelperUnavailable(error.message)));
  });
}

async function launchApp() {
  await run("/usr/bin/open", ["-g", "-b", APP_BUNDLE_ID, "--args", "--background"], { timeoutMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, LAUNCH_WAIT_MS));
}

/**
 * Runs an operation in SMCP.app, opening it if needed. If the app is not installed, runs `local`
 * instead, which uses the permissions of whichever app started this server.
 */
export async function viaHelper(op, params, local, { launch = launchApp, path, timeoutMs } = {}) {
  const options = { path, timeoutMs };
  try {
    return await requestHelper(op, params, options);
  } catch (error) {
    if (!(error instanceof HelperUnavailable)) throw error;
  }
  await launch();
  try {
    return await requestHelper(op, params, options);
  } catch (error) {
    if (!(error instanceof HelperUnavailable)) throw error;
  }
  return local();
}
