import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createNightLight } from "../app/core/nightlight.js";
import {
  currentTarget,
  kelvinToRgb,
  MAX_KELVIN,
  MIN_KELVIN,
  nextWake,
  normalizeSettings,
  parseLocation,
  phaseAt,
  scheduledTarget,
  screenGains,
  sunTimes,
} from "../src/nightlight.js";
import { denialFor, readPolicy, toolGroup } from "../src/policy.js";
import { REMOTE_TOOLS } from "../src/remote-tools.js";
import { registerNightLight } from "../src/tools/nightlight.js";

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-nightlight-"));
});
after(() => rm(dir, { recursive: true, force: true }));

/** A local time on a fixed day, so the tests do not depend on today's date. */
const at = (clock, day = "2026-11-09") => {
  const [hours, minutes] = clock.split(":").map(Number);
  const date = new Date(`${day}T00:00:00`);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
};

// Color

test("6500K deja la pantalla igual y bajar los K quita primero el azul", () => {
  assert.deepEqual(kelvinToRgb(6500), { r: 1, g: 1, b: 1 });
  const temps = [5000, 3400, 2700, 1900, 1200, MIN_KELVIN];
  let previous = kelvinToRgb(6500);
  for (const kelvin of temps) {
    const rgb = kelvinToRgb(kelvin);
    assert.equal(rgb.r, 1);
    assert.ok(rgb.b <= previous.b && rgb.g <= previous.g, `${kelvin}K should be warmer`);
    assert.ok(rgb.b <= rgb.g, `${kelvin}K keeps less blue than green`);
    previous = rgb;
  }
  assert.ok(kelvinToRgb(1900).b < 0.01, "a candle has practically no blue");
  assert.ok(kelvinToRgb(MIN_KELVIN).g < kelvinToRgb(1200).g, "below f.lux's 1200K floor it keeps getting redder");
});

test("valores típicos de 3400K parecidos a los de f.lux", () => {
  const { g, b } = kelvinToRgb(3400);
  assert.ok(g > 0.75 && g < 0.83, `green ${g}`);
  assert.ok(b > 0.48 && b < 0.58, `blue ${b}`);
});

test("el brillo baja los tres canales y nunca pasa del rango", () => {
  assert.deepEqual(screenGains({ kelvin: 6500, brightness: 0.5 }), { r: 0.5, g: 0.5, b: 0.5 });
  assert.equal(screenGains({ kelvin: 6500, brightness: 0 }).r, 0.2);
  assert.deepEqual(kelvinToRgb(200), kelvinToRgb(MIN_KELVIN));
  assert.deepEqual(kelvinToRgb(99_999), kelvinToRgb(MAX_KELVIN));
});

// Settings

test("unos ajustes dañados vuelven a valores seguros", () => {
  const settings = normalizeSettings({ enabled: "yes", day: "hot", sunset: 50, bedtime: 90_000, dim: 7, wake: "25:00", location: "abc", override: { until: "x" } });
  assert.equal(settings.enabled, false);
  assert.equal(settings.day, 6500);
  assert.equal(settings.sunset, MIN_KELVIN);
  assert.equal(settings.bedtime, MAX_KELVIN);
  assert.equal(settings.dim, 1);
  assert.equal(settings.wake, "07:00");
  assert.equal(settings.location, null);
  assert.equal(settings.override, null);
});

test("lee la ubicación como en f.lux", () => {
  assert.deepEqual(parseLocation("25.7,-100.3"), { latitude: 25.7, longitude: -100.3 });
  assert.deepEqual(parseLocation(" 25.7 , -100.3 "), { latitude: 25.7, longitude: -100.3 });
  assert.equal(parseLocation("95,10"), null);
  assert.equal(parseLocation("Monterrey"), null);
});

// Sun and schedule

