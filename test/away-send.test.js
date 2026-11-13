// The whole path of a send asked from outside: the real WhatsApp tool, the helper socket that carries
// where the call came from, the approval page, and the send that follows the person's yes.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApprovalPage } from "../app/core/approval-page.js";
import { createApprovals } from "../app/core/approvals.js";
import { startHelper } from "../src/helper.js";
import { isAway } from "../src/origin.js";
import { AWAY_LIMITS, buildAwayServer, createAwayLimits } from "../src/remote-tools.js";
import { callToolInProcess } from "../src/tool-runner.js";

const skip = process.platform === "win32" ? "the stand-in for wacli is a shell script" : false;
const JID = "5215550000001@s.whatsapp.net";
let dir;
let helper;
let page;
let pageUrl;
let sentLog;
const approvals = createApprovals();
const windows = [];
const saved = {};

before(async () => {
  if (skip) return;
  dir = await mkdtemp(join(tmpdir(), "smcp-send-"));
  sentLog = join(dir, "sent.log");
  // A stand-in for wacli: linked, knows one chat, and writes down exactly what it is asked to send.
  const wacli = join(dir, "wacli");
  await writeFile(
    wacli,
    `#!/bin/sh
case "$*" in
  *doctor*) echo '{"success":true,"data":{"authenticated":true,"session_revoked":false}}' ;;
  *"chats show"*) echo '{"success":true,"data":{"name":"Ana Prueba"}}' ;;
  *"send text"*) for arg in "$@"; do printf '%s\\n' "$arg" >> "${sentLog}"; done; echo '{"success":true,"data":{"sent":true,"id":"MSG1"}}' ;;
  *) echo '{"success":true,"data":null}' ;;
esac
`,
  );
  await chmod(wacli, 0o755);
  const env = {
    SMCP_CONFIG: join(dir, "config.json"),
    SMCP_AUDIT: join(dir, "audit.jsonl"),
    SMCP_SOCKET: join(dir, "smcp.sock"),
    SMCP_SERVER_CONFIG: join(dir, "server.json"),
    WACLI_BIN: wacli,
    WACLI_STORE_DIR: join(dir, "store"),
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  await writeFile(env.SMCP_CONFIG, JSON.stringify({ whatsapp: { read: true, send: true }, remote: { send: true }, peers: { tools: true } }));
  // What the app does: a confirmation asked from outside goes to the approval page, any other to a window.
  helper = await startHelper({
    confirm: ({ body }) => {
      if (isAway()) return approvals.confirm({ title: "SMCP: send WhatsApp", action: "Send", body: String(body) });
      windows.push(body);
      return false;
    },
    approvalStatus: ({ id, waitSeconds }) => approvals.describeStatus(id, { waitSeconds, url: pageUrl }),
  });
  page = createApprovalPage({ approvals, owner: "ana@example.com", identify: () => "ana@example.com", port: 0 });
  pageUrl = `http://127.0.0.1:${await page.start()}/`;
});
after(async () => {
  if (skip) return;
  await page.stop();
  await new Promise((resolve) => helper.close(resolve));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

const state = () => createAwayLimits({ ...AWAY_LIMITS, approvalGraceMs: 300 });
const call = (source, name, args) =>
  callToolInProcess(buildAwayServer({ source, client: source === "remote" ? "Claude · abc12345" : "laptop", approvals, approvalUrl: () => pageUrl, state: state() }), name, args);
const json = (result) => JSON.parse(result.content[0].text);
const sentLines = async () => (await readFile(sentLog, "utf8").catch(() => "")).split("\n").filter(Boolean);

async function pressOnPage(id, answer) {
  const html = await (await fetch(pageUrl)).text();
  const nonce = html.match(new RegExp(`name="id" value="${id}"><input type="hidden" name="nonce" value="([^"]+)"`))[1];
  return fetch(`${pageUrl}decide`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: pageUrl.slice(0, -1) }, body: new URLSearchParams({ id, nonce, answer }) });
}

test("a WhatsApp message asked from the phone goes out only after the person approves it, with the exact text", { skip }, async () => {
  const message = "Feliz cumpleaños, mamá.\nTe llamo en la tarde.";
  const first = await call("remote", "whatsapp_send", { to: JID, message });
  const waiting = json(first);
  assert.equal(waiting.waiting_for_approval, true);
  assert.equal(waiting.approve_at, pageUrl);
  assert.deepEqual(await sentLines(), [], "nothing is sent while it waits");
  assert.deepEqual(windows, [], "no window opens on a computer nobody is at");

  // The page shows the recipient by name and the whole text.
  const html = await (await fetch(pageUrl)).text();
  assert.match(html, /To: Ana Prueba \(5215550000001@s\.whatsapp\.net\)/);
  assert.match(html, /Feliz cumpleaños, mamá\.\nTe llamo en la tarde\./);

  const pending = json(await call("remote", "approval_status", { id: waiting.approval_id }));
  assert.equal(pending.status, "pending");
  assert.equal(pending.approve_at, pageUrl);
  assert.ok(!JSON.stringify(pending).includes("cumpleaños"), "the status never repeats the text");

  assert.equal((await pressOnPage(waiting.approval_id, "approve")).status, 303);
  const done = json(await call("remote", "approval_status", { id: waiting.approval_id, wait_seconds: 5 }));
  assert.equal(done.status, "done");
  assert.match(done.result, /"sent": true/);
  // What went out is byte for byte what the page showed.
  const lines = (await readFile(sentLog, "utf8")).split("\n");
  assert.ok(lines.includes(`--to=${JID}`));
  assert.ok((await readFile(sentLog, "utf8")).includes(`--message=${message}\n`));
  assert.equal((await readFile(sentLog, "utf8")).split("--message=").length - 1, 1, "sent once");

  const audit = (await readFile(process.env.SMCP_AUDIT, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.tool === "whatsapp_send");
  assert.deepEqual(audit.map((entry) => entry.outcome), ["waiting", "ok"]);
});

test("rejecting on the page sends nothing, and the AI is told so", { skip }, async () => {
  const before = (await sentLines()).length;
  const waiting = json(await call("remote", "whatsapp_send", { to: JID, message: "No enviar" }));
  await pressOnPage(waiting.approval_id, "reject");
  const status = json(await call("remote", "approval_status", { id: waiting.approval_id, wait_seconds: 2 }));
  assert.equal(status.status, "rejected");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await sentLines()).length, before);
});

