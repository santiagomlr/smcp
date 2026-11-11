import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { addToDesktop, claudeCliCandidates, findClaudeCli, isRegistered, removeFromDesktop, serverEntry } from "../app/core/clients.js";
import { linuxSshCommand, magicPacket, parseStatus, sshCommandFile, sshTarget, tailscaleCandidates } from "../app/core/machines.js";
import { parseDoctor, qrFromEventLine } from "../app/core/whatsapp.js";

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-app-"));
});
after(() => rm(dir, { recursive: true, force: true }));

const STATUS = {
  BackendState: "Running",
  Self: { DNSName: "m4.tailnet.ts.net.", HostName: "MacBook", OS: "macOS", TailscaleIPs: ["100.0.0.1"], Online: false },
  Peer: {
    a: { DNSName: "casa-pc.tailnet.ts.net.", HostName: "PC", OS: "windows", TailscaleIPs: ["100.0.0.2"], Online: false },
    b: { DNSName: "estudio-mac.tailnet.ts.net.", HostName: "M1", OS: "macOS", TailscaleIPs: ["100.0.0.3"], Online: true },
  },
};

test("Tailscale: esta máquina primero y en línea, luego las conectadas", () => {
  const { running, machines } = parseStatus(STATUS);
  assert.equal(running, true);
  assert.deepEqual(machines.map((machine) => machine.name), ["m4", "estudio-mac", "casa-pc"]);
  assert.equal(machines[0].online, true);
  assert.equal(machines[0].self, true);
  assert.equal(machines[2].os, "windows");
  assert.equal(machines[1].dns, "estudio-mac.tailnet.ts.net");
});

test("los nodos públicos de Funnel no cuentan como dispositivos", () => {
  const status = {
    ...STATUS,
    Peer: { ...STATUS.Peer, x: { HostName: "funnel-ingress-node", DNSName: "", Tags: ["tag:ingress"], Online: true } },
  };
  assert.equal(parseStatus(status).machines.length, 3);
});

test("Tailscale detenido o sin datos no truena", () => {
  assert.deepEqual(parseStatus({ BackendState: "Stopped" }), { running: false, machines: [] });
  assert.deepEqual(parseStatus(null), { running: false, machines: [] });
});

test("usuario SSH: el personalizado gana y la PC usa su configuración", () => {
  const mac = { name: "m1", os: "macos", ip: "100.0.0.3" };
  const pc = { name: "pc", os: "windows", ip: "100.0.0.2" };
  const pcConfig = { user: "santi", identity: "~/.ssh/id_pc" };
  assert.equal(sshTarget(mac, { localUser: "yo" }).user, "yo");
  assert.equal(sshTarget(mac, { localUser: "yo", settings: { machines: { m1: { user: "otro" } } } }).user, "otro");
  assert.deepEqual(sshTarget(pc, { pcConfig }), { user: "santi", ip: "100.0.0.2", identity: "~/.ssh/id_pc" });
});

test("rechaza usuarios e IP que podrían inyectar comandos", () => {
  const settings = { machines: { m1: { user: "a; rm -rf ~" } } };
  assert.throws(() => sshTarget({ name: "m1", os: "macos", ip: "100.0.0.3" }, { settings }), /SSH user/);
  assert.throws(() => sshTarget({ name: "m1", os: "macos", ip: "$(x)" }, { localUser: "yo" }), /IP/);
});

test("el archivo .command entrecomilla la ruta de la llave", () => {
  const file = sshCommandFile({ user: "a", ip: "100.0.0.2", identity: "~/o'k/id" }, "/Users/s");
  assert.ok(file.includes(`-i '/Users/s/o'\\''k/id' 'a@100.0.0.2'`));
});

test("Wake-on-LAN: 6 bytes FF y la MAC 16 veces; rechaza MAC inválida", () => {
  const packet = magicPacket("AA:BB:CC:DD:EE:FF");
  assert.equal(packet.length, 102);
  assert.equal(packet.subarray(0, 6).toString("hex"), "ffffffffffff");
  assert.equal(packet.subarray(96, 102).toString("hex"), "aabbccddeeff");
  assert.throws(() => magicPacket("no-es-mac"), /MAC/);
  assert.throws(() => magicPacket(undefined), /MAC/);
});

