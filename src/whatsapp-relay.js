// WhatsApp lives on one computer: the one where it is linked. The person's other computers with SMCP
// ask that one over Tailscale instead of reading an old copy of their own, so every computer sees the
// same chats. Only reading and syncing travel; sending stays on the computer that has WhatsApp, because
// the confirmation window has to appear where the session is.
import { HelperUnavailable, requestHelper } from "./helper.js";

/** The read-only wacli commands another computer may ask for, as [command, subcommand]. */
const RELAYED = new Set(["doctor", "chats list", "chats show", "messages list", "messages show", "messages search", "contacts search"]);

/** Options that would choose another store, write a file or wait on locks. They never travel. */
const FORBIDDEN_OPTION = /^--(store|output|account|lock-wait|events|read-only|json)(=|$)/;
const OPTION = /^--[a-z][a-z-]*(=[\s\S]*)?$/;
const MAX_ARGS = 20;
const MAX_ARG_CHARS = 500;

/** Base flags SMCP puts before every command; the computer with WhatsApp adds its own. */
const BASE_FLAGS = new Set(["--read-only", "--json"]);

/**
 * Checks a command another computer sent and returns it without SMCP's base flags, or null if it may not run.
 * Everything after `--` is a search text, so it can be anything.
 */
export function relayableArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS) return null;
  if (!args.every((arg) => typeof arg === "string" && arg.length <= MAX_ARG_CHARS)) return null;
  let start = 0;
  while (start < args.length && BASE_FLAGS.has(args[start])) start += 1;
  const rest = args.slice(start);
  const [command, subcommand] = rest;
  const key = command === "doctor" ? "doctor" : `${command} ${subcommand}`;
  if (!RELAYED.has(key)) return null;
  const end = rest.indexOf("--");
  const options = rest.slice(command === "doctor" ? 1 : 2, end < 0 ? rest.length : end);
  if (!options.every((arg) => OPTION.test(arg) && !FORBIDDEN_OPTION.test(arg))) return null;
  return rest;
}

/** What wacli's run() would return for a failure, so the tools report it the same way. */
export const SEND_ELSEWHERE =
  "WhatsApp is linked on another of your computers, not this one. Sending works only there, because the confirmation window appears on that computer.";
export const MEDIA_ELSEWHERE =
  "WhatsApp is linked on another of your computers, not this one. Files and voice notes can be opened only there.";

export function failedResult(error) {
  return { code: 1, stdout: "", stderr: JSON.stringify({ success: false, error }), timedOut: false };
}

const CHECK_TTL_MS = 60_000;

/**
 * Decides, per command, whether this computer answers WhatsApp itself or asks the one where it is linked.
 * It asks only when this computer has no session of its own; a linked computer always answers itself.
 */
export function createRelay({ localDoctor, ask = (params, timeoutMs) => requestHelper("whatsappRelay", params, { timeoutMs }), now = Date.now } = {}) {
  let checked = null;

  const linkedHere = async () => {
    if (checked && now() - checked.at < CHECK_TTL_MS) return checked.linked;
    const result = await localDoctor();
    let linked;
    if (result.spawnError?.code === "ENOENT") linked = false;
    else {
      try {
        const data = JSON.parse(result.stdout)?.data;
        // A doctor that failed to answer says nothing, so this computer keeps answering itself.
        linked = data && typeof data.authenticated === "boolean" ? data.authenticated && !data.session_revoked : true;
      } catch {
        linked = true;
      }
    }
    checked = { at: now(), linked };
    return linked;
  };

  return {
    linkedHere,
    /**
     * Runs `args` on the computer with WhatsApp. Returns null when this computer should answer itself,
     * including when SMCP.app is not reachable, so nothing gets worse than before.
     */
    async run(args, timeoutMs) {
      if (await linkedHere()) return null;
      const isSync = args.includes("sync");
      if (!isSync && !relayableArgs(args)) return failedResult(args.includes("send") ? SEND_ELSEWHERE : MEDIA_ELSEWHERE);
      try {
        return await ask({ args: isSync ? ["sync"] : args, timeoutMs }, timeoutMs + 20_000);
      } catch (error) {
        if (error instanceof HelperUnavailable) return null;
        return failedResult(error.message);
      }
    },
  };
}
