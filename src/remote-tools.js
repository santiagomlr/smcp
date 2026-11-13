// What a client outside this computer may do, and how its calls are kept in check.
//
// "Outside" is two things: the remote connector (phone, web, routines, with an OAuth token) and the
// person's other computers (over Tailscale, when this one is their server). Both get every tool the
// local session has, but nothing beyond reading is on until the person turns on the switch for that
// kind of risk, and every call is limited, timed, size-capped and logged.
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordCall } from "./audit.js";
import { buildInstructions } from "./context.js";
import { runWithOrigin } from "./origin.js";
import { guarded, readPolicy } from "./policy.js";
import { createGate, createRateLimiter } from "./rate-limit.js";
import { createRouter, hasServerConfig } from "./server-route.js";
import { registerAllTools } from "./toolset.js";
import { registerPrompts } from "./tools/context.js";
import { errorResult, textResult } from "./util.js";

/** Reading. Always available to a connected client; each tool still follows its own area switch. */
export const REMOTE_TOOLS = new Set([
  "whatsapp_status",
  "whatsapp_list_chats",
  "whatsapp_read_messages",
  "whatsapp_search_messages",
  "whatsapp_search_contacts",
  "whatsapp_sync",
  "whatsapp_chat_digest",
  "whatsapp_search_transcripts",
  "whatsapp_scan_file",
  // Follows its own switch (listening to audio), which starts off.
  "whatsapp_transcribe_audio",
  "gmail_list_accounts",
  "gmail_search",
  "gmail_read",
  "gmail_read_attachment",
  "notes_list_vaults",
  "notes_search",
  "notes_recent",
  "notes_read",
  "notes_semantic_search",
  "brain_inbox",
  "tasks_available",
  "tasks_search",
  "tasks_list_projects",
  "tasks_claude_queue",
  "tasks_hygiene",
  "tasks_forecast",
  "tasks_review_list",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_free_slots",
  "calendar_auto_history",
  "reminders_list_lists",
  "reminders_list",
  "applenotes_search",
  "applenotes_recent",
  "applenotes_read",
  "daily_brief",
  "people_lookup",
  "followups_list",
  "file_list",
  "file_read",
  "file_search",
  "smcp_status",
  "smcp_context",
  "smcp_ping",
  "approval_status",
  // The antivirus reads and reports from anywhere.
  "security_scan_file",
  "security_scan_folder",
  "security_check_url",
  "security_check_persistence",
  "security_quarantine_list",
  // Seeing which VPNs are on is harmless, and turning one on is how a computer serving with its
  // screen off gets back onto the work network. Tailscale stays connected (only its DNS steps aside).
  "vpn_status",
  "vpn_connect",
  // A computer used as a server can be kept awake from the phone.
  "awake_status",
  "awake_start",
]);

/**
 * Task edits a person can allow from outside this computer, for example a nightly routine that files
 * new tasks. They only touch SMCP's own list and every one can be undone in the app.
 */
export const REMOTE_TASK_WRITES = new Set(["tasks_create", "tasks_update", "tasks_append_note", "tasks_complete", "tasks_mark_reviewed", "followups_to_tasks"]);

/**
 * Writing notes, calendar and reminders. Notes stay inside the vaults and can only be Markdown or text,
 * a calendar the person did not choose for unattended writing still asks for their approval, and
 * quarantine can be undone. Writing any file is not here: see REMOTE_CONTROL.
 */
export const REMOTE_WRITES = new Set([
  "notes_write",
  "smcp_remember",
  "brain_inbox_mark",
  "brain_export_now",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "reminders_create",
  "reminders_update",
  "reminders_complete",
  "reminders_delete",
  // A draft sends nothing: the person reviews it in Gmail.
  "gmail_draft",
  "security_quarantine",
  "security_restore",
]);

/**
 * The terminal, writing any file, and anything that sees or drives the screen. With this on, a client
 * can do whatever the person can. file_write sits here, not with notes: a file written to a shell
 * profile, a launch agent or a script that runs on a schedule is a command that runs later.
 */
export const REMOTE_CONTROL = new Set([
  "run_command",
  "file_write",
  "app_list",
  "window_list",
  "app_focus",
  "ui_read_tree",
  "ui_click",
  "ui_type",
  "ui_key",
  "screenshot",
  "screen_read_text",
  "clipboard_read",
  "clipboard_write",
  "security_delete_quarantined",
]);

/** Messages and email that go out to other people. Each one still waits for the person's approval. */
export const REMOTE_SENDS = new Set(["whatsapp_send", "whatsapp_send_file", "gmail_send", "gmail_reply"]);

