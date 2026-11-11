import assert from "node:assert/strict";
import { test } from "node:test";
import { createVpnGuard } from "../app/core/vpn-guard.js";
import { parseIdleSeconds } from "../src/awake.js";

/** A pretend FortiClient (a macOS system VPN) and Tailscale, with a clock and an idle timer. */
function setup({ forti = true, kind = "macos", probe = null, connectWorks = true, idle = 600 } = {}) {
  const sim = { forti, tailscale: true, idle, connects: [], pings: [], notices: [], saved: [], off: {} };
  let clock = Date.UTC(2026, 10, 10, 22, 0);
  const vpn = {
    status: async () => ({
      tailscale: { installed: true, running: sim.tailscale },
      vpns: [{ id: "forticlient", name: "FortiClient", kind, connected: kind === "app" && !probe && !sim.forti ? false : sim.forti, probe }],
    }),
    connect: async (id) => {
      sim.connects.push(id);
      if (!connectWorks) throw new Error("FortiClient did not start.");
      if (id === "forticlient") sim.forti = true;
      if (id === "tailscale") sim.tailscale = true;
      return { connected: true };
    },
  };
  const guard = createVpnGuard({
    vpn,
    run: async (file, args) => {
      sim.pings.push(args.at(-1));
      return { code: 0, stdout: "", stderr: "" };
    },
    now: () => clock,
    idleSeconds: async () => sim.idle,
    turnedOff: () => sim.off,
    save: (ids) => sim.saved.push(ids),
    onNotice: (notice) => sim.notices.push(notice),
  });
  return { guard, sim, advance: (ms) => (clock += ms), now: () => clock };
}

test("reads how long the keyboard and trackpad have been idle", () => {
  assert.equal(parseIdleSeconds('    |   "HIDIdleTime" = 125000000000\n'), 125);
  assert.equal(parseIdleSeconds("nothing"), null);
});

test("brings FortiClient back when it drops with nobody at the computer, and logs that the screen was off", async () => {
  const { guard, sim, advance } = setup();
  await guard.check({ displaySleepMinutes: 1 });
  assert.deepEqual(sim.saved.at(-1), ["tailscale", "forticlient"]);
  sim.forti = false;
  advance(30_000);
  await guard.check({ displaySleepMinutes: 1 });
  assert.deepEqual(sim.connects, ["forticlient"]);
  assert.equal(sim.forti, true);
  const { events, watching } = guard.describe();
  assert.equal(events[1].event, "dropped");
  assert.equal(events[1].screenOff, true);
  assert.equal(events[0].event, "reconnected");
  assert.equal(watching.find((item) => item.id === "forticlient").down, false);
  assert.deepEqual(sim.notices, [{ vpn: "FortiClient", kind: "reconnected" }]);
});

test("never turns back on a VPN the person turned off in SMCP", async () => {
  const { guard, sim, advance, now } = setup();
  await guard.check();
  advance(10_000);
  sim.off = { forticlient: now() };
  sim.forti = false;
  advance(20_000);
  await guard.check();
  assert.deepEqual(sim.connects, []);
  assert.ok(!guard.describe().watching.some((item) => item.id === "forticlient"));
});

test("an old turn-off from before the VPN was seen on does not count", async () => {
  const { guard, sim, advance } = setup();
  sim.off = { forticlient: Date.UTC(2026, 10, 1) };
  await guard.check();
  sim.forti = false;
  advance(30_000);
  await guard.check();
  assert.deepEqual(sim.connects, ["forticlient"]);
});

test("a drop while someone uses the computer is their choice: not reconnected", async () => {
  const { guard, sim, advance } = setup({ idle: 5 });
  await guard.check();
  sim.forti = false;
  advance(30_000);
  await guard.check();
  assert.deepEqual(sim.connects, []);
  assert.equal(guard.describe().events[0].event, "dropped-while-in-use");
});

test("a VPN that will not come back is retried with growing pauses, and the person is told once", async () => {
  const { guard, sim, advance } = setup({ connectWorks: false });
  await guard.check();
  sim.forti = false;
  for (let i = 0; i < 20; i += 1) {
    advance(30_000);
    await guard.check();
  }
  // Ten minutes of checks every 30 seconds: tries at 0, +1, +2 and +5 minutes, not twenty.
  assert.equal(sim.connects.length, 4);
  assert.equal(sim.notices.filter((notice) => notice.kind === "failed").length, 1);
});

test("an app-only VPN is never popped up on screen; the person is told instead", async () => {
  const { guard, sim, advance } = setup({ kind: "app", probe: "intranet.senda.local" });
  await guard.check();
  sim.forti = false;
  advance(30_000);
  await guard.check();
  advance(30_000);
  await guard.check();
  assert.deepEqual(sim.connects, []);
  assert.deepEqual(sim.notices, [{ vpn: "FortiClient", kind: "needs-you" }]);
});

test("pings the probe name about once a minute so idle tunnels are not cut", async () => {
  const { guard, sim, advance } = setup({ probe: "intranet.senda.local" });
  for (let i = 0; i < 4; i += 1) {
    await guard.check();
    advance(30_000);
  }
  assert.deepEqual(sim.pings, ["intranet.senda.local", "intranet.senda.local"]);
});

test("Tailscale is watched and brought back too", async () => {
  const { guard, sim, advance } = setup();
  await guard.check();
  sim.tailscale = false;
  advance(30_000);
  await guard.check();
  assert.ok(sim.connects.includes("tailscale"));
});

test("reset forgets everything when the session ends", async () => {
  const { guard, sim } = setup();
  await guard.check();
  guard.reset();
  assert.deepEqual(guard.describe().watching, []);
  assert.deepEqual(sim.saved.at(-1), []);
});
