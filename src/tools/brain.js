import { z } from "zod";
import { brainInbox } from "../brain/inbox.js";
import { writeInboxMark } from "../brain/checkpoint.js";
import { viaHelper } from "../helper.js";
import { errorResult, textResult } from "../util.js";

/**
 * SMCP pulls, the AI interprets: the exporters write raw data into the vault on a schedule, and these
 * tools tell the AI exactly what is new there and whether each source is really running.
 */
export function registerBrain(server, { inbox = brainInbox, mark = writeInboxMark, exportNow = (params) => viaHelper("brainExport", params, () => {
  throw new Error("Open the SMCP app to run an export.");
}, { timeoutMs: 300_000 }) } = {}) {
  const safe = (fn) => async (args) => {
    try {
      return textResult(await fn(args ?? {}));
    } catch (error) {
      return errorResult(error.message);
    }
  };

  server.registerTool(
    "brain_inbox",
    {
      description:
        "Lists the raw files SMCP exported into the notes vault (WhatsApp chats, Gmail day files) that changed since they were last interpreted, " +
        "and how each source is doing: ok, failed, late or never run. Start an interpretation here instead of sweeping folders, and stop if a source you need is not ok.",
      inputSchema: { since: z.string().max(40).optional().describe("An ISO date and time to list from, instead of the saved mark.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(({ since }) => {
      if (since && Number.isNaN(Date.parse(since))) throw new Error("`since` must be an ISO date and time.");
      return inbox(since ? { since: new Date(since).toISOString() } : {});
    }),
  );

  server.registerTool(
    "brain_inbox_mark",
    {
      description: "Saves until when the raw files have been interpreted, so the next brain_inbox starts there. Pass the `now` that brain_inbox returned, after you finished with its list.",
      inputSchema: { through: z.string().max(40).describe("The `now` value from the brain_inbox call you just processed.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(({ through }) => ({ interpreted_through: mark(through) })),
  );

  server.registerTool(
    "brain_export_now",
    {
      description: "Runs SMCP's raw exports to the vault right now instead of waiting for their schedule, and returns what each one wrote or why it failed. Without `source`, every source that is on.",
      inputSchema: { source: z.string().max(200).optional().describe("`whatsapp`, or `gmail:<account email>`, as listed by brain_inbox.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(({ source }) => exportNow({ source })),
  );
}
