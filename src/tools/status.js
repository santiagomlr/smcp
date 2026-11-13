import { existsSync, readFileSync } from "node:fs";
import { viaHelper } from "../helper.js";
import { GROUPS, readPolicy } from "../policy.js";
import { readCheckpoints } from "../brain/checkpoint.js";
import { readBrainConfig } from "../brain/config.js";
import { describeSources } from "../brain/inbox.js";
import { callServerTool, readServerConfig, ROUTED_AREAS } from "../server-route.js";
import { run, textResult } from "../util.js";
import { enabledVaults } from "../vaults.js";
import { createVpn } from "../vpn.js";
import { awakeCall } from "./awake.js";
import { nightLightCall } from "./nightlight.js";
import { securityProbe } from "./security.js";
import { callApp } from "./tasks.js";
import { storeDir, wacliBin } from "./whatsapp.js";
import { createRelay } from "../whatsapp-relay.js";

const PROBE_TIMEOUT_MS = 15_000;
/** From outside, these need "terminal and computer control" turned on for remote access. */
const REMOTE_CONTROL_AREAS = new Set(["clipboard", "terminal", "apps"]);
const LOCAL_ONLY = new Set(["nightlight"]);
const SERVER_STATUS_TIMEOUT_MS = 20_000;

/** The server computer's own report, or why it could not be had. Never throws. */
async function askServer(config) {
  const result = await callServerTool(config, "smcp_status", {});
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) return { error: text || "The server computer did not answer." };
  try {
    return { status: JSON.parse(text) };
  } catch {
    return { error: "The server computer answered with something SMCP could not read." };
  }
}

/** How the raw exports to the vault are doing, or null when none is set up. */
export function exportsStatus({ config = readBrainConfig(), checkpoints = readCheckpoints(), now = Date.now() } = {}) {
  if (!config.vault) return null;
  const sources = describeSources(config, checkpoints, now).filter((source) => source.status !== "off");
  if (!sources.length) return null;
  return { sources, notWorking: sources.filter((source) => source.status !== "ok").map((source) => `${source.source}: ${source.status}${source.error ? ` (${source.error})` : ""}`) };
}

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
    const doctor = () => run(wacliBin(), [`--store=${storeDir()}`, "--read-only", "--json", "doctor"], { timeoutMs: 8_000 });
    const relay = createRelay({ localDoctor: doctor });
    if (existsSync(storeDir()) && (await relay.linkedHere())) return {};
    // Not linked here: it still works if another of the person's computers has it and answers.
    const remote = await relay.run(["--read-only", "--json", "doctor"], 8_000);
    const data = remote && remote.code === 0 ? JSON.parse(remote.stdout || "null")?.data : null;
    if (data?.authenticated) return { onAnotherComputer: true };
    let reason = null;
    try {
      reason = JSON.parse(remote?.stderr || "null")?.error ?? null;
    } catch {
      // Not JSON: fall back to the plain reason.
    }
    throw new Error(reason || "WhatsApp is not linked.");
  },
};

/**
 * One call that says what works right now, area by area, so a routine can stop early with a clear
 * reason instead of failing halfway. It never fails itself: problems are part of the answer.
 */
export async function smcpStatus({
  remote = false,
  policy = readPolicy(),
  probes = DEFAULT_PROBES,
  timeoutMs = PROBE_TIMEOUT_MS,
  server = readServerConfig(),
  serverStatus = askServer,
  exports = exportsStatus,
} = {}) {
  const areas = {};
  const routed = server && !policy.paused ? ROUTED_AREAS.filter((area) => server.areas[area] && GROUPS.includes(area)) : [];
  // One question to the server covers every area that runs there.
  const there = routed.length ? await withTimeout(serverStatus(server), SERVER_STATUS_TIMEOUT_MS).catch((error) => ({ error: error.message })) : null;
  await Promise.all(
    GROUPS.map(async (group) => {
      if (routed.includes(group)) {
        // This area runs on the server computer, so its switches and its state are the ones that count.
        areas[group] = there.status?.areas?.[group]
          ? { ...there.status.areas[group], runsOn: server.name }
          : { ok: false, reason: there.error ?? "The server computer did not report this area.", runsOn: server.name };
        return;
      }
      if (remote && LOCAL_ONLY.has(group)) {
        areas[group] = { ok: false, reason: "Only available on the computer itself." };
        return;
      }
      if (remote && REMOTE_CONTROL_AREAS.has(group) && policy.remote?.control !== true) {
        areas[group] = { ok: false, reason: "Turned off for remote access. The person can turn on the terminal, files and control of the computer in SMCP, under Settings > Remote access." };
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
  let exported = null;
  try {
    exported = exports();
  } catch {
    // The exports are reported when they can be read; they never break the rest of the report.
  }
  return {
    version: version(),
    checkedAt: new Date().toISOString(),
    paused: policy.paused,
    readOnly: policy.readOnly,
    ...(remote
      ? {
          remoteTaskWrites: policy.remote?.taskWrites === true,
          remoteAccess: { tasks: policy.remote?.taskWrites === true, write: policy.remote?.write === true, control: policy.remote?.control === true, send: policy.remote?.send === true },
        }
      : {}),
    ...(server
      ? {
          server: {
            name: server.name,
            areasOnServer: routed,
            ...(there ? { reachable: !there.error, ...(there.error ? { reason: there.error } : {}) } : {}),
            note: "Areas listed here run on the server computer; the rest run on this one.",
          },
        }
      : {}),
    working,
    notWorking: Object.keys(areas).filter((group) => !areas[group].ok),
    areas: Object.fromEntries(GROUPS.map((group) => [group, areas[group]])),
    // A failed or silent export shows here, so a routine does not read stale raw files as "nothing new".
    ...(exported ? { exports: exported } : {}),
  };
}

export function registerStatus(server, { remote = false } = {}) {
  server.registerTool(
    "smcp_ping",
    {
      description:
        "The lightest check that SMCP is reachable: it answers with the time on the computer and nothing personal. If this fails or does not answer, SMCP could not be reached; say so instead of guessing.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => textResult({ ok: true, at: new Date().toISOString(), version: version(), via: remote ? "remote connector" : "this computer" }),
  );

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
