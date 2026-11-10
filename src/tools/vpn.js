// VPNs: the AI can see which VPNs are on and turn Tailscale and the person's other VPNs (such as a work
// FortiClient) on and off, keeping both working at the same time.
import { z } from "zod";
import { createVpn, TAILSCALE_ID } from "../vpn.js";
import { errorResult, textResult } from "../util.js";

const handle = (fn) => async (args) => {
  try {
    return textResult(await fn(args ?? {}));
  } catch (error) {
    return errorResult(error.message);
  }
};

const target = z
  .string()
  .min(1)
  .max(60)
  .describe(`"${TAILSCALE_ID}", or the id or name of another VPN as vpn_status lists it (for example "forticlient" or "senda").`);

export function registerVpn(server, { vpn = createVpn() } = {}) {
  server.registerTool(
    "vpn_status",
    {
      description:
        "Lists the VPNs on this computer and whether each is on: Tailscale (with whether it is handling name lookups and using an exit node) " +
        "and the person's other VPNs, such as a work VPN, from System Settings or SMCP's VPN settings file. " +
        "Also lists conflicts that would keep both from working at once. Call it before using tools that need a work VPN.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(() => vpn.status()),
  );

  server.registerTool(
    "vpn_connect",
    {
      description:
        "Turns a VPN on. For a work VPN while Tailscale is on, Tailscale stays connected and SMCP turns off only Tailscale's DNS, " +
        "so the work VPN's internal names resolve and SMCP's private URL keeps working; Tailscale's DNS comes back when that VPN is turned off. " +
        "Some VPN apps (FortiClient without a system VPN) can only be opened: then the answer says to press Connect in the app. " +
        "It also works from the phone or the web, so a computer serving with its screen off can get back onto the work network.",
      inputSchema: { vpn: target },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handle(({ vpn: name }) => vpn.connect(name)),
  );

  server.registerTool(
    "vpn_disconnect",
    {
      description:
        "Turns a VPN off. Turning Tailscale off also cuts SMCP's private URL (phone, web) and the person's other devices, so only do it when asked. " +
        "Turning a work VPN off gives Tailscale its DNS back if SMCP had taken it.",
      inputSchema: { vpn: target },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handle(({ vpn: name }) => vpn.disconnect(name)),
  );

  server.registerTool(
    "vpn_tailscale_dns",
    {
      description:
        "Lets Tailscale handle name lookups (enabled: true, MagicDNS) or not (enabled: false) without disconnecting it. " +
        "Turn it off when a work VPN's internal names do not resolve while both VPNs are on.",
      inputSchema: { enabled: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(({ enabled }) => vpn.fixDns(enabled)),
  );
}
