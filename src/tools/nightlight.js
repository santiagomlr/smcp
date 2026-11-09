// Night light: the AI can warm the screen to cut blue light, like f.lux, and set its schedule.
// Only SMCP.app can hold the screen's colors, so every change goes through it.
import { z } from "zod";
import { viaHelper } from "../helper.js";
import { describe, MAX_KELVIN, MIN_BRIGHTNESS, MIN_KELVIN, PRESETS, readSettings } from "../nightlight.js";
import { errorResult, textResult } from "../util.js";
import { formatLocal } from "./calendar.js";

const APP_CLOSED = "Open the SMCP app to change the screen color: only the app can keep it warm.";

const kelvin = z
  .number()
  .int()
  .min(MIN_KELVIN)
  .max(MAX_KELVIN)
  .describe(`Color temperature in kelvin, ${MIN_KELVIN}-${MAX_KELVIN}. 6500 is normal daylight, 3400 halogen, 2700 a warm bulb, 1900 a candle, ${MIN_KELVIN} almost only red.`);
const brightness = z
  .number()
  .min(MIN_BRIGHTNESS)
  .max(1)
  .describe(`Screen level from ${MIN_BRIGHTNESS} to 1 (1 = unchanged). Lowering it cuts every color, blue included.`);

/** Asks the app; with the app closed, reading still answers from the saved settings. */
export function nightLightCall(op, args = {}, { helper = viaHelper } = {}) {
  return helper("nightlight", { op, args }, () => {
    if (op !== "status") throw new Error(APP_CLOSED);
    return { ...describe(readSettings(), Date.now(), { formatTime: formatLocal }), running: false, note: "The SMCP app is closed, so the screen is not being changed right now." };
  });
}

const handle = (fn) => async (args) => {
  try {
    return textResult(await fn(args ?? {}));
  } catch (error) {
    return errorResult(error.message);
  }
};

export function registerNightLight(server, { call = nightLightCall } = {}) {
  server.registerTool(
    "nightlight_status",
    {
      description:
        "Says whether the night light is on, the screen's color temperature and brightness right now, how much blue light is left (blueLightKept, 0-1), " +
        "and the schedule: daytime, sunset and bedtime colors, wake time, today's sunrise and sunset, and the next change.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(() => call("status")),
  );

  server.registerTool(
    "nightlight_set",
    {
      description:
        "Turns the night light on or off and sets its schedule, like f.lux: a daytime color, a sunset color from sunset on, and a bedtime color from 9 hours before the wake time. " +
        `Colors glide over 30 minutes. It can go down to ${MIN_KELVIN}K, lower than f.lux. Presets: ${Object.keys(PRESETS).join(", ")} ` +
        "(candle = 2700K at sunset and 1900K at bedtime; lowest = 1900K and 1000K with the screen dimmed). Values passed with a preset override it. " +
        "Changing the schedule ends any color set with nightlight_now.",
      inputSchema: {
        enabled: z.boolean().optional(),
        preset: z.enum(Object.keys(PRESETS)).optional(),
        day: kelvin.optional().describe("Daytime color in kelvin. 6500 leaves the screen as is."),
        sunset: kelvin.optional().describe("Color from sunset until bedtime, in kelvin."),
        bedtime: kelvin.optional().describe("Color at bedtime, in kelvin."),
        bedtime_brightness: brightness.optional(),
        wake: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Wake time, 24-hour HH:MM. Bedtime starts 9 hours earlier."),
        location: z
          .string()
          .max(40)
          .nullable()
          .optional()
          .describe("latitude,longitude for real sunrise and sunset, such as \"25.7,-100.3\". null forgets it (7:00 and 19:00 are used)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(({ bedtime_brightness, ...rest }) => call("configure", { ...rest, ...(bedtime_brightness !== undefined ? { dim: bedtime_brightness } : {}) })),
  );

  server.registerTool(
    "nightlight_now",
    {
      description:
        "Changes the screen color right now, by hand, and turns the night light on. Lasts `minutes`, or until the next wake time if omitted; then the schedule takes over again. " +
        "Use pause_minutes for normal colors for a while (for photo or design work), or resume_schedule: true to drop a manual color.",
      inputSchema: {
        kelvin: kelvin.optional(),
        brightness: brightness.optional(),
        minutes: z.number().int().min(1).max(24 * 60).optional(),
        pause_minutes: z.number().int().min(1).max(24 * 60).optional().describe("Show normal colors for this many minutes, like f.lux's 'disable for an hour'."),
        resume_schedule: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handle((args) => {
      if (args.resume_schedule) return call("clearNow");
      if (args.pause_minutes) return call("pause", { minutes: args.pause_minutes });
      if (args.kelvin === undefined && args.brightness === undefined) throw new Error("Pass kelvin, brightness, pause_minutes or resume_schedule.");
      return call("setNow", { kelvin: args.kelvin, brightness: args.brightness, minutes: args.minutes });
    }),
  );
}
