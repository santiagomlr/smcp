// What a client outside the computer may do: the switches, the limits, the activity log and the approvals.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createApprovals } from "../app/core/approvals.js";
import { readAudit } from "../src/audit.js";
import { buildContext, buildInstructions } from "../src/context.js";
import { currentOrigin, isAway, notConfirmed } from "../src/origin.js";
import { readPolicy } from "../src/policy.js";
import {
  AWAY_LIMITS,
  awayHandler,
  buildAwayServer,
  buildRemoteServer,
  capResult,
  createAwayLimits,
  LOCAL_ONLY,
  NOT_REMOTE,
  PEER_TOOLS_OFF,
  peerDenial,
  REMOTE_CONTROL,
  REMOTE_CONTROL_OFF,
  REMOTE_SENDS,
  REMOTE_SENDS_OFF,
  REMOTE_TASK_WRITES,
  REMOTE_TOOLS,
  REMOTE_WRITES,
  REMOTE_WRITES_OFF,
  remoteDenial,
  remoteGroup,
} from "../src/remote-tools.js";
import { callToolInProcess } from "../src/tool-runner.js";
import { allToolNames } from "../src/toolset.js";
import { smcpStatus } from "../src/tools/status.js";

let dir;
let config;
let audit;
const saved = {};

/** Its own settings and log, so the person's real ones neither decide nor record these calls. */
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-away-"));
  config = join(dir, "config.json");
  audit = join(dir, "audit.jsonl");
  for (const [key, value] of Object.entries({ SMCP_CONFIG: config, SMCP_AUDIT: audit, SMCP_SOCKET: join(dir, "none.sock"), SMCP_SERVER_CONFIG: join(dir, "server.json"), WACLI_BIN: "/no/such/wacli" })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(audit, { force: true });
});

const setPolicy = (policy) => writeFile(config, JSON.stringify(policy));
const terminalOn = { disabled: { terminal: false } };
const text = (result) => result.content.map((item) => item.text ?? "").join("\n");
const remote = (name, args, options = {}) => callToolInProcess(buildRemoteServer({ client: "Claude · abc12345", state: createAwayLimits(), ...options }), name, args);

test("every tool has a rule for calls from outside, so a new one cannot slip through", () => {
  const unclassified = allToolNames().filter((name) => remoteGroup(name) === null);
  assert.deepEqual(unclassified, []);
  // No tool sits in two groups, which would make its switch ambiguous.
  const groups = [REMOTE_TOOLS, REMOTE_TASK_WRITES, REMOTE_WRITES, REMOTE_CONTROL, REMOTE_SENDS, new Set(Object.keys(LOCAL_ONLY))];
  for (const name of allToolNames()) assert.equal(groups.filter((group) => group.has(name)).length, 1, name);
  // And nothing is classified that does not exist, which would hide a renamed tool.
  const known = new Set(allToolNames());
  for (const group of groups) for (const name of group) assert.ok(known.has(name), `${name} is classified but is not a tool`);
});

test("what is open by default from outside is only reading", () => {
  for (const name of ["run_command", "ui_click", "screenshot", "clipboard_read", "file_write", "notes_write", "whatsapp_send", "gmail_send", "gmail_reply", "calendar_create_event", "calendar_delete_event", "reminders_delete"]) {
    assert.ok(!REMOTE_TOOLS.has(name), name);
    assert.ok(remoteDenial(name, readPolicy(join(dir, "missing.json"))), name);
  }
  assert.equal(remoteDenial("gmail_read", readPolicy(join(dir, "missing.json"))), null);
});

