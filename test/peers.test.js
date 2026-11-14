import assert from "node:assert/strict";
import { test } from "node:test";
import { broadcastTargets, sendWake } from "../app/core/machines.js";
import { callPeer, createPeerHub, peerInfo } from "../app/core/peers.js";

test("Wake-on-LAN va al broadcast de cada red local, no solo a 255.255.255.255", () => {
  const interfaces = {
    lo0: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
    en0: [
      { family: "IPv4", address: "192.168.1.34", netmask: "255.255.255.0", internal: false },
      { family: "IPv6", address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", internal: false },
    ],
    en7: [{ family: 4, address: "10.0.5.9", netmask: "255.255.0.0", internal: false }],
    utun4: [{ family: "IPv4", address: "100.101.2.3", netmask: "255.255.255.255", internal: false }],
  };
  assert.deepEqual(broadcastTargets(interfaces), ["192.168.1.255", "10.0.255.255", "255.255.255.255"]);
  assert.deepEqual(broadcastTargets({}, "192.168.0.255"), ["192.168.0.255", "255.255.255.255"]);
  assert.deepEqual(broadcastTargets({}, "no; rm -rf"), ["255.255.255.255"]);
});

test("sendWake rechaza una MAC inválida antes de abrir el socket", async () => {
  await assert.rejects(sendWake({ mac: "zz" }, { interfaces: {} }), /MAC/);
});

test("entre computadoras: solo el dueño entra y solo las operaciones conocidas", async () => {
  let caller = "owner";
  const calls = [];
  const hub = createPeerHub({
    owner: "owner",
    port: 47879,
    identify: () => caller,
    handlers: {
      info: () => peerInfo({ version: "0.1.3", platform: "darwin", update: { status: "available", latest: "0.1.4", canInstall: true, message: "x", progress: 3 } }),
      update: async () => ({ status: "installing", version: "0.1.4" }),
      wake: async ({ mac }) => {
        calls.push(mac);
        return { sent: 6 };
      },
    },
  });
  await hub.start();
  try {
    assert.deepEqual(await callPeer("127.0.0.1", "info", {}, { port: 47879 }), {
      version: "0.1.3",
      platform: "darwin",
      update: { status: "available", latest: "0.1.4", canInstall: true },
      whatsapp: { linked: false, live: false },
      tools: false,
    });
    assert.deepEqual(await callPeer("127.0.0.1", "update", {}, { port: 47879 }), { status: "installing", version: "0.1.4" });
    await callPeer("127.0.0.1", "wake", { mac: "AA:BB:CC:DD:EE:FF" }, { port: 47879 });
    assert.deepEqual(calls, ["AA:BB:CC:DD:EE:FF"]);
    await assert.rejects(callPeer("127.0.0.1", "quit", {}, { port: 47879 }), /Unknown operation/);
    const bad = await fetch("http://127.0.0.1:47879/peer", { method: "POST", body: JSON.stringify({ op: "toString" }) });
    assert.equal(bad.status, 400);
    caller = "otro";
    await assert.rejects(callPeer("127.0.0.1", "info", {}, { port: 47879 }), /does not belong/);
    caller = null;
    await assert.rejects(callPeer("127.0.0.1", "update", {}, { port: 47879 }), /does not belong/);
  } finally {
    await hub.stop();
  }
  await assert.rejects(callPeer("127.0.0.1", "info", {}, { port: 47880, timeoutMs: 1_000 }), /Cannot reach SMCP/);
});
