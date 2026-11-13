// "Use the server": one of the person's computers stays on all day and holds the notes vault, the
// WhatsApp session and the files that matter. From any other computer, a tool can run there instead
// of here. The person chooses the server and which areas go to it in Settings; a tool can also be sent
// explicitly with `machine`.
//
// Two rules hold everywhere:
//  - The server decides. Its switches, its pause and its confirmations apply to what runs on it.
//  - A server that does not answer is an error. A call never falls back to this computer, because
//    that would return another computer's data without saying so.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { currentOrigin } from "./origin.js";
import { callPeer, PeerUnreachable } from "./peer-client.js";
import { toolGroup } from "./policy.js";
import { errorResult } from "./util.js";

/** Areas whose data belongs to one computer, so it matters where the tool runs. */
export const ROUTED_AREAS = ["terminal", "files", "notes", "applenotes", "calendar", "reminders", "gmail", "apps", "clipboard", "security", "brief"];

/**
 * Areas that can be sent with `machine` but never by a standing preference: keeping a computer awake
 * or switching its VPN is about that one computer, so it is always asked for by name.
 */
const EXPLICIT_ONLY_AREAS = ["awake", "vpn"];

/**
 * Never routed: tasks already live on one computer the person chose, WhatsApp reading already asks
 * the computer where it is linked, and the status tools report on both computers themselves.
 */
const NEVER_ROUTED = new Set(["smcp_status", "smcp_context", "smcp_ping", "smcp_remember", "approval_status"]);
/** Sending and voice notes need the computer with the WhatsApp session, so these can be sent to it. */
const WHATSAPP_ROUTED = new Set(["whatsapp_send", "whatsapp_send_file", "whatsapp_transcribe_audio"]);

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const DEFAULT_TIMEOUT_MS = 120_000;
/** A command may run for its own time limit; a send may wait for the person's approval. */
const TOOL_TIMEOUT_MS = { run_command: 150_000 };

export function serverConfigPath() {
  return process.env.SMCP_SERVER_CONFIG || join(homedir(), ".smcp", "server.json");
}

/** The chosen server and the areas that go to it, or null when this computer works on its own. */
export function readServerConfig(path = serverConfigPath()) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const host = String(saved?.host ?? "").trim();
  if (!HOST.test(host)) return null;
  const areas = Object.fromEntries(ROUTED_AREAS.map((area) => [area, saved.areas?.[area] === true]));
  return { host, name: String(saved.name ?? host).slice(0, 80) || host, areas };
}

/** Saves the choice, or removes it with `null`. */
export function writeServerConfig(config, path = serverConfigPath()) {
  if (!config) {
    rmSync(path, { force: true });
    return null;
  }
  const host = String(config.host ?? "").trim();
  if (!HOST.test(host)) throw new Error("That is not a valid computer name.");
  const clean = {
    host,
    name: String(config.name ?? host).slice(0, 80) || host,
    areas: Object.fromEntries(ROUTED_AREAS.map((area) => [area, config.areas?.[area] === true])),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return clean;
}

export const hasServerConfig = (path = serverConfigPath()) => existsSync(path);

/** The area a tool belongs to for routing, or null when it always runs here. */
export function routedArea(name) {
  if (NEVER_ROUTED.has(name)) return null;
  const group = toolGroup(name);
  if (group === "whatsapp") return WHATSAPP_ROUTED.has(name) ? "whatsapp" : null;
  if (ROUTED_AREAS.includes(group) || EXPLICIT_ONLY_AREAS.includes(group)) return group;
  return null;
}

export const SERVER_UNREACHABLE = (name, tool) =>
  `"${name}", your server computer, does not answer over Tailscale, so ${tool} did not run. ` +
  "It was not run on this computer instead. Check that the server is on, awake, connected to Tailscale and has SMCP open.";

export const NO_SERVER =
  "No server computer is chosen on this computer, so `machine: \"server\"` cannot be used. The person can choose one in SMCP, under Settings.";

/**
 * Where a call goes: "server", or null for this computer. An explicit `machine` wins over the saved
 * preference. Returns `{ error }` when the call asks for a server that is not set up.
 */
export function resolveTarget(name, machine, config) {
  const area = routedArea(name);
  if (!area) return { target: null };
  if (machine === "here") return { target: null };
  if (machine === "server") return config ? { target: "server" } : { error: NO_SERVER };
  return { target: config?.areas?.[area] === true ? "server" : null };
}

const MACHINE = z
  .enum(["here", "server"])
  .optional()
  .describe("Which of the person's computers runs this: `here` (this one) or `server` (their server computer). Leave it out to follow the person's setting.");

/** Runs a tool on the server computer and returns its result, or a plain error that says it did not run. */
export async function callServerTool(config, name, args, { call = callPeer, origin = currentOrigin(), from = hostname() } = {}) {
  try {
    const result = await call(
      config.host,
      "tool",
      // The server applies its own rules for where the call started, so say so when it began outside.
      { name, args, origin: origin?.source === "remote" ? "remote" : "local", from },
      { timeoutMs: TOOL_TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS },
    );
    if (!result || !Array.isArray(result.content)) return errorResult(`"${config.name}" answered ${name} with something SMCP could not read. Both computers need the same version of SMCP.`);
    return result;
  } catch (error) {
    if (error instanceof PeerUnreachable) return errorResult(SERVER_UNREACHABLE(config.name, name));
    return errorResult(`"${config.name}", your server computer, did not run ${name}: ${error.message}`);
  }
}

/**
 * Gives `guarded` what it needs to route: each routable tool gains a `machine` argument, and every
 * call is resolved against the setting as it is at that moment, so a change applies at once.
 */
export function createRouter({ read = readServerConfig, call = callServerTool } = {}) {
  return {
    wrap(name, config) {
      if (!routedArea(name)) return null;
      const hadSchema = Boolean(config.inputSchema);
      return {
        config: { ...config, inputSchema: { ...(config.inputSchema ?? {}), machine: MACHINE } },
        resolve([args, extra]) {
          const { machine, ...rest } = args ?? {};
          const server = read();
          const { target, error } = resolveTarget(name, machine, server);
          if (error) return { error };
          if (!target) return { target: null, args: hadSchema ? [rest, extra] : [extra] };
          return { target, call: () => call(server, name, rest) };
        },
      };
    },
  };
}

/** For smcp_status and smcp_context: which computer each area runs on right now. */
export function describeRouting(config = readServerConfig()) {
  if (!config) return null;
  return {
    server: config.name,
    areasOnServer: ROUTED_AREAS.filter((area) => config.areas[area]),
    note: "Tools in these areas run on the server computer. Any routable tool can also be sent with `machine`.",
  };
}