test("each remote switch opens its own group and nothing else", () => {
  const base = readPolicy(join(dir, "missing.json"));
  const withSwitch = (name) => ({ ...base, remote: { ...base.remote, [name]: true } });
  assert.equal(remoteDenial("run_command", base), REMOTE_CONTROL_OFF);
  assert.equal(remoteDenial("notes_write", base), REMOTE_WRITES_OFF);
  // Writing any file is as strong as running commands (a shell profile, a launch agent), so it needs the same switch.
  assert.equal(remoteDenial("file_write", base), REMOTE_CONTROL_OFF);
  assert.equal(remoteDenial("file_write", withSwitch("write")), REMOTE_CONTROL_OFF);
  assert.equal(remoteDenial("file_write", withSwitch("control")), null);
  assert.equal(remoteDenial("whatsapp_send", base), REMOTE_SENDS_OFF);
  assert.equal(remoteDenial("run_command", withSwitch("control")), null);
  assert.equal(remoteDenial("notes_write", withSwitch("control")), REMOTE_WRITES_OFF);
  assert.equal(remoteDenial("whatsapp_send", withSwitch("control")), REMOTE_SENDS_OFF);
  assert.equal(remoteDenial("notes_write", withSwitch("write")), null);
  assert.equal(remoteDenial("calendar_delete_event", withSwitch("write")), null);
  assert.equal(remoteDenial("run_command", withSwitch("write")), REMOTE_CONTROL_OFF);
  assert.equal(remoteDenial("gmail_send", withSwitch("send")), null);
  assert.equal(remoteDenial("tasks_create", withSwitch("taskWrites")), null);
  assert.match(remoteDenial("tasks_create", base), /Editing tasks/);
  // Some things never travel, whatever the switches say.
  const everything = { ...base, remote: { taskWrites: true, write: true, control: true, send: true } };
  for (const name of Object.keys(LOCAL_ONLY)) assert.match(remoteDenial(name, everything), /only works at the computer itself/);
  assert.equal(remoteDenial("a_tool_from_the_future", everything), NOT_REMOTE);
});

test("a saved setting that is not exactly true stays off", async () => {
  await setPolicy({ remote: { control: "yes", write: 1, send: "true", taskWrites: null }, peers: { tools: "on" }, calendar: { autoWrite: "all" } });
  const policy = readPolicy(config);
  assert.deepEqual(policy.remote, { taskWrites: false, write: false, control: false, send: false });
  assert.deepEqual(policy.peers, { tools: false });
  assert.deepEqual(policy.calendar, { autoWrite: [] });
});

test("the terminal from outside: refused with a clear reason while its switch is off", async () => {
  await setPolicy(terminalOn);
  const result = await remote("run_command", { command: "echo should-not-run" });
  assert.equal(result.isError, true);
  assert.equal(text(result), REMOTE_CONTROL_OFF);
  assert.match(text(result), /Settings > Remote access/);
  const [entry] = readAudit({ path: audit });
  assert.deepEqual({ tool: entry.tool, source: entry.source, outcome: entry.outcome, client: entry.client }, { tool: "run_command", source: "remote", outcome: "denied", client: "Claude · abc12345" });
});

test("the terminal from outside: with the switch on it runs, and the log keeps who and the whole command", async () => {
  await setPolicy({ ...terminalOn, remote: { control: true } });
  const result = await remote("run_command", { command: "echo from-afar" });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /from-afar/);
  const [entry] = readAudit({ path: audit });
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.source, "remote");
  assert.equal(entry.client, "Claude · abc12345");
  assert.equal(entry.detail, "echo from-afar");
  // Only what came from outside is listed in the "from outside" view.
  assert.equal(readAudit({ path: audit, away: true }).length, 1);
});

test("the remote switch does not override the computer's own switch for that area", async () => {
  await setPolicy({ remote: { control: true } });
  const result = await remote("run_command", { command: "echo no" });
  assert.equal(result.isError, true);
  assert.match(text(result), /terminal\) is turned off/);
});

