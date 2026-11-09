// Night light: warms the screen in the evening so it gives off less blue light, the way f.lux does.
// Everything here is plain math with no system calls, so the app, the MCP tools and the tests share it.
// The screen itself is changed by a small native helper (native/nightlight.swift) that the app runs.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** f.lux stops at 1200K. Going lower leaves almost only red, which is the point for late nights. */
export const MIN_KELVIN = 1000;
export const MAX_KELVIN = 6500;
export const MIN_BRIGHTNESS = 0.2;
/** Minutes over which the color glides into each part of the day, so changes are never abrupt. */
export const FADE_MINUTES = 30;
/** Bedtime starts this long before the wake time. */
export const SLEEP_HOURS = 9;
const DEFAULT_SUNRISE = "07:00";
const DEFAULT_SUNSET = "19:00";

export const PRESETS = {
  recommended: { day: 6500, sunset: 3400, bedtime: 2700, dim: 1 },
  classic: { day: 6500, sunset: 3400, bedtime: 3400, dim: 1 },
  candle: { day: 6500, sunset: 2700, bedtime: 1900, dim: 1 },
  lowest: { day: 6500, sunset: 1900, bedtime: 1000, dim: 0.6 },
};

export const DEFAULTS = {
  enabled: false,
  day: 6500,
  sunset: 3400,
  bedtime: 1900,
  /** Brightness at bedtime, from MIN_BRIGHTNESS to 1. Dimming cuts every color, blue included. */
  dim: 1,
  wake: "07:00",
  location: null,
  override: null,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

export function clampKelvin(value) {
  return Math.round(clamp(Number(value), MIN_KELVIN, MAX_KELVIN));
}

export function clampBrightness(value) {
  return Math.round(clamp(Number(value), MIN_BRIGHTNESS, 1) * 100) / 100;
}

/** "7:05", "07:05" and "19:30" are valid; anything else is null. */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes, text: `${String(hours).padStart(2, "0")}:${match[2]}` };
}

/** Accepts "25.7,-100.3", "25.7, -100.3" or { latitude, longitude }. Null when it is not a place on Earth. */
export function parseLocation(value) {
  if (value === null || value === undefined || value === "") return null;
  let latitude;
  let longitude;
  if (typeof value === "string") {
    const parts = value.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 2) return null;
    [latitude, longitude] = parts;
  } else {
    ({ latitude, longitude } = value);
  }
  if (!isNumber(latitude) || !isNumber(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude: Math.round(latitude * 100) / 100, longitude: Math.round(longitude * 100) / 100 };
}

function normalizeOverride(saved) {
  if (!saved || typeof saved !== "object") return null;
  const until = Number(saved.until);
  if (!Number.isFinite(until)) return null;
  return {
    kelvin: clampKelvin(saved.kelvin ?? MAX_KELVIN),
    brightness: clampBrightness(saved.brightness ?? 1),
    until,
  };
}

/** Anything missing or out of range falls back to a safe value, so a damaged file never blinds anyone. */
export function normalizeSettings(saved = {}) {
  const source = saved && typeof saved === "object" ? saved : {};
  const pick = (key, fix) => (source[key] === undefined || source[key] === null || Number.isNaN(Number(source[key])) ? DEFAULTS[key] : fix(source[key]));
  return {
    enabled: source.enabled === true,
    day: pick("day", clampKelvin),
    sunset: pick("sunset", clampKelvin),
    bedtime: pick("bedtime", clampKelvin),
    dim: pick("dim", clampBrightness),
    wake: parseClock(source.wake)?.text ?? DEFAULTS.wake,
    location: parseLocation(source.location),
    override: normalizeOverride(source.override),
  };
}

export function settingsPath() {
  return process.env.SMCP_NIGHTLIGHT || join(homedir(), ".smcp", "nightlight.json");
}

export function readSettings(path = settingsPath()) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeSettings({});
  }
}

// ---------------------------------------------------------------------------------------------
// Color

