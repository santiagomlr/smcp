import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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
  return dns || node.HostName || "desconocido";
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
  if (!user || !SAFE_NAME.test(user)) throw new Error("Falta un usuario SSH válido para esta máquina.");
  if (!machine.ip || !SAFE_IP.test(machine.ip)) throw new Error("Esta máquina no tiene una IP de Tailscale.");
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
  if (!MAC_ADDRESS.test(mac ?? "")) throw new Error("La dirección MAC de la PC no es válida.");
  const bytes = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

/** Wake-on-LAN broadcast. It only reaches the PC when this computer shares its local network. */
export function sendWake({ mac, broadcast = "255.255.255.255" }) {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 9, broadcast, (error) => {
        socket.close();
        if (error) reject(error);
        else resolve();
      });
    });
  });
}
