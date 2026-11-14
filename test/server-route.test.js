// "Use the server": a tool asked for on one computer runs on the person's server computer, under the
// server's rules, and a server that does not answer is an error, never a silent run on this computer.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPeerHub } from "../app/core/peers.js";
import { readAudit } from "../src/audit.js";
import { buildInstructions, buildContext } from "../src/context.js";
import { callPeer } from "../src/peer-client.js";
import { guarded, readPolicy } from "../src/policy.js";
import { buildAwayServer, createAwayLimits, PEER_TOOLS_OFF } from "../src/remote-tools.js";
import {
  callServerTool,
  createRouter,
  describeRouting,
  NO_SERVER,
  readServerConfig,
  resolveTarget,
  routedArea,
  ROUTED_AREAS,
  writeServerConfig,
} from "../src/server-route.js";
import { callToolInProcess } from "../src/tool-runner.js";
import { allToolNames } from "../src/toolset.js";
import { registerFiles } from "../src/tools/files.js";
import { smcpStatus } from "../src/tools/status.js";
import { registerTerminal } from "../src/tools/terminal.js";

const PORT = 47871;
let dir;
let hub;
let caller = "ana@example.com";
const saved = {};
const paths = {};

/** The "server computer": a real peer hub that runs tools through the same server as the remote connector. */
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-route-"));
  paths.serverPolicy = join(dir, "server-config.json");
  paths.clientPolicy = join(dir, "client-config.json");
  paths.audit = join(dir, "audit.jsonl");
  paths.route = join(dir, "server.json");
  for (const [key, value] of Object.entries({ SMCP_AUDIT: paths.audit, SMCP_SOCKET: join(dir, "none.sock"), SMCP_SERVER_CONFIG: paths.route, WACLI_BIN: "/no/such/wacli" })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  saved.SMCP_CONFIG = process.env.SMCP_CONFIG;
  hub = createPeerHub({
    owner: "ana@example.com",
    port: PORT,
    identify: () => caller,
    handlers: {
      // The server reads its own settings, whatever the asking computer's say.
      tool: async ({ name, args, origin, from }) => {
        const before = process.env.SMCP_CONFIG;
        process.env.SMCP_CONFIG = paths.serverPolicy;
        try {
          return await callToolInProcess(buildAwayServer({ source: "peer", client: from, relayedRemote: origin === "remote", state: createAwayLimits() }), name, args);
        } finally {
          process.env.SMCP_CONFIG = before;
        }
      },
    },
  });
  await hub.start();
});
after(async () => {
  await hub.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

const viaTestPort = (config, name, args, options = {}) =>
  callServerTool(config, name, args, { ...options, call: (host, op, body, opts) => callPeer(host, op, body, { ...opts, port: options.port ?? PORT }) });
const SERVER = { host: "127.0.0.1", name: "studio", areas: Object.fromEntries(ROUTED_AREAS.map((area) => [area, false])) };
const text = (result) => result.content.map((item) => item.text ?? "").join("\n");

/** The "asking computer": the local tools behind the same guard and router the MCP server uses. */
function localTools({ config = () => SERVER, call = viaTestPort } = {}) {
  const tools = {};
  const schemas = {};
  const target = guarded(
    {
      registerTool(name, toolConfig, handler) {
        tools[name] = handler;
        schemas[name] = toolConfig.inputSchema;
      },
    },
    { router: createRouter({ read: config, call }) },
  );
  registerTerminal(target);
  registerFiles(target);
  return { tools, schemas };
}

test("only areas whose data belongs to one computer can be sent to the server", () => {
  assert.equal(routedArea("run_command"), "terminal");
  assert.equal(routedArea("file_read"), "files");
  assert.equal(routedArea("calendar_list_events"), "calendar");
  assert.equal(routedArea("daily_brief"), "brief");
  assert.equal(routedArea("whatsapp_send"), "whatsapp");
  // Tasks have their own shared list, WhatsApp reading already asks the computer where it is linked,
  // and the status tools report on both computers themselves.
  for (const name of ["tasks_create", "whatsapp_read_messages", "smcp_status", "smcp_context", "approval_status"]) assert.equal(routedArea(name), null, name);
  // Every tool resolves to an area or to "always here"; none throws.
  for (const name of allToolNames()) assert.doesNotThrow(() => routedArea(name));
});

test("an explicit machine wins over the setting, and asking for a server that is not set up is an error", () => {
  const onServer = { ...SERVER, areas: { ...SERVER.areas, terminal: true } };
  assert.deepEqual(resolveTarget("run_command", undefined, onServer), { target: "server" });
  assert.deepEqual(resolveTarget("run_command", "here", onServer), { target: null });
  assert.deepEqual(resolveTarget("file_read", undefined, onServer), { target: null });
  assert.deepEqual(resolveTarget("file_read", "server", onServer), { target: "server" });
  assert.deepEqual(resolveTarget("run_command", undefined, null), { target: null });
  assert.deepEqual(resolveTarget("run_command", "server", null), { error: NO_SERVER });
  // Keeping awake is about one computer, so it never follows a standing preference.
  assert.deepEqual(resolveTarget("awake_status", undefined, onServer), { target: null });
  assert.deepEqual(resolveTarget("awake_status", "server", onServer), { target: "server" });
  assert.deepEqual(resolveTarget("tasks_create", "server", onServer), { target: null });
});

test("the choice is saved privately, and a damaged or odd file means no server", async () => {
  const path = join(dir, "choice.json");
  assert.equal(readServerConfig(path), null);
  const written = writeServerConfig({ host: "studio.tail1234.ts.net", name: "Studio", areas: { terminal: true, files: "yes", nope: true } }, path);
  assert.deepEqual(written.areas.terminal, true);
  assert.equal(written.areas.files, false);
  assert.ok(!("nope" in written.areas));
  assert.deepEqual(readServerConfig(path), written);
  assert.throws(() => writeServerConfig({ host: "bad host; rm -rf" }, path), /not a valid computer name/);
  await writeFile(path, "{ not json");
  assert.equal(readServerConfig(path), null);
  await writeFile(path, JSON.stringify({ host: "http://evil/" }));
  assert.equal(readServerConfig(path), null);
  writeServerConfig(null, path);
  assert.equal(readServerConfig(path), null);
});

test("a tool asked for here runs on the server, under the server's switches", async () => {
  await writeFile(paths.clientPolicy, JSON.stringify({}));
  process.env.SMCP_CONFIG = paths.clientPolicy;
  const { tools, schemas } = localTools();
  assert.ok("machine" in schemas.run_command, "routable tools gain a machine argument");

  // The server does not let other computers in yet.
  await writeFile(paths.serverPolicy, JSON.stringify({ disabled: { terminal: false } }));
  const closed = await tools.run_command({ command: "echo hi", timeout_seconds: 5, machine: "server" }, {});
  assert.equal(closed.isError, true);
  assert.match(text(closed), new RegExp(PEER_TOOLS_OFF.slice(0, 40)));

  // The server lets them in, but its terminal is off: the asking computer cannot get around that.
  await writeFile(paths.serverPolicy, JSON.stringify({ peers: { tools: true } }));
  const off = await tools.run_command({ command: "echo hi", timeout_seconds: 5, machine: "server" }, {});
  assert.match(text(off), /terminal\) is turned off/);

  // With the server's own switch on, it runs there. The terminal is off on the asking computer, and that does not matter.
  await writeFile(paths.serverPolicy, JSON.stringify({ disabled: { terminal: false }, peers: { tools: true } }));
  assert.equal(readPolicy(paths.clientPolicy).disabled.terminal, true);
  await rm(paths.audit, { force: true });
  const ran = await tools.run_command({ command: "echo ran-on-$SMCP_TEST_SIDE", timeout_seconds: 5, machine: "server" }, {});
  assert.notEqual(ran.isError, true);
  assert.match(text(ran), /ran-on-/);

  const log = readAudit({ path: paths.audit });
  const onServer = log.find((entry) => entry.source === "peer");
  const here = log.find((entry) => entry.source === "local");
  assert.deepEqual({ tool: onServer.tool, client: onServer.client, outcome: onServer.outcome }, { tool: "run_command", client: hostname().slice(0, 80), outcome: "ok" });
  assert.match(onServer.detail, /echo ran-on-/);
  assert.deepEqual({ tool: here.tool, to: here.to, outcome: here.outcome }, { tool: "run_command", to: "server", outcome: "ok" });
  assert.equal(here.detail, undefined);
});

test("with the area set to the server, the tool goes there without being told, and `here` keeps it local", async () => {
  process.env.SMCP_CONFIG = paths.clientPolicy;
  await writeFile(paths.clientPolicy, JSON.stringify({}));
  await writeFile(paths.serverPolicy, JSON.stringify({ peers: { tools: true } }));
  const note = join(dir, "on-the-server.txt");
  await writeFile(note, "written on the server");
  const calls = [];
  const { tools } = localTools({
    config: () => ({ ...SERVER, areas: { ...SERVER.areas, files: true } }),
    call: (config, name, args, options) => {
      calls.push(name);
      return viaTestPort(config, name, args, options);
    },
  });
  const there = await tools.file_read({ path: note, offset: 0, max_bytes: 1000 }, {});
  assert.match(text(there), /written on the server/);
  assert.deepEqual(calls, ["file_read"]);
  const here = await tools.file_read({ path: note, offset: 0, max_bytes: 1000, machine: "here" }, {});
  assert.match(text(here), /written on the server/);
  assert.deepEqual(calls, ["file_read"], "`here` never reaches the server");
});

test("a server that does not answer is said plainly, and nothing runs here in its place", async () => {
  process.env.SMCP_CONFIG = paths.clientPolicy;
  await writeFile(paths.clientPolicy, JSON.stringify({ disabled: { terminal: false } }));
  const marker = join(dir, "ran-locally.txt");
  const { tools } = localTools({
    config: () => ({ ...SERVER, areas: { ...SERVER.areas, terminal: true } }),
    call: (config, name, args) => viaTestPort(config, name, args, { port: 47872 }),
  });
  const result = await tools.run_command({ command: `touch ${marker}`, timeout_seconds: 5 }, {});
  assert.equal(result.isError, true);
  assert.match(text(result), /"studio", your server computer, does not answer over Tailscale, so run_command did not run/);
  assert.match(text(result), /It was not run on this computer instead/);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("a pause or read-only mode on this computer still stops a tool bound for the server", async () => {
  process.env.SMCP_CONFIG = paths.clientPolicy;
  await writeFile(paths.serverPolicy, JSON.stringify({ disabled: { terminal: false }, peers: { tools: true } }));
  const { tools } = localTools();
  await writeFile(paths.clientPolicy, JSON.stringify({ paused: true }));
  assert.match(text(await tools.run_command({ command: "echo x", timeout_seconds: 5, machine: "server" }, {})), /paused/);
  await writeFile(paths.clientPolicy, JSON.stringify({ readOnly: true }));
  assert.match(text(await tools.run_command({ command: "echo x", timeout_seconds: 5, machine: "server" }, {})), /read-only/);
  assert.notEqual((await tools.file_list({ path: dir, limit: 5, machine: "server" }, {})).isError, true);
});

test("only the person's own computers are answered", async () => {
  await writeFile(paths.serverPolicy, JSON.stringify({ peers: { tools: true } }));
  caller = "someone@else.example";
  try {
    const result = await viaTestPort(SERVER, "file_list", { path: dir });
    assert.equal(result.isError, true);
    assert.match(text(result), /does not belong to your account/);
  } finally {
    caller = "ana@example.com";
  }
});

test("a call relayed from the asking computer's remote connector must pass the server's remote switches too", async () => {
  await writeFile(paths.serverPolicy, JSON.stringify({ disabled: { terminal: false }, peers: { tools: true } }));
  const relayed = await viaTestPort(SERVER, "run_command", { command: "echo x" }, { origin: { source: "remote" } });
  assert.match(text(relayed), /from outside it are turned off/);
});

test("status and context say which computer each area runs on", async () => {
  const config = { ...SERVER, areas: { ...SERVER.areas, terminal: true, files: true } };
  assert.deepEqual(describeRouting(config).areasOnServer, ["terminal", "files"]);
  assert.equal(describeRouting(null), null);

  const policy = readPolicy(join(dir, "missing.json"));
  const serverReport = { areas: { terminal: { ok: false, reason: "Turned off in SMCP settings." }, files: { ok: true } } };
  const status = await smcpStatus({ policy, probes: {}, server: config, serverStatus: async () => ({ status: serverReport }), exports: () => null });
  assert.deepEqual(status.server.areasOnServer, ["terminal", "files"]);
  assert.equal(status.server.reachable, true);
  // The server's own switch is what counts for an area that runs there.
  assert.deepEqual(status.areas.terminal, { ok: false, reason: "Turned off in SMCP settings.", runsOn: "studio" });
  assert.deepEqual(status.areas.files, { ok: true, runsOn: "studio" });
  assert.equal(status.areas.notes.runsOn, undefined);

  const down = await smcpStatus({ policy, probes: {}, server: config, serverStatus: async () => ({ error: "It does not answer over Tailscale." }), exports: () => null });
  assert.equal(down.server.reachable, false);
  assert.deepEqual(down.areas.files, { ok: false, reason: "It does not answer over Tailscale.", runsOn: "studio" });
  assert.ok(down.notWorking.includes("files"));

  await writeFile(paths.route, JSON.stringify(config));
  const context = buildContext({ policy, about: "" });
  assert.deepEqual(context.server.areasOnServer, ["terminal", "files"]);
  assert.match(buildInstructions({ context }), /Server computer: "studio"\. These areas run there, not here: terminal, files\./);
  await rm(paths.route, { force: true });
  assert.equal(buildContext({ policy, about: "" }).server, undefined);
});
