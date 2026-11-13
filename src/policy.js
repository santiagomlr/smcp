import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { recordCall } from "./audit.js";
import { errorResult } from "./util.js";

export const GROUPS = [
  "whatsapp",
  "gmail",
  "notes",
  "tasks",
  "calendar",
  "reminders",
  "applenotes",
  "files",
  "clipboard",
  "terminal",
  "apps",
  "security",
  "nightlight",
  "vpn",
  "awake",
];

const DEFAULTS = {
  paused: false,
  readOnly: false,
  // Terminal and app control could work around the send confirmation, so a person has to switch them on.
  // Apple Notes and the clipboard hold private text nobody connected on purpose, so they start off too.
  disabled: {
    whatsapp: false,
    gmail: false,
    notes: false,
    tasks: false,
    calendar: false,
    reminders: false,
    applenotes: true,
    files: false,
    clipboard: true,
    terminal: true,
    apps: true,
    // The antivirus mostly reads, and quarantine is undoable, so it starts on.
    security: false,
    // Warming the screen changes no data and undoes itself when SMCP quits.
    nightlight: false,
    // Turning a VPN on or off changes no data and can be undone with one call.
    vpn: false,
    // Keeping the computer awake changes no data and ends with SMCP.
    awake: false,
  },
  // Writing is something a person opts into when linking. Even then, every message still needs the confirmation window.
  whatsapp: { read: true, send: false, audio: false },
  // What phone, web and scheduled routines may do beyond reading. Each is off until a person turns it on.
  remote: { taskWrites: false, write: false, control: false, send: false },
  // Lets the person's other computers run tools here, when this one is their server.
  peers: { tools: false },
  // Calendars where events may be added, moved and deleted without the confirmation window.
  calendar: { autoWrite: [] },
};

/** The risks a remote client can be allowed, beyond reading. Anything other than an explicit true is off. */
export const REMOTE_SWITCHES = ["taskWrites", "write", "control", "send"];

function normalizeRemote(saved) {
  return Object.fromEntries(REMOTE_SWITCHES.map((name) => [name, saved?.[name] === true]));
}

const MAX_AUTO_CALENDARS = 20;

function normalizeCalendar(saved) {
  const ids = Array.isArray(saved?.autoWrite) ? saved.autoWrite : [];
  return { autoWrite: [...new Set(ids.filter((id) => typeof id === "string" && id && id.length <= 200))].slice(0, MAX_AUTO_CALENDARS) };
}

/** Installations saved before this choice existed keep what they could already do. */
const WHATSAPP_BEFORE_CHOICE = { read: true, send: true, audio: false };

export const WHATSAPP_ABILITIES = ["read", "send", "audio"];

/**
 * Which abilities unlock each WhatsApp tool: any one is enough, and an empty list needs none.
 * Finding a chat is needed both to read it and to write to it, and shows names, not messages.
 * A tool missing here is denied, so a new one cannot slip past the person's choice.
 */
export const WHATSAPP_TOOL_ABILITIES = {
  whatsapp_status: [],
  whatsapp_list_chats: ["read", "send"],
  whatsapp_search_contacts: ["read", "send"],
  whatsapp_read_messages: ["read"],
  whatsapp_search_messages: ["read"],
  whatsapp_sync: ["read"],
  whatsapp_chat_digest: ["read"],
  whatsapp_search_transcripts: ["read"],
  whatsapp_scan_file: ["read"],
  whatsapp_send: ["send"],
  whatsapp_send_file: ["send"],
  whatsapp_transcribe_audio: ["audio"],
};

/** Anything other than an explicit true is off. */
function normalizeWhatsApp(saved) {
  const access = saved === undefined ? WHATSAPP_BEFORE_CHOICE : saved;
  return Object.fromEntries(WHATSAPP_ABILITIES.map((ability) => [ability, access?.[ability] === true]));
}

function whatsappDenial(name, access) {
  const abilities = WHATSAPP_TOOL_ABILITIES[name];
  if (!abilities) return "This WhatsApp tool has no permission defined in SMCP, so it did not run.";
  const where = "You can change this in SMCP, under Settings.";
  // What an audio says is message content, so turning off reading also stops this.
  if (name === "whatsapp_transcribe_audio" && access?.audio === true && access?.read !== true) {
    return `Reading WhatsApp chats is off, and listening to audio needs it. ${where}`;
  }
  if (!abilities.length || abilities.some((ability) => access?.[ability] === true)) return null;
  if (abilities.length > 1) return `Reading and writing on WhatsApp are off. ${where}`;
  if (abilities[0] === "send") return `Writing on WhatsApp is off, so nothing was sent. ${where}`;
  if (abilities[0] === "audio") return `Listening to WhatsApp audio is off. ${where}`;
  return `Reading WhatsApp chats is off. ${where}`;
}

export function configPath() {
  return process.env.SMCP_CONFIG || join(homedir(), ".smcp", "config.json");
}

/** A damaged file pauses everything: losing the user's restrictions must not lift them. */
export function readPolicy(path = configPath()) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(DEFAULTS);
    return { ...structuredClone(DEFAULTS), paused: true };
  }
  try {
    const saved = JSON.parse(text);
    return {
      paused: saved.paused === true,
      readOnly: saved.readOnly === true,
      disabled: Object.fromEntries(GROUPS.map((group) => [group, (saved.disabled?.[group] ?? DEFAULTS.disabled[group]) === true])),
      whatsapp: normalizeWhatsApp(saved.whatsapp),
      remote: normalizeRemote(saved.remote),
      peers: { tools: saved.peers?.tools === true },
      calendar: normalizeCalendar(saved.calendar),
    };
  } catch {
    return { ...structuredClone(DEFAULTS), paused: true };
  }
}