test("a send asked from another of the person's computers waits for the same approval", { skip }, async () => {
  const before = (await sentLines()).length;
  const waiting = json(await call("peer", "whatsapp_send", { to: JID, message: "Desde la laptop" }));
  assert.equal(waiting.waiting_for_approval, true);
  assert.equal(approvals.get(waiting.approval_id).source, "peer");
  assert.equal((await sentLines()).length, before);
  await pressOnPage(waiting.approval_id, "approve");
  assert.equal(json(await call("peer", "approval_status", { id: waiting.approval_id, wait_seconds: 5 })).status, "done");
  assert.ok((await readFile(sentLog, "utf8")).includes("--message=Desde la laptop\n"));
});

test("with sending turned off for remote access, nothing waits and nothing is sent", { skip }, async () => {
  await writeFile(process.env.SMCP_CONFIG, JSON.stringify({ whatsapp: { read: true, send: true } }));
  const before = (await sentLines()).length;
  const result = await call("remote", "whatsapp_send", { to: JID, message: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Sending messages and email from outside the computer is turned off/);
  assert.equal(approvals.pending().length, 0);
  assert.equal((await sentLines()).length, before);
});

test("an unknown approval id is an error, not a guess", { skip }, async () => {
  const result = await call("remote", "approval_status", { id: "does-not-exist" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No approval has that id/);
});
