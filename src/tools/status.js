import { existsSync, readFileSync } from "node:fs";
import { viaHelper } from "../helper.js";
import { GROUPS, readPolicy } from "../policy.js";
import { textResult } from "../util.js";
import { enabledVaults } from "../vaults.js";
import { createVpn } from "../vpn.js";
import { awakeCall } from "./awake.js";
import { nightLightCall } from "./nightlight.js";
import { securityProbe } from "./security.js";
import { callApp } from "./tasks.js";
import { storeDir, wacliBin } from "./whatsapp.js";

const PROBE_TIMEOUT_MS = 15_000;
const LOCAL_ONLY = new Set(["clipboard", "terminal", "apps", "nightlight"]);

function version() {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return null;
  }
}

/** A probe that hangs counts as a failure instead of holding up the whole report. */
function withTimeout(promise, ms = PROBE_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Did not answer in time.")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Checks that actually touch each area. Each one returns details or throws why it cannot work. */
export const DEFAULT_PROBES = {
  async tasks() {
    const { value, offline } = await callApp("summary", {});
    return { ...value, ...(offline ? { offline: true, note: "The app is closed: reading works, writing does not." } : {}) };
  },
  async gmail() {
    const accounts = await viaHelper("gmailAccounts", {}, () => {
      throw new Error("Open the SMCP app to use Gmail.");
    });
    if (!accounts?.length) throw new Error("No Gmail account is connected.");
    return { accounts: accounts.length };
  },
  async notes() {
    const vaults = enabledVaults();
    if (!vaults.length) throw new Error("No vault is turned on.");
    return { vaults: vaults.length };
  },
  security: securityProbe,
  async nightlight() {
    const state = await nightLightCall("status");
    if (!("installed" in state)) throw new Error("Open the SMCP app to change the screen color.");
    if (state.supported === false) throw new Error("Only available on a Mac.");
    if (!state.installed) throw new Error("The night light helper is not installed in this copy of SMCP.");
    return { on: state.enabled, ...(state.now ? { kelvin: state.now.kelvin } : {}) };
  },
  async vpn() {
    const { tailscale, vpns, conflicts } = await createVpn().status();
    return {
      tailscale: tailscale.installed ? (tailscale.running ? "on" : "off") : "not installed",
      on: vpns.filter((vpn) => vpn.connected).map((vpn) => vpn.name),
      ...(conflicts.length ? { conflicts } : {}),
    };
  },
  async awake() {
    const state = await awakeCall("status");
    if (state.running === false) throw new Error("Open the SMCP app to keep the computer awake.");
    return {
      on: state.active,
      ...(state.active ? { ends: state.ends, verified: state.verified } : {}),
      ...(state.warnings?.length ? { warnings: state.warnings.map((warning) => warning.text) } : {}),
    };
  },
  async whatsapp() {
    if (!existsSync(wacliBin())) throw new Error("wacli is not installed.");
    if (!existsSync(storeDir())) throw new Error("WhatsApp is not linked.");
    return {};
  },
};

/**
 * One call that says what works right now, area by area, so a routine can stop early with a clear
 * reason instead of failing halfway. It never fails itself: problems are part of the answer.
 */
export async function smcpStatus({ remote = false, policy = readPolicy(), probes = DEFAULT_PROBES, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const areas = {};
  await Promise.all(
    GROUPS.map(async (group) => {
      if (remote && LOCAL_ONLY.has(group)) {
        areas[group] = { ok: false, reason: "Only available on the computer itself." };
        return;
      }
      if (policy.disabled[group]) {
        areas[group] = { ok: false, reason: "Turned off in SMCP settings." };
        return;
      }
      const probe = probes[group];
      if (policy.paused || !probe) {
        areas[group] = { ok: !policy.paused, ...(policy.paused ? { reason: "SMCP is paused." } : {}) };
        return;
      }
      try {
        areas[group] = { ok: true, ...(await withTimeout(probe(), timeoutMs)) };
      } catch (error) {
        areas[group] = { ok: false, reason: error.message };
      }
    }),
  );
  if (areas.whatsapp?.ok) areas.whatsapp.can = { ...policy.whatsapp };
  if (areas.tasks?.ok) {
    const writes = policy.readOnly ? false : remote ? policy.remote?.taskWrites === true : !areas.tasks.offline;
    areas.tasks.canWrite = writes;
  }
  const working = Object.entries(areas).filter(([, area]) => area.ok).map(([group]) => group);
  return {
    version: version(),
    checkedAt: new Date().toISOString(),
    paused: policy.paused,
    readOnly: policy.readOnly,
    ...(remote ? { remoteTaskWrites: policy.remote?.taskWrites === true } : {}),
    working,
    notWorking: Object.keys(areas).filter((group) => !areas[group].ok),
    areas: Object.fromEntries(GROUPS.map((group) => [group, areas[group]])),
  };
}

export function registerStatus(server, { remote = false } = {}) {
  server.registerTool(
    "smcp_status",
    {
      description:
        "Checks what SMCP can do right now, area by area: tasks, WhatsApp, Gmail, notes and the rest, with the reason when something is off. " +
        "It always answers, even when SMCP is paused. Call it first in scheduled routines, and stop with that reason if an area you need is not working.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => textResult(await smcpStatus({ remote })),
  );
}