const STAYS_HERE = "It only works at the computer itself";
/** Never from outside, whatever the switches say, each with the reason the client is told. */
export const LOCAL_ONLY = {
  awake_stop: `${STAYS_HERE}: letting the computer sleep from afar would cut the connection you are using.`,
  awake_screen_off: `${STAYS_HERE}: turning the screen off from afar can drop connections that need it.`,
  vpn_disconnect: `${STAYS_HERE}: turning a VPN off from afar could cut the connection you are using.`,
  vpn_tailscale_dns: `${STAYS_HERE}: changing Tailscale's DNS from afar could cut the connection you are using.`,
  nightlight_status: `${STAYS_HERE}: the night light changes a screen nobody is looking at from afar.`,
  nightlight_set: `${STAYS_HERE}: the night light changes a screen nobody is looking at from afar.`,
  nightlight_now: `${STAYS_HERE}: the night light changes a screen nobody is looking at from afar.`,
};

const WHERE = "The person can turn it on in SMCP on that computer, under Settings > Remote access.";
export const REMOTE_TASK_WRITES_OFF = "Editing tasks from outside this computer is off, so nothing changed. You can turn it on in SMCP, under Settings.";
export const REMOTE_WRITES_OFF = `Writing notes, calendar events and reminders from outside the computer is turned off, so nothing changed. ${WHERE}`;
export const REMOTE_CONTROL_OFF = `The terminal, writing files and control of the computer from outside it are turned off, so nothing ran or changed. ${WHERE}`;
export const REMOTE_SENDS_OFF = `Sending messages and email from outside the computer is turned off, so nothing was sent. ${WHERE}`;
export const NOT_REMOTE = "This tool is not available from outside the computer.";
export const PEER_TOOLS_OFF =
  "That computer does not let your other computers use it, so nothing ran there. Turn on \"Let my other computers use this one\" in SMCP on that computer, under Settings.";

/** Which switch a tool needs from outside: read, tasks, write, control, send, or local when it never travels. */
export function remoteGroup(name) {
  if (Object.hasOwn(LOCAL_ONLY, name)) return "local";
  if (REMOTE_TOOLS.has(name)) return "read";
  if (REMOTE_TASK_WRITES.has(name)) return "tasks";
  if (REMOTE_WRITES.has(name)) return "write";
  if (REMOTE_CONTROL.has(name)) return "control";
  if (REMOTE_SENDS.has(name)) return "send";
  return null;
}

/** Re-reads the setting on every call, so switching it off applies at once. */
export function remoteTaskWriteDenial(policy = readPolicy()) {
  return policy.remote?.taskWrites === true ? null : REMOTE_TASK_WRITES_OFF;
}

/** Why the remote connector may not run a tool under this policy, or null if it may. */
export function remoteDenial(name, policy = readPolicy()) {
  switch (remoteGroup(name)) {
    case "read":
      return null;
    case "tasks":
      return remoteTaskWriteDenial(policy);
    case "write":
      return policy.remote?.write === true ? null : REMOTE_WRITES_OFF;
    case "control":
      return policy.remote?.control === true ? null : REMOTE_CONTROL_OFF;
    case "send":
      return policy.remote?.send === true ? null : REMOTE_SENDS_OFF;
    case "local":
      return LOCAL_ONLY[name];
    default:
      // A tool nobody classified does not exist from outside, so a new one cannot slip through.
      return NOT_REMOTE;
  }
}

/**
 * Why another of the person's computers may not run a tool here. That computer is theirs, verified by
 * Tailscale, so with the switch on it may do what a session at this computer may; a call it passes on
 * from its own remote connector must also pass this computer's remote switches.
 */
export function peerDenial(name, policy = readPolicy(), { relayedRemote = false } = {}) {
  if (policy.peers?.tools !== true) return PEER_TOOLS_OFF;
  if (Object.hasOwn(LOCAL_ONLY, name)) return LOCAL_ONLY[name];
  if (remoteGroup(name) === null) return NOT_REMOTE;
  return relayedRemote ? remoteDenial(name, policy) : null;
}

/* Limits */

export const AWAY_LIMITS = {
  /** Calls a minute, per connected app. */
  perMinute: 60,
  /** Terminal and screen calls a minute. */
  controlPerMinute: 20,
  /** Sends a minute. Each one still needs an approval. */
  sendPerMinute: 6,
  /** Heavy tools running at the same time, across all clients. */
  heavyAtOnce: 2,
  /** How long a call may take before the client is told it is still running. */
  callMs: 100_000,
  /** The longest a terminal command may run. Locally it is 600 seconds. */
  commandSeconds: 120,
  /** How much text a result may carry. */
  resultChars: 200_000,
  /** How much a single write may carry. */
  writeChars: 1_000_000,
  /** Writes stop when the disk has less than this free. */
  minFreeBytes: 1024 * 1024 * 1024,
  /** How long a call waits for the person's approval before answering that it is waiting. */
  approvalGraceMs: 25_000,
};

