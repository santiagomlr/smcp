import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { denialFor, readPolicy, toolGroup } from "../src/policy.js";
import { REMOTE_TOOLS } from "../src/remote-tools.js";
import { registerVpn } from "../src/tools/vpn.js";
import { createVpn, normalizeEntry, parseScutilList, parseTailscalePrefs, parseTailscaleStatus, readVpnConfig } from "../src/vpn.js";

const TS = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-vpn-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SCUTIL = `Available network connection services in the current set (*=enabled):
* (Disconnected)   1A2B3C4D-0000-0000-0000-000000000001 VPN (com.fortinet.forticlient.macos.vpn) "FortiClient"        [VPN:com.fortinet.forticlient.macos.vpn]
* (Connected)      1A2B3C4D-0000-0000-0000-000000000002 VPN (io.tailscale.ipn.macsys) "Tailscale"           [VPN:io.tailscale.ipn.macsys]
`;

/**
 * A pretend computer: Tailscale on with its DNS, FortiClient as a system VPN. Each command changes
 * the pretend state the way the real one would.
 */
function fakeComputer({ forti = "Disconnected", tsRunning = true, acceptDns = true, exitNode = false, resolves = () => forti === "Connected", files = [TS] } = {}) {
  const calls = [];
  const sim = { forti, tsRunning, acceptDns };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === TS) {
      if (args[0] === "status") {
        return ok(JSON.stringify({ BackendState: sim.tsRunning ? "Running" : "Stopped", CurrentTailnet: { Name: "me@example.com", MagicDNSEnabled: true }, ExitNodeStatus: exitNode ? { ID: "n1" } : null }));
      }
      if (args[0] === "debug") return ok(JSON.stringify({ CorpDNS: sim.acceptDns }));
      if (args[0] === "set") sim.acceptDns = args[1] === "--accept-dns=true";
      if (args[0] === "up") sim.tsRunning = true;
      if (args[0] === "down") sim.tsRunning = false;
      return ok();
    }
    if (file === "/usr/sbin/scutil") {
      if (args[1] === "list") return ok(SCUTIL.replace("(Disconnected)", `(${sim.forti})`));
      if (args[1] === "start") sim.forti = "Connected";
      if (args[1] === "stop") sim.forti = "Disconnected";
      return ok();
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  const vpn = createVpn({
    run,
    exists: (path) => files.includes(path),
    platform: "darwin",
    configPath: join(dir, Math.random().toString(36).slice(2), "vpn.json"),
    lookup: async () => {
      if (!resolves(sim)) throw new Error("ENOTFOUND");
      return { address: "10.0.0.1" };
    },
    sleep: async () => {},
    connectWaitMs: 0,
  });
  return { vpn, calls, sim };
}

test("lee la lista de VPN de macOS y el estado de Tailscale", () => {
  const services = parseScutilList(SCUTIL);
  assert.deepEqual(services.map((s) => [s.name, s.status]), [
    ["FortiClient", "Disconnected"],
    ["Tailscale", "Connected"],
  ]);
  assert.deepEqual(parseTailscaleStatus({ BackendState: "Running", ExitNodeStatus: { ID: "x" }, CurrentTailnet: { Name: "t" } }), {
    running: true,
    state: "Running",
    tailnet: "t",
    usingExitNode: true,
    magicDns: false,
  });
  assert.equal(parseTailscalePrefs('{"CorpDNS":false}').acceptDns, false);
  assert.equal(parseTailscalePrefs("no json").acceptDns, null);
});

test("el archivo de VPN solo acepta entradas completas y nunca reemplaza a Tailscale", async () => {
  assert.equal(normalizeEntry({ kind: "command", name: "x", connect: "rm -rf /" }), null, "un comando tiene que ser una lista de argumentos");
  assert.equal(normalizeEntry({ kind: "macos", id: "tailscale", service: "x" }), null);
  assert.equal(normalizeEntry({ kind: "shell", name: "x" }), null);
  assert.deepEqual(normalizeEntry({ kind: "app", name: "Senda", app: "FortiClient", probe: "srvtrisoajdep" }), {
    id: "senda",
    name: "Senda",
    kind: "app",
    probe: "srvtrisoajdep",
    app: "FortiClient",
  });
  const path = join(dir, "config.json");
  await writeFile(path, "{ dañado");
  assert.deepEqual(readVpnConfig(path), { vpns: [], keepBothWorking: true, discover: true });
});

test("encuentra FortiClient en Ajustes del sistema y no duplica a Tailscale", async () => {
  const { vpn } = fakeComputer();
  const status = await vpn.status();
  assert.deepEqual(status.vpns.map((v) => v.id), ["forticlient"]);
  assert.equal(status.tailscale.running, true);
  assert.equal(status.tailscale.acceptDns, true);
  assert.deepEqual(status.conflicts, []);
});

test("prender la VPN del trabajo deja Tailscale encendido y solo le apaga el DNS; apagarla se lo regresa", async () => {
  const { vpn, calls, sim } = fakeComputer();
  const result = await vpn.connect("FortiClient");
  assert.equal(result.connected, true);
  assert.equal(sim.tsRunning, true, "Tailscale sigue conectado");
  assert.equal(sim.acceptDns, false);
  assert.ok(calls.indexOf(`${TS} set --accept-dns=false`) < calls.indexOf('/usr/sbin/scutil --nc start FortiClient'), "el DNS se aparta antes de conectar");
  assert.deepEqual((await vpn.status()).conflicts, []);

  const off = await vpn.disconnect("forticlient");
  assert.equal(off.connected, false);
  assert.equal(sim.acceptDns, true);
  assert.match(off.notes.join(" "), /DNS is back/);
});

