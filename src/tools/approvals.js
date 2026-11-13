import { z } from "zod";
import { HelperUnavailable, requestHelper } from "../helper.js";
import { callServerTool, readServerConfig } from "../server-route.js";
import { errorResult, textResult } from "../util.js";

const UNKNOWN = "No approval has that id on this computer. It may have expired; approvals are forgotten an hour after they end.";

/**
 * Something sent from outside this computer waits for the person to approve it on their own device.
 * This tool says how that ended, so the AI never has to guess whether a message went out.
 */
export function registerApprovals(server, { ask = (params) => requestHelper("approvalStatus", params, { timeoutMs: 70_000 }), server: readServer = readServerConfig, callServer = callServerTool } = {}) {
  server.registerTool(
    "approval_status",
    {
      description:
        "Says how an approval ended: `pending` (the person has not answered), `done` (approved and carried out, with the result), `failed` (approved, but it did not work), " +
        "`rejected` or `expired`. Use it after a tool answered `waiting_for_approval`, with the id it gave. Never send the same thing again while it is pending.",
      inputSchema: {
        id: z.string().min(4).max(64),
        wait_seconds: z.number().int().min(0).max(50).default(0).describe("Waits up to this long for the person to answer before replying."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, wait_seconds }) => {
      let found = null;
      try {
        found = await ask({ id, waitSeconds: wait_seconds });
      } catch (error) {
        if (!(error instanceof HelperUnavailable)) return errorResult(error.message);
      }
      if (found) return textResult(found);
      // An approval asked for on the server computer lives there, not here.
      const config = readServer();
      if (config) return callServer(config, "approval_status", { id, wait_seconds });
      return errorResult(UNKNOWN);
    },
  );
}