export function writePolicy(policy, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function toolGroup(name) {
  if (name.startsWith("whatsapp_")) return "whatsapp";
  if (name.startsWith("gmail_")) return "gmail";
  if (name.startsWith("notes_")) return "notes";
  if (name.startsWith("tasks_")) return "tasks";
  if (name.startsWith("calendar_")) return "calendar";
  if (name.startsWith("reminders_")) return "reminders";
  if (name.startsWith("applenotes_")) return "applenotes";
  if (name.startsWith("file_")) return "files";
  if (name.startsWith("clipboard_")) return "clipboard";
  if (name.startsWith("security_")) return "security";
  if (name.startsWith("nightlight_")) return "nightlight";
  if (name.startsWith("vpn_")) return "vpn";
  if (name.startsWith("awake_")) return "awake";
  // Where the raw exports live is part of the notes vault, so it follows the Notes switch.
  if (name.startsWith("brain_")) return "notes";
  if (name === "smcp_status" || name === "smcp_context" || name === "smcp_ping") return "status";
  // Asking how an approval ended reads nothing personal: it only says whether the person pressed the button.
  if (name === "approval_status") return "approvals";
  if (name === "smcp_remember") return "context";
  if (name === "run_command") return "terminal";
  // People and follow-ups gather from several areas, like the brief, and each part asks for its own permission.
  if (name === "daily_brief" || name.startsWith("people_") || name.startsWith("followups_")) return "brief";
  return "apps";
}

/** Returns why a tool may not run under this policy, or null if it may. */
export function denialFor(name, annotations, policy) {
  // The status check reports pauses and switched-off areas, so it has to answer through them.
  if (toolGroup(name) === "status") return null;
  if (policy.paused) return "SMCP is paused. You can resume it from the app.";
  const group = toolGroup(name);
  // The brief has no switch of its own: each of its sections asks for the permission of the tool it reuses.
  // The person's own notes have no switch either; read-only mode still stops writing to them.
  if (group === "brief" || group === "approvals") return null;
  if (group === "context") {
    return policy.readOnly && annotations?.readOnlyHint !== true ? "SMCP is in read-only mode, so this action did not run." : null;
  }
  if (policy.disabled[group]) return `This permission (${group}) is turned off in the SMCP settings.`;
  if (policy.readOnly && annotations?.readOnlyHint !== true && annotations?.destructiveHint !== false) {
    return "SMCP is in read-only mode, so this action did not run.";
  }
  return group === "whatsapp" ? whatsappDenial(name, policy.whatsapp) : null;
}

/**
 * What this computer still decides about a tool that runs on the person's server computer: a pause or
 * read-only mode here stops it. The area switches that count are the server's, which checks them itself.
 */
export function denialForRouted(name, annotations, policy) {
  if (toolGroup(name) === "status") return null;
  if (policy.paused) return "SMCP is paused. You can resume it from the app.";
  if (policy.readOnly && annotations?.readOnlyHint !== true && annotations?.destructiveHint !== false) {
    return "SMCP is in read-only mode, so this action did not run.";
  }
  return null;
}

/** The one argument kept in the activity log: the command a terminal call from outside this computer ran. */
function auditDetail(name, source, args) {
  if (source === "local" || name !== "run_command") return undefined;
  return typeof args?.[0]?.command === "string" ? args[0].command : undefined;
}

/**
 * Wraps registerTool so the policy is re-read on every call; changes apply at once.
 * Every call is also written to the activity log, without its arguments or results; the one exception
 * is a terminal command that came from outside this computer, which is kept whole.
 *
 * `deny(name)` adds a reason of the caller's own (a remote switch that is off, too many calls).
 * `router` may send a call to the person's server computer instead of running it here.
 */
export function guarded(server, { source = "local", record = recordCall, client, deny, router } = {}) {
  const clientName = () => {
    if (client) return typeof client === "function" ? client() : client;
    try {
      return server.server?.getClientVersion?.()?.name ?? null;
    } catch {
      return null;
    }
  };
  return {
    registerTool(name, config, handler) {
      const routed = router?.wrap(name, config);
      return server.registerTool(name, routed?.config ?? config, async (...args) => {
        const started = Date.now();
        const policy = readPolicy();
        let denial;
        let result;
        let target = null;
        try {
          const route = routed ? routed.resolve(args) : null;
          target = route?.target ?? null;
          denial = route?.error ?? deny?.(name, policy) ?? (target ? denialForRouted(name, config.annotations, policy) : denialFor(name, config.annotations, policy));
          result = denial ? errorResult(denial) : target ? await route.call() : await handler(...(route ? route.args : args));
          return result;
        } finally {
          record({
            tool: name,
            source,
            client: clientName(),
            // "waiting" means the person has not approved it yet; what happens next gets a line of its own.
            outcome: denial ? "denied" : result === undefined ? "failed" : result.isError ? "error" : result._meta?.["smcp/waiting"] ? "waiting" : "ok",
            ms: Date.now() - started,
            detail: auditDetail(name, source, args),
            ...(target ? { to: target } : {}),
          });
        }
      });
    },
  };
}
