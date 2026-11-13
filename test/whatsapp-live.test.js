// The live sync keeps `wacli sync --follow` running; these tests use a fake process and fake timers.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createLiveSync } from "../app/core/whatsapp.js";
import { isLiveSyncRunning } from "../src/tools/whatsapp.js";

function harness() {
  const spawned = [];
  const timers = [];
  let clock = 0;
  const spawnFn = (bin, args) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.args = args;
    proc.signals = [];
    proc.kill = (signal) => {
      proc.signals.push(signal);
      queueMicrotask(() => proc.emit("close", null, signal));
    };
    spawned.push(proc);
    return proc;
  };
  const live = createLiveSync({
    spawnFn,
    bin: () => "/fake/wacli",
    store: () => "/fake/store",
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    now: () => clock,
    log: () => {},
  });
  const pending = () => timers.filter((timer) => !timer.cleared && !timer.fired);
  const fire = () => {
    const [timer] = pending();
    timer.fired = true;
    timer.fn();
    return timer.ms;
  };
  return { live, spawned, pending, fire, advance: (ms) => (clock += ms) };
}

test("live sync: starts wacli sync --follow once, even if asked again", () => {
  const { live, spawned } = harness();
  live.start();
  live.start();
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ["--store=/fake/store", "sync", "--follow", "--max-reconnect=0"]);
  assert.equal(live.running(), true);
});

test("live sync: restarts after it exits, waiting longer each time, and resets after a healthy run", () => {
  const { live, spawned, fire, advance } = harness();
  live.start();
  spawned[0].emit("close", 1, null);
  assert.equal(live.running(), false);
  assert.equal(fire(), 5_000);
  assert.equal(spawned.length, 2);
  spawned[1].emit("close", 1, null);
  assert.equal(fire(), 10_000);
  advance(10 * 60 * 1000);
  spawned[2].emit("close", 1, null);
  assert.equal(fire(), 5_000);
  assert.equal(spawned.length, 4);
});

test("live sync: stop ends it and keeps it stopped", async () => {
  const { live, spawned, pending } = harness();
  live.start();
  await live.stop();
  assert.deepEqual(spawned[0].signals, ["SIGTERM"]);
  assert.equal(live.running(), false);
  assert.equal(pending().length, 0);
});

test("live sync: stop cancels a pending restart", async () => {
  const { live, spawned, pending } = harness();
  live.start();
  spawned[0].emit("close", 1, null);
  assert.equal(pending().length, 1);
  await live.stop();
  assert.equal(pending().length, 0);
});

test("live sync: pause frees the lock for a task, then runs again", async () => {
  const { live, spawned } = harness();
  live.start();
  let runningDuringTask;
  await live.pause(async () => {
    live.start(); // A refresh in the middle must not take the lock back.
    runningDuringTask = live.running();
  });
  assert.equal(runningDuringTask, false);
  assert.equal(spawned.length, 2);
  assert.equal(live.running(), true);
});

test("live sync: stopping inside pause (a logout that worked) keeps it off", async () => {
  const { live, spawned } = harness();
  live.start();
  await live.pause(async () => {
    await live.stop();
  });
  assert.equal(spawned.length, 1);
  assert.equal(live.running(), false);
});

test("live sync: a failed task inside pause lets it run again", async () => {
  const { live, spawned } = harness();
  live.start();
  await assert.rejects(
    live.pause(async () => {
      throw new Error("logout failed");
    }),
  );
  assert.equal(spawned.length, 2);
  assert.equal(live.running(), true);
});

test("whatsapp_sync: a held store lock means the live sync is already running", () => {
  const locked = { code: 1, stdout: "", stderr: '{"success":false,"error":"store is locked (another wacli is running?): store locked"}' };
  assert.equal(isLiveSyncRunning(locked), true);
  assert.equal(isLiveSyncRunning({ code: 1, stdout: "", stderr: "not authenticated" }), false);
  assert.equal(isLiveSyncRunning({ code: 0, stdout: '{"success":true}', stderr: "" }), false);
});