test("amanecer y atardecer de Monterrey y Tokio con un par de minutos de margen", () => {
  const monterrey = sunTimes(Date.parse("2026-11-09T18:00:00Z"), { latitude: 25.7, longitude: -100.3 });
  // Around 06:55 and 17:55 local (UTC-6).
  assert.ok(Math.abs(monterrey.sunrise - Date.parse("2026-11-09T12:55:00Z")) < 10 * 60_000);
  assert.ok(Math.abs(monterrey.sunset - Date.parse("2026-11-09T23:55:00Z")) < 10 * 60_000);
  const tokyo = sunTimes(Date.parse("2026-06-21T03:00:00Z"), { latitude: 35.68, longitude: 139.69 });
  assert.ok(Math.abs(tokyo.sunrise - Date.parse("2026-06-20T19:25:00Z")) < 10 * 60_000);
  assert.ok(Math.abs(tokyo.sunset - Date.parse("2026-06-21T10:00:00Z")) < 10 * 60_000);
  assert.equal(sunTimes(Date.parse("2026-06-21T12:00:00Z"), { latitude: 80, longitude: 0 }), null, "midnight sun");
});

test("las tres partes del día siguen la hora de despertar", () => {
  const settings = normalizeSettings({ enabled: true, wake: "07:00" });
  assert.equal(phaseAt(at("12:00"), settings), "day");
  assert.equal(phaseAt(at("20:00"), settings), "sunset");
  assert.equal(phaseAt(at("22:00"), settings), "bedtime");
  assert.equal(phaseAt(at("03:00"), settings), "bedtime");
  assert.equal(phaseAt(at("07:30"), settings), "day");
});

test("cada cambio entra poco a poco en 30 minutos", () => {
  const settings = normalizeSettings({ enabled: true, wake: "07:00", sunset: 3400, bedtime: 1900, dim: 0.5 });
  assert.equal(scheduledTarget(at("21:50"), settings).kelvin, 3400);
  const middle = scheduledTarget(at("22:15"), settings);
  assert.ok(middle.kelvin < 3400 && middle.kelvin > 1900, `fading: ${middle.kelvin}`);
  assert.ok(middle.brightness < 1 && middle.brightness > 0.5);
  const settled = scheduledTarget(at("22:45"), settings);
  assert.equal(settled.kelvin, 1900);
  assert.equal(settled.brightness, 0.5);
});

test("un color puesto a mano dura hasta su hora y luego regresa el horario", () => {
  const settings = normalizeSettings({ enabled: true, override: { kelvin: 1000, brightness: 0.4, until: at("23:00") } });
  const manual = currentTarget(settings, at("22:00"));
  assert.equal(manual.source, "manual");
  assert.equal(manual.kelvin, 1000);
  assert.equal(currentTarget(settings, at("23:30")).source, "schedule");
  assert.equal(currentTarget({ ...settings, enabled: false }, at("22:00")).active, false);
});

test("hasta la mañana termina en la siguiente hora de despertar", () => {
  const settings = normalizeSettings({ wake: "07:00" });
  assert.equal(nextWake(at("23:00"), settings), at("07:00", "2026-11-10"));
  assert.equal(nextWake(at("05:00"), settings), at("07:00"));
});

// Controller

function fakeHelper() {
  const sent = [];
  let alive = 0;
  return {
    sent,
    alive: () => alive,
    start(_bin, { onMessage }) {
      alive += 1;
      onMessage({ ok: true, ready: true, displays: 2 });
      return { send: (message) => sent.push(message), stop: () => (alive -= 1) };
    },
  };
}

function controller(name, overrides = {}) {
  const helper = fakeHelper();
  let clock = at("22:45");
  const light = createNightLight({
    path: join(dir, `${name}.json`),
    bin: () => "/fake/smcp-nightlight",
    start: helper.start,
    now: () => clock,
    supported: true,
    setTimer: () => 0,
    clearTimer: () => {},
    ...overrides,
  });
  return { light, helper, setClock: (value) => (clock = value) };
}

test("apagado no arranca el proceso; prenderlo manda el color de la hora", async () => {
  const { light, helper } = controller("basic");
  light.start();
  assert.equal(helper.sent.length, 0);
  const status = light.configure({ enabled: true, bedtime: 1200 });
  assert.equal(status.enabled, true);
  assert.equal(status.now.kelvin, 1200);
  assert.equal(helper.sent.at(-1).b, 0);
  assert.equal(helper.sent.at(-1).r, 1);
  const saved = JSON.parse(await readFile(join(dir, "basic.json"), "utf8"));
  assert.equal(saved.bedtime, 1200);
  light.configure({ enabled: false });
  assert.equal(helper.sent.at(-1).off, true);
});