test("a local call never leaves its command in the log", async () => {
  const { guarded } = await import("../src/policy.js");
  const { registerTerminal } = await import("../src/tools/terminal.js");
  await setPolicy(terminalOn);
  const handlers = {};
  registerTerminal(guarded({ registerTool: (name, _config, handler) => (handlers[name] = handler) }));
  await handlers.run_command({ command: "echo local-secret", timeout_seconds: 5 });
  const log = await readFile(audit, "utf8");
  assert.ok(!log.includes("local-secret"));
});

test("a command from outside cannot run longer than the remote limit", async () => {
  await setPolicy({ ...terminalOn, remote: { control: true } });
  const limits = createAwayLimits({ ...AWAY_LIMITS, commandSeconds: 1 });
  const started = Date.now();
  const result = await remote("run_command", { command: "sleep 30", timeout_seconds: 600 }, { state: limits });
  assert.ok(Date.now() - started < 10_000);
  assert.match(text(result), /"timed_out": true/);
});

test("too many calls in a minute are refused with a wait, and other apps are not affected", async () => {
  await setPolicy({});
  const state = createAwayLimits({ ...AWAY_LIMITS, perMinute: 3 });
  for (let i = 0; i < 3; i++) assert.notEqual((await remote("smcp_ping", {}, { state })).isError, true);
  const blocked = await remote("smcp_ping", {}, { state });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /Too many calls.*Wait \d+ seconds/);
  assert.notEqual((await remote("smcp_ping", {}, { state, client: "Another app" })).isError, true);
  assert.equal(readAudit({ path: audit })[1].outcome, "denied");
});

test("the terminal has a tighter limit of its own", async () => {
  await setPolicy({ ...terminalOn, remote: { control: true } });
  const state = createAwayLimits({ ...AWAY_LIMITS, controlPerMinute: 1 });
  assert.notEqual((await remote("run_command", { command: "true" }, { state })).isError, true);
  assert.match(text(await remote("run_command", { command: "true" }, { state })), /Too many terminal and screen calls/);
});

test("only a couple of heavy tools run at the same time", async () => {
  await setPolicy({ ...terminalOn, remote: { control: true } });
  const state = createAwayLimits({ ...AWAY_LIMITS, heavyAtOnce: 1 });
  const slow = remote("run_command", { command: "sleep 1" }, { state });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await remote("run_command", { command: "echo second" }, { state });
  assert.match(text(second), /already running/);
  await slow;
  assert.match(text(await remote("run_command", { command: "echo third" }, { state })), /third/);
});

test("a write from outside is refused when it is too large", async () => {
  await setPolicy({ remote: { control: true } });
  const state = createAwayLimits({ ...AWAY_LIMITS, writeChars: 100 });
  const target = join(dir, "big.txt");
  const result = await remote("file_write", { path: target, content: "x".repeat(101) }, { state });
  assert.match(text(result), /Nothing was written/);
  await assert.rejects(readFile(target));
  assert.notEqual((await remote("file_write", { path: target, content: "small" }, { state })).isError, true);
  assert.equal(await readFile(target, "utf8"), "small");
});

test("a result too large to send is shortened and says so", () => {
  const big = { content: [{ type: "text", text: "a".repeat(500) }, { type: "text", text: "b".repeat(500) }] };
  const capped = capResult(big, 600);
  assert.equal(capped.content[0].text.length, 500);
  assert.equal(capped.content[1].text.length, 100);
  assert.match(capped.content.at(-1).text, /shortened this result.*not complete/);
  assert.equal(capResult(big, 1000), big);
  const image = capResult({ content: [{ type: "image", data: "x".repeat(50), mimeType: "image/png" }] }, 10);
  assert.match(image.content[0].text, /left out/);
});

test("a tool that outlasts its time answers that it is still running, not with silence", async () => {
  const state = createAwayLimits({ ...AWAY_LIMITS, callMs: 300 });
  let finished = false;
  const handler = awayHandler("gmail_search", { inputSchema: {} }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    finished = true;
    return { content: [{ type: "text", text: "late" }] };
  }, { source: "remote", client: "Claude", state, record: () => {} });
  const result = await handler({}, {});
  assert.equal(result.isError, true);
  assert.equal(finished, false);
  assert.match(text(result), /gmail_search has been running for more than/);
  assert.match(text(result), /do not assume it finished or report anything as read or done/);
});

