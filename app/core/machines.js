import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { run } from "../../src/util.js";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_IP = /^[0-9a-fA-F.:]{3,45}$/;
const MAC_ADDRESS = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

export function tailscaleCandidates(platform = process.platform) {
  if (platform === "win32") return ["C:\\Program Files\\Tailscale\\tailscale.exe"];
  return ["/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale"];
}

function shortName(node) {
  const dns = (node.DNSName || "").split(".")[0];
  return dns || node.HostName || "unknown";
}

function toMachine(node, isSelf) {
  return {
    name: shortName(node),
    os: (node.OS || "").toLowerCase(),
    ip: node.TailscaleIPs?.[0] ?? null,
    dns: (node.DNSName || "").replace(/\.$/, "") || null,
    online: isSelf ? true : Boolean(node.Online),
    self: isSelf,
  };
}

/** Turns `tailscale status --json` into the list the UI shows, this machine first. */
export function parseStatus(status) {
  const running = status?.BackendState === "Running";
  const self = status?.Self ? [toMachine(status.Self, true)] : [];
  // With Funnel on, Tailscale lists its public ingress relays as peers. They are not the user's devices.
  const peers = Object.values(status?.Peer ?? {})
    .filter((node) => !node.Tags?.includes("tag:ingress"))
    .map((node) => toMachine(node, false))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { running, machines: [...self, ...peers] };
}

export async function readTailscale() {
  const bin = tailscaleCandidates().find((path) => existsSync(path));
  if (!bin) return { installed: false, running: false, machines: [] };
  const result = await run(bin, ["status", "--json"], { timeoutMs: 8_000 });
  if (result.code !== 0) return { installed: true, running: false, machines: [] };
  try {
    return { installed: true, ...parseStatus(JSON.parse(result.stdout)) };
  } catch {
    return { installed: true, running: false, machines: [] };
  }
}

/** Reuses the PC settings that pc-remote already keeps; never writes them. */
export async function readPcConfig(home = homedir()) {
  try {
    return JSON.parse(await readFile(join(home, ".pc-remote", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

export function sshTarget(machine, { settings = {}, pcConfig = {}, localUser = userInfo().username } = {}) {
  const custom = settings.machines?.[machine.name]?.user;
  const user = custom || (machine.os === "windows" ? pcConfig.user : localUser);
  if (!user || !SAFE_NAME.test(user)) throw new Error("A valid SSH user is missing for this machine.");
  if (!machine.ip || !SAFE_IP.test(machine.ip)) throw new Error("This machine has no Tailscale IP.");
  const identity = machine.os === "windows" ? pcConfig.identity : null;
  return { user, ip: machine.ip, identity };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Contents of a .command file that opens an SSH session in Terminal. */
export function sshCommandFile({ user, ip, identity }, home = homedir()) {
  const key = identity ? identity.replace(/^~(?=\/)/, home) : null;
  const keyArgs = key ? `-i ${shellQuote(key)} ` : "";
  return `#!/bin/zsh\nexec ssh ${keyArgs}${shellQuote(`${user}@${ip}`)}\n`;
}

export function magicPacket(mac) {
  if (!MAC_ADDRESS.test(mac ?? "")) throw new Error("The PC's MAC address is not valid.");
  const bytes = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

const ipToInt = (ip) => ip.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
const intToIp = (value) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Where to send the magic packet: the broadcast address of every local IPv4 network, then the global one.
 * macOS sends 255.255.255.255 out of a single interface (often not the Wi-Fi), so on its own it rarely arrives.
 * Tailscale's own addresses (100.64.0.0/10) are skipped: a sleeping PC only listens on its local network.
 */
export function broadcastTargets(interfaces = networkInterfaces(), extra = null) {
  const targets = [];
  if (extra && IPV4.test(extra)) targets.push(extra);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family === 4 ? "IPv4" : entry.family;
      if (family !== "IPv4" || entry.internal || !IPV4.test(entry.address ?? "") || !IPV4.test(entry.netmask ?? "")) continue;
      const ip = ipToInt(entry.address);
      if ((ip & 0xffc00000) >>> 0 === ipToInt("100.64.0.0")) continue;
      if (entry.netmask === "255.255.255.255") continue;
      targets.push(intToIp((ip | ~ipToInt(entry.netmask)) >>> 0));
    }
  }
  targets.push("255.255.255.255");
  return [...new Set(targets)];
}

function sendTo(socket, packet, port, address) {
  return new Promise((resolve) => socket.send(packet, port, address, (error) => resolve(!error)));
}

/**
 * Wake-on-LAN. It only reaches the PC from a computer on the PC's local network, so it goes to every
 * local network this computer is on, on ports 9 and 7, a few times over. Resolves with how many sends left.
 */
export async function sendWake({ mac, broadcast = null }, { interfaces, repeats = 3 } = {}) {
  const packet = magicPacket(mac);
  const targets = broadcastTargets(interfaces, broadcast);
  const socket = createSocket("udp4");
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => {
        socket.off("error", reject);
        socket.on("error", () => {});
        socket.setBroadcast(true);
        resolve();
      });
    });
    let sent = 0;
    for (let round = 0; round < repeats; round++) {
      for (const address of targets) {
        for (const port of [9, 7]) {
          if (await sendTo(socket, packet, port, address)) sent++;
        }
      }
    }
    if (!sent) throw new Error("Could not send the wake signal on this network.");
    return { sent, targets };
  } finally {
    socket.close();
  }
}
