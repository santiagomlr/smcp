import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorResult } from "./util.js";

export const GROUPS = ["whatsapp", "gmail", "notes", "tasks", "files", "terminal", "apps"];

const DEFAULTS = {
  paused: false,
  readOnly: false,
  // Terminal and app control could work around the send confirmation, so a person has to switch them on.
  disabled: { whatsapp: false, gmail: false, notes: false, tasks: false, files: false, terminal: true, apps: true },
  // Writing is something a person opts into when linking. Even then, every message still needs the confirmation window.
  whatsapp: { read: true, send: false, audio: false },
  // Lets phone, web and scheduled routines edit tasks. Off until a person turns it on.
  remote: { taskWrites: false },
};

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
  whatsapp_send: ["send"],
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
      remote: { taskWrites: saved.remote?.taskWrites === true },
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
  if (name.startsWith("file_")) return "files";
  if (name === "smcp_status") return "status";
  if (name === "run_command") return "terminal";
  return "apps";
}

/** Returns why a tool may not run under this policy, or null if it may. */
export function denialFor(name, annotations, policy) {
  // The status check reports pauses and switched-off areas, so it has to answer through them.
  if (toolGroup(name) === "status") return null;
  if (policy.paused) return "SMCP is paused. You can resume it from the app.";
  const group = toolGroup(name);
  if (policy.disabled[group]) return `This permission (${group}) is turned off in the SMCP settings.`;
  if (policy.readOnly && annotations?.readOnlyHint !== true && annotations?.destructiveHint !== false) {
    return "SMCP is in read-only mode, so this action did not run.";
  }
  return group === "whatsapp" ? whatsappDenial(name, policy.whatsapp) : null;
}

/** Wraps registerTool so the policy is re-read on every call; changes apply at once. */
export function guarded(server) {
  return {
    registerTool(name, config, handler) {
      return server.registerTool(name, config, async (...args) => {
        const denial = denialFor(name, config.annotations, readPolicy());
        return denial ? errorResult(denial) : handler(...args);
      });
    },
  };
}