test("a send from outside waits for the person and goes out exactly once, after they approve", async () => {
  const approvals = createApprovals();
  const state = createAwayLimits({ ...AWAY_LIMITS, approvalGraceMs: 50 });
  const sent = [];
  // A stand-in for a send tool: it asks for confirmation the way the real ones do, then sends its own arguments.
  const handler = awayHandler("whatsapp_send", { inputSchema: {} }, async ({ to, message }) => {
    assert.equal(isAway(), true);
    assert.equal(currentOrigin().source, "remote");
    const approved = await approvals.confirm({ title: "Send WhatsApp", action: "Send", body: `To: ${to}\n\nMessage:\n${message}` });
    if (!approved) return { content: [{ type: "text", text: JSON.stringify({ sent: false, reason: notConfirmed() }) }] };
    sent.push({ to, message });
    return { content: [{ type: "text", text: JSON.stringify({ sent: true }) }] };
  }, { source: "remote", client: "Claude", approvals, approvalUrl: () => "https://server.example:47826/", state, record: () => {} });

  const first = await handler({ to: "5215550000001@s.whatsapp.net", message: "Happy birthday" }, {});
  const waiting = JSON.parse(text(first));
  assert.equal(waiting.waiting_for_approval, true);
  assert.equal(waiting.done, false);
  assert.equal(waiting.approve_at, "https://server.example:47826/");
  assert.equal(first._meta["smcp/waiting"], true);
  assert.deepEqual(sent, []);

  const [pending] = approvals.pending();
  assert.equal(pending.id, waiting.approval_id);
  assert.match(pending.body, /Happy birthday/);
  assert.equal(pending.source, "remote");

  approvals.decide(pending.id, true);
  await approvals.whenFinished(pending.id, 2_000);
  // What went out is what the page showed, once.
  assert.deepEqual(sent, [{ to: "5215550000001@s.whatsapp.net", message: "Happy birthday" }]);
  assert.equal(approvals.get(pending.id).status, "done");
  assert.equal(approvals.decide(pending.id, true), false);
  assert.equal(sent.length, 1);
});

test("a rejected or expired approval sends nothing", async () => {
  const approvals = createApprovals({ ttlMs: 700 });
  const state = createAwayLimits({ ...AWAY_LIMITS, approvalGraceMs: 20 });
  const sent = [];
  const handler = awayHandler("gmail_send", { inputSchema: {} }, async ({ body }) => {
    if (!(await approvals.confirm({ title: "Send email", body }))) return { content: [{ type: "text", text: notConfirmed() }] };
    sent.push(body);
    return { content: [{ type: "text", text: "sent" }] };
  }, { source: "remote", client: "Claude", approvals, state, record: () => {} });

  await handler({ body: "one" }, {});
  const [first] = approvals.pending();
  approvals.decide(first.id, false);
  assert.equal(approvals.get(first.id).status, "rejected");

  await handler({ body: "two" }, {});
  const [second] = approvals.pending();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(approvals.get(second.id).status, "expired");
  assert.equal(approvals.decide(second.id, true), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sent, []);
});

test("an approval answered quickly returns the real result in the same call", async () => {
  const approvals = createApprovals();
  const state = createAwayLimits({ ...AWAY_LIMITS, approvalGraceMs: 2_000 });
  const handler = awayHandler("gmail_send", { inputSchema: {} }, async () => {
    const ok = await approvals.confirm({ title: "Send email", body: "hello" });
    return { content: [{ type: "text", text: ok ? "sent" : "not sent" }] };
  }, { source: "remote", client: "Claude", approvals, state, record: () => {} });
  setTimeout(() => approvals.decide(approvals.pending()[0].id, true), 100);
  assert.equal(text(await handler({}, {})), "sent");
});

