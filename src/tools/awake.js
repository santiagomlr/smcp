// Keep awake: the AI can keep this computer running with the screen off while it works, like
// Amphetamine or caffeinate, and say whether macOS is really honoring it. Only SMCP.app can hold the
// assertion for as long as needed, so every change goes through it.
import { z } from "zod";
import { describe, MAX_MINUTES, readSettings } from "../awake.js";
import { viaHelper } from "../helper.js";
import { errorResult, textResult } from "../util.js";
import { formatLocal } from "./calendar.js";

const APP_CLOSED = "Open the SMCP app to keep this computer awake: only the app can hold it awake.";

/** Asks the app; with the app closed, reading still answers from the saved settings. */
export function awakeCall(op, args = {}, { helper = viaHelper } = {}) {
  return helper("awake", { op, args }, () => {
    if (op !== "status") throw new Error(APP_CLOSED);
    return { ...describe(readSettings(), Date.now(), { formatTime: formatLocal }), active: false, running: false, note: "The SMCP app is closed, so nothing is keeping the computer awake." };
  });
}

const handle = (fn) => async (args) => {
  try {
    return textResult(await fn(args ?? {}));
  } catch (error) {
    return errorResult(error.message);
  }
};

export function registerAwake(server, { call = awakeCall } = {}) {
  server.registerTool(
    "awake_status",
    {
      description:
        "Says whether SMCP is keeping this computer awake, until when, and whether macOS really shows SMCP's assertion (verified). " +
        "Also: battery, closed-lid mode, which other apps keep it awake, and warnings about anything that would still let it sleep. " +
        "While a session is on, vpnGuard lists the VPNs it keeps connected and each time one dropped (with whether the screen was off) and was brought back. " +
        "Pass diagnose: true to also get the latest times it went to sleep and why (lid closed, idle, low battery).",
      inputSchema: { diagnose: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(({ diagnose }) => call(diagnose ? "diagnose" : "status")),
  );

  server.registerTool(
    "awake_start",
    {
      description:
        "Keeps this computer running, with its screen free to turn off, like Amphetamine. Use it before long work (a build, a download, a long Claude task) " +
        "so the computer does not sleep halfway. Give at most one ending: minutes, until (\"18:30\" or an ISO date), while_app (ends when that app quits) " +
        "or while_claude (ends when Claude Code and the Claude app have all closed). With none it lasts until awake_stop. " +
        "It replaces any session in progress. Closed-lid mode works only if the person set it up in SMCP's Settings; check awake_status for warnings.",
      inputSchema: {
        minutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
        until: z.string().max(40).optional().describe("A time today such as \"18:30\" (tomorrow if it has passed), or an ISO date."),
        while_app: z.string().max(60).optional().describe("Process name of an app, such as \"Xcode\" or \"node\"."),
        while_claude: z.boolean().optional(),
        reason: z.string().max(120).optional().describe("A few words shown to the person, such as \"Running the nightly build\"."),
        keep_screen_on: z.boolean().optional().describe("Keep the screen on too. Leave it out to let the screen turn off."),
        closed_lid: z.boolean().optional().describe("Keep running with the lid closed (needs the one-time setup)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(({ minutes, until, while_app: whileApp, while_claude: whileClaude, reason, keep_screen_on: displayOn, closed_lid: closedLid }) =>
      call("start", { minutes, until, whileApp, whileClaude, reason, displayOn, closedLid }),
    ),
  );

  server.registerTool(
    "awake_stop",
    {
      description: "Stops keeping this computer awake, so it can sleep on its usual schedule again. Closed-lid mode is undone too.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(() => call("stop")),
  );

  server.registerTool(
    "awake_screen_off",
    {
      description:
        "Turns the screen off now while the computer keeps running, if keep awake is on. Any key or the trackpad turns it back on. " +
        "If the Mac asks for a password after the screen sleeps, this also locks it.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(() => call("screenOff")),
  );
}
