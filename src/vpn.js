// VPNs: Tailscale plus the person's other VPNs (a work VPN such as FortiClient), turned on and off from SMCP.
// Both can stay on together: while another VPN is up, SMCP stops Tailscale from taking over name lookups,
// so the work VPN's internal names resolve and Tailscale (and the private URL) keep working.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fold, run as runFile } from "./util.js";

export const TAILSCALE_ID = "tailscale";
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const SAFE_APP = /^[^/\0]{1,80}$/;
const KINDS = new Set(["macos", "app", "command"]);
const CONNECT_WAIT_MS = 25_000;
const POLL_MS = 1_000;

export function tailscaleCandidates(platform = process.platform) {
  if (platform === "win32") return ["C:\\Program Files\\Tailscale\\tailscale.exe"];
  if (platform === "linux") return ["/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale", "/snap/bin/tailscale"];
  return ["/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale"];
}

export function vpnConfigPath() {
  return process.env.SMCP_VPN || join(homedir(), ".smcp", "vpn.json");
}

function vpnStatePath(configPath) {
  return join(dirname(configPath), "vpn-state.json");
}

export function slug(name) {
  return fold(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "vpn";
}

const argv = (value) => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0 && !part.includes("\0"));

/**
 * One VPN from ~/.smcp/vpn.json, or null when it is not usable. Only the person writes that file:
 * SMCP's file tools cannot touch ~/.smcp, so the AI cannot slip in a command of its own.
 */
export function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || !KINDS.has(entry.kind)) return null;
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 60) : null;
  const id = typeof entry.id === "string" && SAFE_ID.test(entry.id) ? entry.id : name ? slug(name) : null;
  if (!id || id === TAILSCALE_ID) return null;
  const probe = typeof entry.probe === "string" && SAFE_HOST.test(entry.probe) ? entry.probe : null;
  const base = { id, name: name ?? id, kind: entry.kind, probe };
  if (entry.kind === "macos") {
    const service = typeof entry.service === "string" && entry.service.trim() ? entry.service.trim() : name;
    return service ? { ...base, service } : null;
  }
  if (entry.kind === "app") {
    const app = typeof entry.app === "string" && SAFE_APP.test(entry.app) ? entry.app : null;
    return app ? { ...base, app } : null;
  }
  if (!argv(entry.connect) || !argv(entry.disconnect)) return null;
  return {
    ...base,
    connect: entry.connect,
    disconnect: entry.disconnect,
    status: argv(entry.status) ? entry.status : null,
    background: entry.background === true,
  };
}

/** A missing or damaged file means no VPNs of the person's own, only what SMCP finds by itself. */
export function readVpnConfig(path = vpnConfigPath()) {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    saved = {};
  }
  const seen = new Set();
  const vpns = [];
  for (const entry of Array.isArray(saved.vpns) ? saved.vpns : []) {
    const vpn = normalizeEntry(entry);
    if (vpn && !seen.has(vpn.id)) {
      seen.add(vpn.id);
      vpns.push(vpn);
    }
  }
  // On by default: the reason to keep two VPNs on is that both work.
  return { vpns, keepBothWorking: saved.keepBothWorking !== false, discover: saved.discover !== false };
}

function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    return { tailscaleDnsOffBySmcp: state?.tailscaleDnsOffBySmcp === true };
  } catch {
    return { tailscaleDnsOffBySmcp: false };
  }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * The VPNs listed in macOS System Settings, from `scutil --nc list`. A line looks like
 * `* (Connected)    UUID VPN (com.fortinet.forticlient.macos.vpn) "FortiClient"   [VPN:...]`.
 */
export function parseScutilList(text) {
  const services = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^\s*\*?\s*\(([^)]+)\)\s+\S+\s+\S+\s+\(([^)]*)\)\s+"([^"]+)"/);
    if (match) services.push({ status: match[1].trim(), type: match[2].trim(), name: match[3] });
  }
  return services;
}

const scutilConnected = (status) => /^connected$/i.test(status ?? "");
const scutilBusy = (status) => /^(connecting|disconnecting)$/i.test(status ?? "");

