import assert from "node:assert/strict";
import { test } from "node:test";
import { coalesce, whenChanged } from "../app/core/throttle.js";

test("las llamadas simultáneas comparten una sola ejecución", async () => {
  let runs = 0;
  const shared = coalesce(async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return runs;
  });
  assert.deepEqual(await Promise.all([shared(), shared(), shared()]), [1, 1, 1]);
  assert.equal(await shared(), 2);
});

test("un error no deja bloqueadas las llamadas siguientes", async () => {
  let fail = true;
  const shared = coalesce(async () => {
    if (fail) throw new Error("x");
    return "ok";
  });
  await assert.rejects(shared());
  fail = false;
  assert.equal(await shared(), "ok");
});

test("solo avisa cuando el valor cambia, lo que corta el ciclo panel-estado", () => {
  const seen = [];
  const notify = whenChanged((value) => seen.push(value));
  assert.equal(notify({ a: 1 }), true);
  assert.equal(notify({ a: 1 }), false);
  assert.equal(notify({ a: 2 }), true);
  assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
});