test("si el DNS de Tailscale ya estaba apagado por la persona, SMCP no lo prende al terminar", async () => {
  const { vpn, sim } = fakeComputer({ acceptDns: false });
  await vpn.connect("forticlient");
  await vpn.disconnect("forticlient");
  assert.equal(sim.acceptDns, false);
});

test("con las dos VPN encendidas y el DNS de Tailscale activo, el estado avisa del choque", async () => {
  const { vpn } = fakeComputer({ forti: "Connected", exitNode: true });
  const { conflicts } = await vpn.status();
  assert.equal(conflicts.length, 2);
  assert.match(conflicts[0], /internal names/);
  assert.match(conflicts[1], /exit node/);
});

test("prender Tailscale con la VPN del trabajo arriba no le quita sus nombres", async () => {
  const { vpn, sim } = fakeComputer({ forti: "Connected", tsRunning: false });
  const result = await vpn.connect("tailscale");
  assert.equal(result.connected, true);
  assert.equal(sim.tsRunning, true);
  assert.equal(sim.acceptDns, false);
});

test("apagar Tailscale avisa que se corta el URL privado", async () => {
  const { vpn, sim } = fakeComputer();
  const result = await vpn.disconnect("tailscale");
  assert.equal(sim.tsRunning, false);
  assert.match(result.notes[0], /private SMCP URL/);
});

test("una VPN que no existe dice cuáles hay", async () => {
  const { vpn } = fakeComputer();
  await assert.rejects(vpn.connect("senda"), /Available: tailscale, forticlient/);
});

test("una VPN que solo es app se abre y pide a la persona conectar", async () => {
  const { vpn, calls } = fakeComputer({ files: [TS, "/Applications/FortiClient.app"] });
  const config = join(dir, "app.json");
  await writeFile(config, JSON.stringify({ discover: false, vpns: [{ kind: "app", name: "Senda", app: "FortiClient" }] }));
  const appOnly = createVpn({
    run: async (file, args) => {
      calls.push([file, ...args].join(" "));
      if (file === TS && args[0] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: "Running" }) };
      return { code: 0, stdout: file === TS ? '{"CorpDNS":true}' : "" };
    },
    exists: () => true,
    platform: "darwin",
    configPath: config,
    lookup: async () => {
      throw new Error("ENOTFOUND");
    },
    sleep: async () => {},
    connectWaitMs: 0,
  });
  const result = await appOnly.connect("senda");
  assert.equal(result.needsYou, true);
  assert.ok(calls.includes("/usr/bin/open -a FortiClient"));
  await assert.rejects(appOnly.disconnect("senda"), /its own app/);
  void vpn;
});

test("si la VPN falla al conectar, Tailscale recupera su DNS", async () => {
  const { sim } = fakeComputer();
  const config = join(dir, "fail.json");
  await writeFile(config, JSON.stringify({ discover: false, vpns: [{ kind: "command", name: "Work", connect: ["/bin/false"], disconnect: ["/bin/true"] }] }));
  let acceptDns = true;
  const vpn = createVpn({
    run: async (file, args) => {
      if (file === TS && args[0] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: "Running" }) };
      if (file === TS && args[0] === "debug") return { code: 0, stdout: JSON.stringify({ CorpDNS: acceptDns }) };
      if (file === TS && args[0] === "set") acceptDns = args[1] === "--accept-dns=true";
      if (file === "/bin/false") return { code: 1, stdout: "", stderr: "login failed" };
      return { code: 0, stdout: "" };
    },
    exists: (path) => path === TS,
    platform: "darwin",
    configPath: config,
    lookup: async () => {
      throw new Error("ENOTFOUND");
    },
    sleep: async () => {},
    connectWaitMs: 0,
  });
  await assert.rejects(vpn.connect("work"), /login failed/);
  assert.equal(acceptDns, true);
  assert.equal(JSON.parse(await readFile(join(dir, "vpn-state.json"), "utf8")).tailscaleDnsOffBySmcp, false);
  void sim;
});

test("el área VPN tiene su permiso, funciona en solo lectura y desde el teléfono solo se consulta", () => {
  assert.equal(toolGroup("vpn_connect"), "vpn");
  assert.equal(readPolicy(join(dir, "none.json")).disabled.vpn, false);
  const readOnly = { ...readPolicy(join(dir, "none.json")), readOnly: true };
  assert.equal(denialFor("vpn_connect", { readOnlyHint: false, destructiveHint: false }, readOnly), null);
  const off = readPolicy(join(dir, "none.json"));
  off.disabled.vpn = true;
  assert.match(denialFor("vpn_status", { readOnlyHint: true }, off), /vpn/);
  assert.equal(REMOTE_TOOLS.has("vpn_status"), true);
  assert.equal(REMOTE_TOOLS.has("vpn_connect"), false);
  assert.equal(REMOTE_TOOLS.has("vpn_disconnect"), false);
});

test("las herramientas pasan el nombre tal cual y devuelven el error como texto", async () => {
  const handlers = {};
  const seen = [];
  registerVpn(
    { registerTool: (name, _config, handler) => (handlers[name] = handler) },
    {
      vpn: {
        status: async () => ({ ok: 1 }),
        connect: async (name) => (seen.push(["connect", name]), { connected: true }),
        disconnect: async () => {
          throw new Error("nope");
        },
        fixDns: async (enabled) => (seen.push(["dns", enabled]), {}),
      },
    },
  );
  await handlers.vpn_connect({ vpn: "senda" });
  await handlers.vpn_tailscale_dns({ enabled: false });
  assert.deepEqual(seen, [
    ["connect", "senda"],
    ["dns", false],
  ]);
  const failed = await handlers.vpn_disconnect({ vpn: "x" });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, "nope");
});