test("no repite el mismo color en cada vuelta del reloj", () => {
  const { light, helper } = controller("repeat");
  light.configure({ enabled: true });
  const count = helper.sent.length;
  light.sync();
  light.sync();
  assert.equal(helper.sent.length, count);
});

test("ahora mismo, pausa y volver al horario", () => {
  const { light } = controller("now");
  light.configure({ enabled: true, preset: "candle" });
  let status = light.setNow({ kelvin: 1000, brightness: 0.5, minutes: 30 });
  assert.equal(status.now.source, "manual");
  assert.equal(status.now.kelvin, 1000);
  assert.equal(status.now.brightness, 0.5);
  status = light.pause(60);
  assert.equal(status.now.kelvin, 6500);
  status = light.clearNow();
  assert.equal(status.now.source, "schedule");
  assert.equal(status.now.kelvin, 1900);
});

test("rechaza un preset, una hora o una ubicación inválidos", () => {
  const { light } = controller("invalid");
  assert.throws(() => light.configure({ preset: "disco" }), /Unknown preset/);
  assert.throws(() => light.configure({ wake: "late" }), /wake time/);
  assert.throws(() => light.configure({ location: "somewhere" }), /latitude,longitude/);
  assert.equal(light.configure({ location: "25.7,-100.3" }).schedule.location.latitude, 25.7);
  assert.equal(light.configure({ location: null }).schedule.location, null);
});

test("sin el ayudante instalado lo dice en vez de fallar", () => {
  const { light } = controller("missing", { bin: () => null });
  const status = light.configure({ enabled: true });
  assert.equal(status.installed, false);
  assert.match(status.error, /not installed/);
});

test("deja de reintentar si el ayudante se cae al arrancar", () => {
  let starts = 0;
  const { light } = controller("crash", {
    start: (_bin, { onExit }) => {
      starts += 1;
      const handle = { send: () => {}, stop: () => {} };
      queueMicrotask(onExit);
      return handle;
    },
  });
  light.configure({ enabled: true });
  return new Promise((resolve) => setImmediate(resolve)).then(async () => {
    for (let i = 0; i < 5; i++) {
      light.configure({ bedtime: 1000 + i * 100 });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(starts <= 6, `started ${starts} times`);
  });
});

// Tools and policy

test("las herramientas tienen su propio permiso y no existen remotamente", () => {
  assert.equal(toolGroup("nightlight_set"), "nightlight");
  assert.equal(readPolicy(join(dir, "none.json")).disabled.nightlight, false);
  assert.equal(REMOTE_TOOLS.has("nightlight_set"), false);
  const readOnly = { ...readPolicy(join(dir, "none.json")), readOnly: true };
  assert.equal(denialFor("nightlight_now", { readOnlyHint: false, destructiveHint: false }, readOnly), null, "warming the screen changes no data");
  const off = readPolicy(join(dir, "none.json"));
  off.disabled.nightlight = true;
  assert.match(denialFor("nightlight_now", {}, off), /nightlight/);
});

test("nightlight_now traduce cada opción a una sola operación de la app", async () => {
  const handlers = {};
  const calls = [];
  registerNightLight(
    { registerTool: (name, _config, handler) => (handlers[name] = handler) },
    { call: async (op, args) => (calls.push([op, args]), { ok: true }) },
  );
  await handlers.nightlight_now({ kelvin: 1200 });
  await handlers.nightlight_now({ pause_minutes: 60 });
  await handlers.nightlight_now({ resume_schedule: true });
  await handlers.nightlight_set({ preset: "lowest", bedtime_brightness: 0.4 });
  assert.deepEqual(calls, [
    ["setNow", { kelvin: 1200, brightness: undefined, minutes: undefined }],
    ["pause", { minutes: 60 }],
    ["clearNow", undefined],
    ["configure", { preset: "lowest", dim: 0.4 }],
  ]);
  const empty = await handlers.nightlight_now({});
  assert.equal(empty.isError, true);
});
