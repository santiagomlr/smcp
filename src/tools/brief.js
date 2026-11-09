// One call for the start of the day. Each section reuses an existing tool and its permission, so
// turning an area off in Settings also takes it out of the brief.
import { z } from "zod";
import { viaHelper } from "../helper.js";
import { denialFor, readPolicy } from "../policy.js";
import { errorResult, externalResult } from "../util.js";
import { eventsBetween, formatDay, parseWhen, remindersDue } from "./calendar.js";
import { createWhatsApp } from "./whatsapp.js";

const SECTION_TIMEOUT_MS = 30_000;
const READ = { readOnlyHint: true };

/** An MCP result back into its data, or an error with its text. */
export function unwrap(result) {
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text);
  const parsed = JSON.parse(text);
  return parsed?._untrusted_external ? parsed.data : parsed;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("This section took too long.")), ms);
    }),
  ]);
}

export function defaultSections() {
  const whatsapp = createWhatsApp();
  const helper = (op, params) =>
    viaHelper(op, params, () => {
      throw new Error("Open the SMCP app to include this section.");
    });
  return {
    calendar: { tool: "calendar_list_events", load: ({ start, end }) => eventsBetween(start, end) },
    reminders: { tool: "reminders_list", load: ({ end }) => remindersDue(end) },
    tasks: { tool: "tasks_available", load: () => helper("tasks", { op: "available", args: {} }) },
    whatsapp: {
      tool: "whatsapp_list_chats",
      load: async () => unwrap(await whatsapp.read(["chats", "list", "--limit=15", "--unread"], "List chats")),
    },
    gmail: {
      tool: "gmail_search",
      load: async () => {
        const found = await helper("gmailSearch", { query: "is:unread in:inbox newer_than:2d", limit: 10 });
        return { unread: found.messages.slice(0, 15), errors: found.errors };
      },
    },
  };
}

/** Sections run side by side; one that fails or is off never hides the others. */
export async function buildBrief({ date, sections = defaultSections(), policy = readPolicy, timeoutMs = SECTION_TIMEOUT_MS, now = Date.now() } = {}) {
  const start = date ? parseWhen(date) : parseWhen(formatDay(now));
  const end = parseWhen(formatDay(start), { endOfDay: true });
  const current = policy();
  const entries = await Promise.all(
    Object.entries(sections).map(async ([name, section]) => {
      const denial = denialFor(section.tool, READ, current);
      if (denial) return [name, { skipped: denial }];
      try {
        return [name, await withTimeout(Promise.resolve().then(() => section.load({ start, end })), timeoutMs)];
      } catch (error) {
        return [name, { error: error.message }];
      }
    }),
  );
  return { date: formatDay(start), ...Object.fromEntries(entries) };
}

export function registerBrief(server, options = {}) {
  server.registerTool(
    "daily_brief",
    {
      description:
        "The day at a glance in one call: calendar events, reminders due, tasks available today, unread WhatsApp chats and unread email from the last two days. Each section follows its own permission in SMCP; a section that is off says so.",
      inputSchema: { date: z.string().max(10).optional().describe("YYYY-MM-DD; by default, today. Only the calendar and reminders follow it.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ date } = {}) => {
      try {
        return externalResult(await buildBrief({ date, ...options }));
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );
}