/** Chromaticity of a black body at this temperature (Krystek's approximation of the Planckian locus). */
function linearRgb(kelvin) {
  const t = kelvin;
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d;
  const y = (2 * v) / d;
  const X = x / y;
  const Z = (1 - x - y) / y;
  return [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
}

const WHITE = linearRgb(MAX_KELVIN);
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * How much of each channel to keep at this temperature, from 0 to 1, with 6500K as plain white.
 * The values multiply the screen's gamma curve, which works in encoded (sRGB) values.
 */
export function kelvinToRgb(kelvin) {
  const linear = linearRgb(clampKelvin(kelvin)).map((value, index) => Math.max(0, value / WHITE[index]));
  const top = Math.max(...linear);
  const [r, g, b] = linear.map((value) => Math.round(encode(value / top) * 1000) / 1000);
  return { r, g, b };
}

/** The exact channel gains the native helper applies. */
export function screenGains({ kelvin, brightness = 1 }) {
  const { r, g, b } = kelvinToRgb(kelvin);
  const level = clampBrightness(brightness);
  const round = (value) => Math.round(value * level * 1000) / 1000;
  return { r: round(r), g: round(g), b: round(b) };
}

/** A rough everyday name, so a person reading the status knows what a number looks like. */
export function describeKelvin(kelvin) {
  if (kelvin <= 1300) return "ember";
  if (kelvin <= 2000) return "candle";
  if (kelvin <= 3000) return "incandescent";
  if (kelvin <= 4000) return "halogen";
  if (kelvin <= 5500) return "fluorescent";
  return "daylight";
}

// ---------------------------------------------------------------------------------------------
// Sun and schedule

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const toJulian = (ms) => ms / DAY_MS + 2440587.5;
const fromJulian = (jd) => (jd - 2440587.5) * DAY_MS;

/** Local midnight of the day that contains `ms`. */
function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight of the next day, safe across daylight-saving changes. */
function nextDay(dayStart) {
  return startOfDay(dayStart + DAY_MS + 3 * 3_600_000);
}

function atClock(dayStart, clock) {
  const date = new Date(dayStart);
  date.setHours(clock.hours, clock.minutes, 0, 0);
  return date.getTime();
}

/**
 * Sunrise and sunset for the local day that contains `ms` (the sunrise equation, good to a minute or two).
 * Null for days when the sun does not rise or does not set.
 */
export function sunTimes(ms, { latitude, longitude }) {
  const noon = startOfDay(ms) + DAY_MS / 2;
  const n = Math.round(toJulian(noon) - 2451545.0 + 0.0008 + longitude / 360);
  const meanNoon = n - longitude / 360;
  const anomaly = (357.5291 + 0.98560028 * meanNoon) % 360;
  const center = 1.9148 * Math.sin(anomaly * RAD) + 0.02 * Math.sin(2 * anomaly * RAD) + 0.0003 * Math.sin(3 * anomaly * RAD);
  const ecliptic = (anomaly + center + 180 + 102.9372) % 360;
  const transit = 2451545.0 + meanNoon + 0.0053 * Math.sin(anomaly * RAD) - 0.0069 * Math.sin(2 * ecliptic * RAD);
  const declination = Math.asin(Math.sin(ecliptic * RAD) * Math.sin(23.4397 * RAD));
  const cosHour =
    (Math.sin(-0.833 * RAD) - Math.sin(latitude * RAD) * Math.sin(declination)) / (Math.cos(latitude * RAD) * Math.cos(declination));
  if (cosHour < -1 || cosHour > 1) return null;
  const hour = Math.acos(cosHour) / RAD / 360;
  return { sunrise: Math.round(fromJulian(transit - hour)), sunset: Math.round(fromJulian(transit + hour)) };
}

/** Sunrise and sunset to use for that day: the real ones with a location, otherwise 7:00 and 19:00. */
function dayLight(dayStart, location, cache) {
  if (cache?.has(dayStart)) return cache.get(dayStart);
  const fallback = { sunrise: atClock(dayStart, parseClock(DEFAULT_SUNRISE)), sunset: atClock(dayStart, parseClock(DEFAULT_SUNSET)) };
  const times = (location && sunTimes(dayStart, location)) || fallback;
  cache?.set(dayStart, times);
  return times;
}

/** Which part of the day it is at `ms`, with no fading: "day", "sunset" or "bedtime". */
export function phaseAt(ms, settings, cache = new Map()) {
  const wake = parseClock(settings.wake) ?? parseClock(DEFAULTS.wake);
  const today = startOfDay(ms);
  for (const day of [today, nextDay(today)]) {
    const wakeAt = atClock(day, wake);
    if (ms >= wakeAt - SLEEP_HOURS * 3_600_000 && ms < wakeAt) return "bedtime";
  }
  const { sunrise, sunset } = dayLight(today, settings.location, cache);
  return ms >= sunrise && ms < sunset ? "day" : "sunset";
}

const mired = (kelvin) => 1_000_000 / kelvin;

/**
 * What the screen should look like at `ms` following the schedule. The color is the average, in
 * mireds (how the eye perceives steps of warmth), over the last FADE_MINUTES, so every change of
 * phase glides in.
 */
export function scheduledTarget(ms, settings) {
  const cache = new Map();
  const values = { day: settings.day, sunset: settings.sunset, bedtime: settings.bedtime };
  let miredSum = 0;
  let brightnessSum = 0;
  for (let minute = 0; minute < FADE_MINUTES; minute++) {
    const phase = phaseAt(ms - minute * 60_000, settings, cache);
    miredSum += mired(values[phase]);
    brightnessSum += phase === "bedtime" ? settings.dim : 1;
  }
  return {
    phase: phaseAt(ms, settings, cache),
    kelvin: clampKelvin(1_000_000 / (miredSum / FADE_MINUTES)),
    brightness: clampBrightness(brightnessSum / FADE_MINUTES),
  };
}

/** The next time the phase changes after `ms`, to the minute. */
export function nextChange(ms, settings) {
  const cache = new Map();
  const current = phaseAt(ms, settings, cache);
  for (let minute = 1; minute <= 36 * 60; minute++) {
    const at = ms + minute * 60_000;
    const phase = phaseAt(at, settings, cache);
    if (phase !== current) return { at: Math.floor(at / 60_000) * 60_000, phase };
  }
  return null;
}

/** The next wake time after `ms`: when "until morning" ends. */
export function nextWake(ms, settings) {
  const wake = parseClock(settings.wake) ?? parseClock(DEFAULTS.wake);
  const today = atClock(startOfDay(ms), wake);
  return today > ms ? today : atClock(nextDay(startOfDay(ms)), wake);
}

/**
 * What the screen should show right now: nothing when off, the manual choice while it lasts,
 * otherwise the schedule. `gains` are what the native helper applies.
 */
export function currentTarget(settings, now = Date.now()) {
  if (!settings.enabled) return { active: false, source: "off", kelvin: MAX_KELVIN, brightness: 1, gains: { r: 1, g: 1, b: 1 } };
  const override = settings.override && settings.override.until > now ? settings.override : null;
  const target = override
    ? { phase: phaseAt(now, settings), kelvin: override.kelvin, brightness: override.brightness, until: override.until }
    : scheduledTarget(now, settings);
  return { active: true, source: override ? "manual" : "schedule", ...target, gains: screenGains(target) };
}

/** A summary that makes sense to a person or an AI, with times in local ISO form. */
export function describe(settings, now = Date.now(), { formatTime = (ms) => new Date(ms).toISOString() } = {}) {
  const target = currentTarget(settings, now);
  const light = dayLight(startOfDay(now), settings.location);
  const next = settings.enabled ? nextChange(now, settings) : null;
  return {
    enabled: settings.enabled,
    now: target.active
      ? {
          source: target.source,
          phase: target.phase,
          kelvin: target.kelvin,
          looksLike: describeKelvin(target.kelvin),
          brightness: target.brightness,
          blueLightKept: target.gains.b,
          ...(target.until ? { until: formatTime(target.until) } : {}),
        }
      : null,
    schedule: {
      dayKelvin: settings.day,
      sunsetKelvin: settings.sunset,
      bedtimeKelvin: settings.bedtime,
      bedtimeBrightness: settings.dim,
      wake: settings.wake,
      bedtimeStarts: formatTime(nextWake(now, settings) - SLEEP_HOURS * 3_600_000),
      sunriseAt: formatTime(light.sunrise),
      sunsetAt: formatTime(light.sunset),
      location: settings.location,
      ...(settings.location ? {} : { note: "No location set, so sunrise and sunset are taken as 7:00 and 19:00." }),
    },
    ...(next ? { nextChange: { at: formatTime(next.at), phase: next.phase } } : {}),
    range: { minKelvin: MIN_KELVIN, maxKelvin: MAX_KELVIN, minBrightness: MIN_BRIGHTNESS },
  };
}
