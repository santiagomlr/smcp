// The computers without WhatsApp ask the one that has it, and only for safe, read-only commands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newestMessage } from "../app/core/whatsapp.js";
import { peerInfo, whatsappHost } from "../app/core/peers.js";
import { createRelay, MEDIA_ELSEWHERE, relayableArgs, SEND_ELSEWHERE } from "../src/whatsapp-relay.js";
import { HelperUnavailable } from "../src/helper.js";

const doctor = (data) => async () => ({ code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" });
const LINKED = { authenticated: true, session_revoked: false };
const UNLINKED = { authenticated: false, session_revoked: false };

test("relay: only read-only commands SMCP uses may travel", () => {
  assert.deepEqual(relayableArgs(["--read-only", "--json", "chats", "list", "--limit=20"]), ["chats", "list", "--limit=20"]);
  assert.deepEqual(relayableArgs(["--read-only", "--json", "doctor"]), ["doctor"]);
  assert.deepEqual(relayableArgs(["contacts", "search", "--limit=5", "--", "--store=/tmp/x"]), ["contacts", "search", "--limit=5", "--", "--store=/tmp/x"]);
  assert.equal(relayableArgs(["--json", "send", "text", "--to=1", "--message=hi"]), null);
  assert.equal(relayableArgs(["--read-only", "--json", "media", "download", "--chat=a", "--id=b"]), null);
  assert.equal(relayableArgs(["chats", "archive", "--jid=x"]), null);
  assert.equal(relayableArgs(["chats", "list", "--store=/tmp/other"]), null);
  assert.equal(relayableArgs(["messages", "list", "--output=/tmp/x"]), null);
  assert.equal(relayableArgs(["messages", "list", "sync"]), null);
  assert.equal(relayableArgs("chats list"), null);
  assert.equal(relayableArgs([]), null);
});

test("relay: a linked computer answers itself", async () => {
  let asked = 0;
  const relay = createRelay({ localDoctor: doctor(LINKED), ask: async () => (asked++, {}) });
  assert.equal(await relay.run(["--read-only", "--json", "chats", "list"], 30_000), null);
  assert.equal(asked, 0);
});

test("relay: without a session here, reads go to the computer that has WhatsApp", async () => {
  const asks = [];
  const reply = { code: 0, stdout: '{"success":true,"data":[]}', stderr: "" };
  const relay = createRelay({ localDoctor: doctor(UNLINKED), ask: async (params) => (asks.push(params), reply) });
  assert.equal(await relay.run(["--read-only", "--json", "chats", "list", "--limit=5"], 30_000), reply);
  assert.deepEqual(asks, [{ args: ["--read-only", "--json", "chats", "list", "--limit=5"], timeoutMs: 30_000 }]);
  await relay.run(["--json", "sync", "--once", "--idle-exit=30s"], 240_000);
  assert.deepEqual(asks[1].args, ["sync"]);
});

test("relay: sending and files stay on the computer with WhatsApp", async () => {
  let asked = 0;
  const relay = createRelay({ localDoctor: doctor(UNLINKED), ask: async () => (asked++, {}) });
  const send = await relay.run(["--json", "send", "text", "--to=1", "--message=hi"], 60_000);
  assert.match(send.stderr, new RegExp(SEND_ELSEWHERE.slice(0, 30)));
  const media = await relay.run(["--read-only", "--json", "media", "download", "--chat=a", "--id=b", "--output=/tmp/a"], 60_000);
  assert.match(media.stderr, new RegExp(MEDIA_ELSEWHERE.slice(0, 30)));
  assert.equal(asked, 0);
});

test("relay: with SMCP.app unreachable, this computer answers itself as before", async () => {
  const relay = createRelay({ localDoctor: doctor(UNLINKED), ask: async () => { throw new HelperUnavailable("no socket"); } });
  assert.equal(await relay.run(["chats", "list"], 30_000), null);
});

test("relay: a host error comes back as a wacli failure", async () => {
  const relay = createRelay({ localDoctor: doctor(UNLINKED), ask: async () => { throw new Error("SMCP is paused on the computer with WhatsApp."); } });
  const result = await relay.run(["chats", "list"], 30_000);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error, /paused/);
});

test("relay: a doctor that cannot answer keeps this computer answering itself, and the check is cached", async () => {
  let checks = 0;
  const relay = createRelay({ localDoctor: async () => (checks++, { code: 1, stdout: "garbage", stderr: "" }), ask: async () => ({}) });
  assert.equal(await relay.run(["chats", "list"], 30_000), null);
  await relay.run(["chats", "list"], 30_000);
  assert.equal(checks, 1);
});

test("peers: the computer to ask is online, answering and linked, preferring live sync", () => {
  const machines = [
    { name: "m4", self: true, online: true, dns: "m4.ts.net" },
    { name: "old", online: true, dns: "old.ts.net" },
    { name: "m1", online: true, dns: "m1.ts.net" },
    { name: "off", online: false, dns: "off.ts.net" },
  ];
  const update = { status: "latest", latest: "1", canInstall: false };
  const peers = new Map([
    ["old", peerInfo({ version: "1", platform: "darwin", update, whatsapp: { linked: true, live: false } })],
    ["m1", peerInfo({ version: "1", platform: "darwin", update, whatsapp: { linked: true, live: true } })],
    ["off", peerInfo({ version: "1", platform: "darwin", update, whatsapp: { linked: true, live: true } })],
  ]);
  assert.equal(whatsappHost(machines, peers).name, "m1");
  assert.equal(whatsappHost(machines, new Map()), null);
});

test("status date: the newest chat message, skipping empty pinned chats", () => {
  const stdout = JSON.stringify({
    success: true,
    data: [
      { last_message_ts: "2026-11-05T13:00:25Z" },
      { last_message_ts: "0001-01-01T00:00:00Z" },
      { last_message_ts: "2026-11-13T06:11:22Z" },
      { last_message_ts: "2026-11-13T04:40:16Z" },
    ],
  });
  assert.equal(newestMessage(stdout), "2026-11-13T06:11:22.000Z");
  assert.equal(newestMessage("not json"), null);
});

test("send on a computer without WhatsApp: says where it lives and never opens the window", async () => {
  const { createWhatsApp } = await import("../src/tools/whatsapp.js");
  let asked = 0;
  const calls = [];
  const { send } = createWhatsApp({
    exec: async (file, args) => (calls.push(args), { code: 0, stdout: "{}", stderr: "" }),
    confirm: async () => (asked++, true),
    relay: { linkedHere: async () => false, run: async () => null },
  });
  const result = await send({ to: "5215550000000", message: "hola" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /another of your computers/);
  assert.equal(asked, 0);
  assert.equal(calls.length, 0);
});