/** Tools that load the computer, so only a couple run at once. */
const HEAVY = new Set(["run_command", "whatsapp_transcribe_audio", "security_scan_folder", "security_scan_file", "screenshot", "brain_export_now"]);
const SIZED_WRITES = { file_write: "content", notes_write: "content" };

export function createAwayLimits(limits = AWAY_LIMITS, now = Date.now) {
  return {
    limits,
    all: createRateLimiter({ perMinute: limits.perMinute, now }),
    control: createRateLimiter({ perMinute: limits.controlPerMinute, now }),
    send: createRateLimiter({ perMinute: limits.sendPerMinute, now }),
    heavy: createGate(limits.heavyAtOnce),
  };
}

/** One set of counters for the whole app: each request builds its own server, but they share these. */
const SHARED_LIMITS = createAwayLimits();

function tooMany(seconds, what) {
  return `Too many ${what} from outside the computer in the last minute. Nothing ran. Wait ${seconds} seconds and try again; do not retry in a loop.`;
}

function rateDenial(name, key, state) {
  const all = state.all.check(key);
  if (all) return tooMany(all, "calls");
  const group = remoteGroup(name);
  if (group === "control") {
    const wait = state.control.check(key);
    if (wait) return tooMany(wait, "terminal and screen calls");
  }
  if (group === "send") {
    const wait = state.send.check(key);
    if (wait) return tooMany(wait, "sends");
  }
  return null;
}

async function diskIsLow(minFreeBytes) {
  try {
    const info = await statfs(homedir());
    return info.bavail * info.bsize < minFreeBytes;
  } catch {
    // A system that cannot say how much room is left does not block writing.
    return false;
  }
}