/** First line of `scutil --nc status "name"`: Connected, Disconnected, Connecting… */
export function parseScutilStatus(text) {
  return String(text ?? "").split("\n")[0].trim() || "Unknown";
}

/** Turns `tailscale status --json` into what matters here. */
export function parseTailscaleStatus(status) {
  const exit = status?.ExitNodeStatus;
  return {
    running: status?.BackendState === "Running",
    state: status?.BackendState ?? "Unknown",
    tailnet: status?.CurrentTailnet?.Name ?? null,
    usingExitNode: Boolean(exit?.ID),
    // MagicDNS answers lookups through 100.100.100.100 only while Tailscale is allowed to set DNS.
    magicDns: status?.CurrentTailnet?.MagicDNSEnabled === true,
  };
}

/** `tailscale debug prefs` prints the preferences as JSON; CorpDNS is "use Tailscale DNS". */
export function parseTailscalePrefs(text) {
  try {
    const prefs = JSON.parse(text);
    return { acceptDns: prefs?.CorpDNS !== false };
  } catch {
    return { acceptDns: null };
  }
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a VPN that keeps running in the foreground (openfortivpn, openconnect), logging to ~/.smcp. */
function startInBackground(logPath) {
  return (file, args) => {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const out = openSync(logPath, "a", 0o600);
    const child = spawn(file, args, { detached: true, stdio: ["ignore", out, out] });
    child.on("error", () => {});
    child.unref();
  };
}

function failure(result, fallback) {
  const text = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
  if (result.timedOut) return `${fallback} It did not finish in time.`;
  if (result.spawnError) return `${fallback} ${result.spawnError.message}`;
  return text ? `${fallback} ${text}` : fallback;
}

/**
 * Everything to read and change the VPNs. Every outside effect is passed in, so tests can run it
 * without touching the network.
 */
export function createVpn({
  run = runFile,
  exists = existsSync,
  platform = process.platform,
  configPath = vpnConfigPath(),
  lookup = (host) => dnsLookup(host),
  sleep = sleepFor,
  connectWaitMs = CONNECT_WAIT_MS,
  spawnBackground = null,
} = {}) {
  const statePath = vpnStatePath(configPath);
  const background = spawnBackground ?? startInBackground(join(dirname(configPath), "vpn.log"));
  const isMac = platform === "darwin";
  const tailscaleBin = () => tailscaleCandidates(platform).find((path) => exists(path)) ?? null;

  async function tailscale() {
    const bin = tailscaleBin();
    if (!bin) return { installed: false, running: false };
    const [statusResult, prefsResult] = await Promise.all([
      run(bin, ["status", "--json"], { timeoutMs: 8_000 }),
      run(bin, ["debug", "prefs"], { timeoutMs: 8_000 }),
    ]);
    let status = { running: false, state: "Stopped" };
    try {
      status = parseTailscaleStatus(JSON.parse(statusResult.stdout));
    } catch {
      // Logged out or the daemon is not running: `status --json` may print nothing useful.
    }
    const { acceptDns } = prefsResult.code === 0 ? parseTailscalePrefs(prefsResult.stdout) : { acceptDns: null };
    return { installed: true, ...status, acceptDns, dnsOffBySmcp: readState(statePath).tailscaleDnsOffBySmcp };
  }

  async function macServices() {
    if (!isMac) return [];
    const result = await run("/usr/sbin/scutil", ["--nc", "list"], { timeoutMs: 8_000 });
    return result.code === 0 ? parseScutilList(result.stdout) : [];
  }

  /** The person's VPNs, then the ones in System Settings, then FortiClient if it is installed but not listed. */
  async function listVpns() {
    const config = readVpnConfig(configPath);
    const services = await macServices();
    const vpns = config.vpns.map((vpn) => ({ ...vpn, source: "settings file" }));
    const taken = new Set(vpns.map((vpn) => vpn.id));
    const servicesTaken = new Set(vpns.filter((vpn) => vpn.kind === "macos").map((vpn) => fold(vpn.service)));
    const add = (vpn) => {
      if (taken.has(vpn.id) || vpn.id === TAILSCALE_ID) return;
      taken.add(vpn.id);
      vpns.push(vpn);
    };
    if (config.discover) {
      for (const service of services) {
        // Tailscale registers itself as a system VPN too; it already has its own entry.
        if (/tailscale/i.test(service.name) || /tailscale/i.test(service.type) || servicesTaken.has(fold(service.name))) continue;
        // FortiClient often names its system VPN just "VPN"; only its type says it is FortiClient.
        const isForti = /forti/i.test(service.type) && !/forti/i.test(service.name);
        const name = isForti ? "FortiClient" : service.name;
        add({ id: slug(name), name, kind: "macos", service: service.name, probe: null, source: "System Settings" });
      }
      const forti = "/Applications/FortiClient.app";
      const fortiListed =
        services.some((service) => /forti/i.test(service.type)) ||
        vpns.some((vpn) => /forti/i.test(vpn.name) || /forti/i.test(vpn.service ?? "") || /forti/i.test(vpn.app ?? ""));
      if (isMac && !fortiListed && exists(forti)) {
        add({ id: "forticlient", name: "FortiClient", kind: "app", app: "FortiClient", probe: null, source: "found in Applications" });
      }
    }
    return { vpns, services, config };
  }

  async function probeResolves(host) {
    if (!host) return null;
    try {
      await lookup(host);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether one VPN is up: by its own status, or, when it has none, by whether its probe name resolves. */
  async function vpnState(vpn, services) {
    const resolves = await probeResolves(vpn.probe);
    if (vpn.kind === "macos") {
      const service = services.find((item) => fold(item.name) === fold(vpn.service));
      if (!service) return { connected: false, status: "Not found in System Settings", resolves };
      return { connected: scutilConnected(service.status), status: service.status, resolves };
    }
    if (vpn.kind === "command" && vpn.status) {
      const result = await run(vpn.status[0], vpn.status.slice(1), { timeoutMs: 10_000 });
      return { connected: result.code === 0, status: result.code === 0 ? "Connected" : "Disconnected", resolves };
    }
    if (resolves === null) return { connected: null, status: "Unknown: add a probe name to know", resolves };
    return { connected: resolves, status: resolves ? "Connected" : "Disconnected", resolves };
  }

  /** Problems that keep the two VPNs from working together, in plain words. */
  function conflicts(ts, others) {
    const up = others.filter((vpn) => vpn.connected);
    if (!ts.running || !up.length) return [];
    const names = up.map((vpn) => vpn.name).join(", ");
    const list = [];
    if (ts.acceptDns !== false) {
      list.push(
        `Tailscale is handling name lookups while ${names} is on, so the internal names of ${names} may not resolve. ` +
          "vpn_connect on that VPN (or vpn_tailscale_dns with enabled: false) turns off only Tailscale's DNS; Tailscale stays connected.",
      );
    }
    if (ts.usingExitNode) list.push(`Tailscale is sending all traffic through an exit node, which takes the place of ${names}. Turn the exit node off in Tailscale.`);
    for (const vpn of up) {
      if (vpn.resolves === false) list.push(`${vpn.name} looks connected but its probe name ${vpn.probe} does not resolve.`);
    }
    return list;
  }

  async function status() {
    const [ts, { vpns, services, config }] = await Promise.all([tailscale(), listVpns()]);
    const others = await Promise.all(
      vpns.map(async (vpn) => {
        const state = await vpnState(vpn, services);
        return {
          id: vpn.id,
          name: vpn.name,
          kind: vpn.kind,
          source: vpn.source,
          ...state,
          ...(vpn.probe ? { probe: vpn.probe } : {}),
          canDisconnect: vpn.kind !== "app",
        };
      }),
    );
    return {
      tailscale: { id: TAILSCALE_ID, name: "Tailscale", ...ts },
      vpns: others,
      keepBothWorking: config.keepBothWorking,
      conflicts: conflicts(ts, others),
      settingsFile: configPath,
    };
  }

  async function findVpn(target) {
    const wanted = fold(target).trim();
    const { vpns, services, config } = await listVpns();
    const vpn = vpns.find((item) => item.id === wanted || fold(item.name) === wanted) ?? vpns.find((item) => fold(item.name).includes(wanted));
    if (!vpn) {
      const known = [TAILSCALE_ID, ...vpns.map((item) => item.id)].join(", ");
      throw new Error(`There is no VPN called "${target}". Available: ${known}. Others can be added in ${configPath}.`);
    }
    return { vpn, services, config };
  }

  async function setTailscaleDns(accept) {
    const bin = tailscaleBin();
    if (!bin) throw new Error("Tailscale is not installed.");
    const result = await run(bin, ["set", `--accept-dns=${accept}`], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error(failure(result, "Tailscale did not accept the DNS change."));
  }

  /** Called with another VPN on: Tailscale keeps running, only its DNS steps aside. */
  async function makeRoomForOtherVpn(config) {
    if (!config.keepBothWorking) return null;
    const ts = await tailscale();
    if (!ts.running || ts.acceptDns === false) return null;
    await setTailscaleDns(false);
    writeState(statePath, { tailscaleDnsOffBySmcp: true });
    return "Tailscale stays connected; SMCP turned off only its DNS so the other VPN's internal names resolve. It comes back when that VPN is turned off.";
  }

  /** Gives Tailscale its DNS back, only if SMCP took it and no other VPN is still on. */
  async function restoreTailscaleDns() {
    if (!readState(statePath).tailscaleDnsOffBySmcp) return null;
    const { vpns } = await status();
    if (vpns.some((vpn) => vpn.connected)) return null;
    const ts = await tailscale();
    if (ts.installed && ts.running) await setTailscaleDns(true);
    writeState(statePath, { tailscaleDnsOffBySmcp: false });
    return ts.running ? "Tailscale's DNS is back on." : null;
  }

  /**
   * Keeps both VPNs working when one was turned on or off outside SMCP (in FortiClient's own app, say):
   * takes Tailscale's DNS while another VPN is up, and gives it back once none is, only if SMCP took it.
   */
  async function reconcile() {
    const config = readVpnConfig(configPath);
    const { vpns } = await status();
    const notes = [];
    if (vpns.some((vpn) => vpn.connected)) {
      const note = await makeRoomForOtherVpn(config);
      if (note) notes.push(note);
    } else {
      const note = await restoreTailscaleDns();
      if (note) notes.push(note);
    }
    return { notes };
  }

  async function waitFor(check) {
    const deadline = Date.now() + connectWaitMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(POLL_MS);
    }
  }

  async function connectTailscale() {
    const bin = tailscaleBin();
    if (!bin) throw new Error("Tailscale is not installed.");
    const before = await tailscale();
    if (!before.running) {
      const result = await run(bin, ["up"], { timeoutMs: 20_000 });
      if (result.code !== 0) throw new Error(failure(result, "Tailscale did not connect. If it asks you to sign in, open the Tailscale app."));
    }
    const notes = [];
    // Turning Tailscale on while the work VPN is up must not take its names away again.
    const { vpns } = await status();
    if (vpns.some((vpn) => vpn.connected)) {
      const note = await makeRoomForOtherVpn(readVpnConfig(configPath));
      if (note) notes.push(note);
    }
    return { vpn: TAILSCALE_ID, connected: true, alreadyOn: before.running, notes };
  }

  async function disconnectTailscale() {
    const bin = tailscaleBin();
    if (!bin) throw new Error("Tailscale is not installed.");
    const result = await run(bin, ["down"], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error(failure(result, "Tailscale did not disconnect."));
    return {
      vpn: TAILSCALE_ID,
      connected: false,
      notes: ["Your private SMCP URL (phone, web) and your other devices are unreachable until Tailscale is on again."],
    };
  }

  async function connect(target) {
    if (fold(target).trim() === TAILSCALE_ID) return connectTailscale();
    const { vpn, services, config } = await findVpn(target);
    try {
      return await connectOther(vpn, services, config);
    } catch (error) {
      // The VPN did not come up, so Tailscale gets its DNS back if SMCP took it for nothing.
      await restoreTailscaleDns().catch(() => null);
      throw error;
    }
  }

  async function connectOther(vpn, services, config) {
    const notes = [];
    const current = await vpnState(vpn, services);
    // Step Tailscale's DNS aside first, so the VPN's own DNS wins as soon as it is up.
    const dnsNote = await makeRoomForOtherVpn(config);
    if (dnsNote) notes.push(dnsNote);
    if (current.connected) return { vpn: vpn.id, name: vpn.name, connected: true, alreadyOn: true, notes };

    if (vpn.kind === "macos") {
      const result = await run("/usr/sbin/scutil", ["--nc", "start", vpn.service], { timeoutMs: 15_000 });
      if (result.code !== 0) throw new Error(failure(result, `${vpn.name} did not start.`));
    } else if (vpn.kind === "app") {
      if (!isMac) throw new Error("Opening a VPN app only works on a Mac.");
      const result = await run("/usr/bin/open", ["-a", vpn.app], { timeoutMs: 10_000 });
      if (result.code !== 0) throw new Error(failure(result, `Could not open ${vpn.app}.`));
      if (!vpn.probe) {
        notes.push(`${vpn.app} is open. It cannot be connected by SMCP alone: press Connect there. Add a probe name for it in ${configPath} so SMCP can tell when it is up.`);
        return { vpn: vpn.id, name: vpn.name, connected: null, needsYou: true, notes };
      }
      notes.push(`${vpn.app} is open; press Connect there if it does not connect by itself.`);
    } else if (vpn.background) {
      background(vpn.connect[0], vpn.connect.slice(1));
    } else {
      const result = await run(vpn.connect[0], vpn.connect.slice(1), { timeoutMs: 60_000 });
      if (result.code !== 0) throw new Error(failure(result, `${vpn.name} did not connect.`));
    }

    const up = await waitFor(async () => {
      const fresh = vpn.kind === "macos" ? await macServices() : services;
      const state = await vpnState(vpn, fresh);
      if (vpn.kind === "macos" && scutilBusy(state.status)) return null;
      return state.connected ? state : null;
    });
    if (!up) {
      notes.push(`${vpn.name} has not reported connected yet${vpn.kind === "app" ? "; finish connecting in the app" : ""}. Check again with vpn_status.`);
      return { vpn: vpn.id, name: vpn.name, connected: false, notes };
    }
    return { vpn: vpn.id, name: vpn.name, connected: true, ...(up.resolves !== null ? { probeResolves: up.resolves } : {}), notes };
  }

  async function disconnect(target) {
    if (fold(target).trim() === TAILSCALE_ID) return disconnectTailscale();
    const { vpn } = await findVpn(target);
    if (vpn.kind === "macos") {
      const result = await run("/usr/sbin/scutil", ["--nc", "stop", vpn.service], { timeoutMs: 15_000 });
      if (result.code !== 0) throw new Error(failure(result, `${vpn.name} did not stop.`));
    } else if (vpn.kind === "app") {
      throw new Error(`${vpn.name} can only be disconnected in its own app.`);
    } else {
      const result = await run(vpn.disconnect[0], vpn.disconnect.slice(1), { timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error(failure(result, `${vpn.name} did not disconnect.`));
    }
    if (vpn.kind === "macos") {
      await waitFor(async () => {
        const state = await vpnState(vpn, await macServices());
        return state.connected === false && !scutilBusy(state.status);
      });
    }
    const notes = [];
    const restored = await restoreTailscaleDns();
    if (restored) notes.push(restored);
    return { vpn: vpn.id, name: vpn.name, connected: false, notes };
  }

  /** Sets Tailscale's DNS by hand: off to let a work VPN resolve its names, on to get MagicDNS back. */
  async function fixDns(accept) {
    const ts = await tailscale();
    if (!ts.installed) throw new Error("Tailscale is not installed.");
    await setTailscaleDns(accept);
    writeState(statePath, { tailscaleDnsOffBySmcp: !accept });
    return {
      tailscaleDns: accept,
      notes: [accept ? "Tailscale handles name lookups again (MagicDNS)." : "Tailscale no longer handles name lookups; it stays connected, and the other VPN's names resolve."],
    };
  }

  return { status, connect, disconnect, fixDns, reconcile, tailscale, listVpns };
}