test("the wording for a missing yes depends on where the person was asked", () => {
  assert.match(notConfirmed(), /macOS window/);
});

test("other computers of the person: nothing runs until this one lets them, and then its own switches decide", async () => {
  const base = readPolicy(join(dir, "missing.json"));
  assert.equal(peerDenial("file_read", base), PEER_TOOLS_OFF);
  const open = { ...base, peers: { tools: true } };
  assert.equal(peerDenial("file_read", open), null);
  assert.equal(peerDenial("run_command", open), null);
  // A call the other computer relays from its own remote connector must also pass this computer's remote switches.
  assert.equal(peerDenial("run_command", open, { relayedRemote: true }), REMOTE_CONTROL_OFF);
  assert.match(peerDenial("awake_stop", open), /only works at the computer itself/);

  await setPolicy({ peers: { tools: true } });
  const peer = (name, args) => callToolInProcess(buildAwayServer({ source: "peer", client: "laptop", state: createAwayLimits() }), name, args);
  // The server's terminal switch is off, so the other computer cannot get around it.
  const denied = await peer("run_command", { command: "echo no" });
  assert.match(text(denied), /terminal\) is turned off/);
  await setPolicy({ ...terminalOn, peers: { tools: true } });
  assert.match(text(await peer("run_command", { command: "echo on-the-server" })), /on-the-server/);
  const [entry] = readAudit({ path: audit });
  assert.deepEqual({ source: entry.source, client: entry.client, detail: entry.detail }, { source: "peer", client: "laptop", detail: "echo on-the-server" });
  await setPolicy(terminalOn);
  assert.equal(text(await peer("run_command", { command: "echo no" })), PEER_TOOLS_OFF);
});

test("clients are told what is on and off from outside, and to admit when SMCP cannot be reached", async () => {
  const policy = { ...readPolicy(join(dir, "missing.json")), remote: { taskWrites: false, write: true, control: false, send: false } };
  const context = buildContext({ remote: true, policy, about: "" });
  assert.deepEqual(context.remoteAccess.on, ["writing notes, calendar events and reminders"]);
  assert.ok(context.remoteAccess.off.includes("the terminal, writing files and control of the computer"));
  const instructions = buildInstructions({ remote: true, context });
  assert.match(instructions, /Allowed from outside the computer: writing notes/);
  assert.match(instructions, /Turned off from outside the computer: .*sending messages and email/);
  for (const text of [instructions, buildInstructions()]) {
    assert.match(text, /could not connect or could not read it/);
    assert.match(text, /Never present something as read, checked, sent or done when the tool did not return it/);
    assert.match(text, /waiting_for_approval/);
  }
});

test("the status report says which remote permissions are on and why the terminal is not available", async () => {
  const policy = { ...readPolicy(join(dir, "missing.json")) };
  policy.disabled = { ...policy.disabled, terminal: false };
  const off = await smcpStatus({ remote: true, policy, probes: {}, server: null, exports: () => null });
  assert.equal(off.areas.terminal.ok, false);
  assert.match(off.areas.terminal.reason, /Settings > Remote access/);
  assert.deepEqual(off.remoteAccess, { tasks: false, write: false, control: false, send: false });
  const on = await smcpStatus({ remote: true, policy: { ...policy, remote: { ...policy.remote, control: true } }, probes: {}, server: null, exports: () => null });
  assert.equal(on.areas.terminal.ok, true);
  assert.equal(on.areas.nightlight.ok, false);
});

test("the lightest health tool answers with nothing personal", async () => {
  await setPolicy({ paused: true });
  const result = await remote("smcp_ping", {});
  const body = JSON.parse(text(result));
  assert.deepEqual(Object.keys(body).sort(), ["at", "ok", "version", "via"]);
  assert.equal(body.via, "remote connector");
});