/** Shortens a result that would flood the client, and says so inside it. */
export function capResult(result, maxChars = AWAY_LIMITS.resultChars) {
  if (!result || !Array.isArray(result.content)) return result;
  let left = maxChars;
  let cut = 0;
  const content = result.content.map((item) => {
    const size = item.type === "text" ? item.text.length : typeof item.data === "string" ? item.data.length : 0;
    if (size <= left) {
      left -= size;
      return item;
    }
    cut += size - Math.max(left, 0);
    if (item.type !== "text") {
      left = 0;
      return { type: "text", text: "[An image or file was left out because the result was too large to send outside the computer.]" };
    }
    const kept = item.text.slice(0, Math.max(left, 0));
    left = 0;
    return { ...item, text: kept };
  });
  if (!cut) return result;
  content.push({
    type: "text",
    text: `[SMCP shortened this result: about ${Math.ceil(cut / 1000)} thousand characters were left out. It is not complete. Ask for less at a time (a smaller range, a lower limit or the next offset).]`,
  });
  return { ...result, content };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resultText(result) {
  return (result?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n").trim();
}

/** What a client is told while the person has not answered yet. */
export function waitingResult({ id, expiresAt, url }) {
  const result = textResult({
    done: false,
    waiting_for_approval: true,
    approval_id: id,
    approve_at: url ?? "the SMCP approval page (its address is in SMCP, under Settings > Remote access)",
    expires_at: new Date(expiresAt).toISOString(),
    note:
      "Nothing has happened yet. Tell the person to open the approval page on one of their own devices (it only opens with their Tailscale account), " +
      "read it and press the button. SMCP then does exactly what the page shows. Call approval_status with this id to learn how it ended. " +
      "Do not call this tool again for the same thing, and do not say it was done until approval_status says `done`.",
  });
  result._meta = { "smcp/waiting": true };
  return result;
}

/**
 * Wraps a tool for calls from outside: it runs with its origin attached, heavy tools take a turn,
 * oversized writes and a full disk are refused, the answer is capped, and a call that outlasts its
 * time is answered with a clear "still running" instead of leaving the client to guess.
 */
export function awayHandler(name, config, handler, { source, client, approvals, approvalUrl, state, record = recordCall }) {
  const { limits } = state;
  const hasSchema = Boolean(config.inputSchema);
  return async (...handlerArgs) => {
    const args = hasSchema ? { ...handlerArgs[0] } : undefined;
    if (name === "run_command" && args) args.timeout_seconds = Math.min(Number(args.timeout_seconds) || 60, limits.commandSeconds);
    const sized = SIZED_WRITES[name];
    if (sized && args) {
      if (String(args[sized] ?? "").length > limits.writeChars) {
        return errorResult(`From outside the computer a single write can carry up to ${limits.writeChars / 1000} thousand characters. Nothing was written. Send it in parts with mode "append".`);
      }
      if (await diskIsLow(limits.minFreeBytes)) return errorResult("The computer's disk is almost full, so writing from outside it is stopped. Nothing was written.");
    }
    const release = HEAVY.has(name) ? state.heavy.enter() : () => {};
    if (!release) {
      return errorResult(`${limits.heavyAtOnce} heavy tools asked from outside are already running on the computer. Nothing ran. Wait for one to finish and try again.`);
    }

    const callId = randomUUID();
    const started = Date.now();
    let approvalId = null;
    const stopWatching = approvals?.watchCall(callId, (id) => {
      approvalId = id;
    });
    let finished = false;
    const run = Promise.resolve()
      .then(() => runWithOrigin({ source, client, callId }, () => (hasSchema ? handler(args, ...handlerArgs.slice(1)) : handler(...handlerArgs))))
      .finally(() => {
        finished = true;
        release();
        stopWatching?.();
      });

    const limitMs = name === "run_command" ? (args.timeout_seconds + 15) * 1000 : limits.callMs;
    const outcome = await Promise.race([
      run.then((result) => ({ result })),
      // Asking for an approval ends the wait early: the person needs to be told where to approve.
      (async () => {
        for (let waited = 0; waited < limitMs && !finished; waited += 250) {
          await sleep(250);
          if (approvalId && Date.now() - started >= Math.min(limits.approvalGraceMs, limitMs)) return { waiting: true };
        }
        return { late: true };
      })(),
    ]);
    if ("result" in outcome) return capResult(outcome.result, limits.resultChars);

    if (approvalId && approvals?.get(approvalId)?.status !== "expired") {
      const id = approvalId;
      // The tool keeps waiting in the background, holding the exact arguments the page shows.
      run.then(
        (result) => {
          const ok = !result?.isError && approvals.get(id)?.status === "approved";
          approvals.finish(id, { ok, text: resultText(result) });
          if (approvals.get(id)?.status === "done" || approvals.get(id)?.status === "failed") {
            record({ tool: name, source, client, outcome: ok ? "ok" : "error", ms: Date.now() - started });
          }
        },
        (error) => approvals.finish(id, { ok: false, text: error?.message ?? "It failed." }),
      );
      return waitingResult({ id, expiresAt: approvals.get(id).expiresAt, url: approvalUrl?.() });
    }
    run.catch(() => {});
    return errorResult(
      `${name} has been running for more than ${Math.round(limitMs / 1000)} seconds on the computer, so SMCP stopped waiting for it. ` +
        "It may still be running, and its result is not known: do not assume it finished or report anything as read or done. Check before trying again.",
    );
  };
}

/**
 * Builds an MCP server for calls from outside this computer.
 *
 * `source` is "remote" (the connector) or "peer" (another of the person's computers).
 * `client` names who is calling, for the limits and the activity log.
 * `approvals` and `approvalUrl` come from the app; without them nothing that needs an approval can go out.
 */
export function buildAwayServer({ source = "remote", client = null, approvals = null, approvalUrl = null, relayedRemote = false, state = SHARED_LIMITS, record, router } = {}) {
  const remote = source === "remote";
  const server = new McpServer(
    { name: "smcp", version: "0.2.0" },
    {
      instructions: buildInstructions({ remote }),
    },
  );
  const key = `${source}:${client ?? "unknown"}`;
  const tools = guarded(server, {
    source,
    client,
    ...(record ? { record } : {}),
    deny: (name, policy) => rateDenial(name, key, state) ?? (remote ? remoteDenial(name, policy) : peerDenial(name, policy, { relayedRemote })),
    // The connector may run on a computer that sends some areas to the person's server.
    router: router ?? (remote && hasServerConfig() ? createRouter() : undefined),
  });
  registerAllTools(
    {
      registerTool(name, config, handler) {
        tools.registerTool(name, config, awayHandler(name, config, handler, { source, client, approvals, approvalUrl, state, record }));
      },
    },
    { remote },
  );
  if (remote) registerPrompts(server, { remote: true });
  return server;
}

/** The remote connector's server: one per request, so no session can outlive a revoked token. */
export function buildRemoteServer(options = {}) {
  return buildAwayServer({ ...options, source: "remote" });
}