test("Claude Desktop: agrega sin tocar lo demás, respalda y se puede quitar", async () => {
  const path = join(dir, "config.json");
  const original = { theme: "dark", mcpServers: { otro: { command: "x" } } };
  await writeFile(path, JSON.stringify(original));
  const entry = serverEntry({ execPath: "/App", script: "/s.js", wacliBin: "/w" });
  await addToDesktop(path, entry);
  assert.equal(await isRegistered(path), true);
  const updated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(updated.theme, "dark");
  assert.deepEqual(updated.mcpServers.otro, { command: "x" });
  assert.deepEqual(updated.mcpServers["smcp"].env, { ELECTRON_RUN_AS_NODE: "1", WACLI_BIN: "/w" });
  assert.deepEqual(JSON.parse(await readFile(`${path}.smcp.bak`, "utf8")), original);
  await removeFromDesktop(path);
  assert.equal(await isRegistered(path), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mcpServers, { otro: { command: "x" } });
});

test("un JSON dañado no se sobrescribe", async () => {
  const path = join(dir, "roto.json");
  await writeFile(path, "{ no json");
  await assert.rejects(addToDesktop(path, {}), /Could not read/);
  assert.equal(await readFile(path, "utf8"), "{ no json");
  assert.equal(await isRegistered(path), false);
});

test("lee el diagnóstico de wacli y el QR de sus eventos", () => {
  const linked = parseDoctor(JSON.stringify({ data: { authenticated: true, store: { messages: 5, chats: 2 } } }));
  assert.equal(linked.linked, true);
  assert.equal(linked.messages, 5);
  assert.equal(parseDoctor(JSON.stringify({ data: { authenticated: true, session_revoked: true } })).linked, false);
  assert.equal(parseDoctor("no json"), null);
  assert.equal(qrFromEventLine('{"event":"qr_code","data":{"code":"abc"}}'), "abc");
  assert.equal(qrFromEventLine('{"event":"sync_progress","data":{}}'), null);
  assert.equal(qrFromEventLine("basura"), null);
});

test("busca Tailscale donde lo instala cada sistema", () => {
  assert.ok(tailscaleCandidates("darwin").includes("/Applications/Tailscale.app/Contents/MacOS/Tailscale"));
  assert.ok(tailscaleCandidates("linux").includes("/usr/bin/tailscale"));
  assert.deepEqual(tailscaleCandidates("win32"), ["C:\\Program Files\\Tailscale\\tailscale.exe"]);
});

test("en Linux abre SSH con la primera terminal instalada, sin pasar por un shell", () => {
  const exists = (path) => path === "/usr/bin/gnome-terminal" || path === "/usr/bin/xterm";
  assert.deepEqual(linuxSshCommand({ user: "ana", ip: "100.1.2.3" }, { path: "/usr/local/bin:/usr/bin", exists }), {
    command: "/usr/bin/gnome-terminal",
    args: ["--", "ssh", "ana@100.1.2.3"],
  });
  assert.deepEqual(linuxSshCommand({ user: "ana", ip: "100.1.2.3", identity: "~/.ssh/pc" }, { home: "/home/ana", path: "/usr/bin", exists: (p) => p === "/usr/bin/xterm" }).args, [
    "-e", "ssh", "-i", "/home/ana/.ssh/pc", "ana@100.1.2.3",
  ]);
  assert.equal(linuxSshCommand({ user: "ana", ip: "100.1.2.3" }, { path: "/usr/bin", exists: () => false }), null);
});

test("Claude Code: lo encuentra en ~/.local/bin aunque la app abra con el PATH mínimo", async () => {
  const calls = [];
  const runner = async (...args) => (calls.push(args), { code: 1, stdout: "" });
  const exists = (path) => path === "/Users/s/.local/bin/claude";
  const path = await findClaudeCli({ home: "/Users/s", exists, shell: "/bin/zsh", runner });
  assert.equal(path, "/Users/s/.local/bin/claude");
  assert.equal(calls.length, 0);
  assert.ok(claudeCliCandidates("/Users/s").includes("/opt/homebrew/bin/claude"));
});

test("Claude Code: si el login shell no lo ve, pregunta a un shell interactivo (lee .zshrc)", async () => {
  const calls = [];
  const runner = async (shell, args) => {
    calls.push(args[0]);
    return args[0] === "-ilc" ? { code: 0, stdout: "aviso del .zshrc\n/Users/s/custom/claude\n" } : { code: 1, stdout: "" };
  };
  const exists = (path) => path === "/Users/s/custom/claude";
  const path = await findClaudeCli({ home: "/Users/s", exists, shell: "/bin/zsh", runner });
  assert.equal(path, "/Users/s/custom/claude");
  assert.deepEqual(calls, ["-lc", "-ilc"]);
});

test("Claude Code: sin CLI en ningún lado da el error de siempre", async () => {
  const runner = async () => ({ code: 0, stdout: "claude: aliased to foo\n" });
  await assert.rejects(
    findClaudeCli({ home: "/Users/s", exists: () => false, shell: "/bin/zsh", runner }),
    /Claude Code was not found on this computer/,
  );
});
