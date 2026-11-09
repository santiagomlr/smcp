import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createTaskStore, defaultTasksPath } from "../../app/core/tasks.js";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, textResult } from "../util.js";

/** Operations that only look. They can still answer from the saved file when the app is closed. */
export const TASK_READS = new Set(["available", "search", "listProjects", "claudeQueue", "hygiene", "forecast", "reviewList", "summary"]);

export const OFFLINE_NOTE =
  "The SMCP app did not respond, so this was read straight from the saved task list. It is current up to the app's last save. Writing needs the app open.";

/**
 * Reads the saved list without the app. It never saves, so it cannot compete with the app as a writer.
 * Returns null if there is no list on this computer (for example, when it lives on another one).
 */
export function readSavedTasks(op, args, path = process.env.SMCP_TASKS || defaultTasksPath(), settings = appSettingsPath()) {
  if (!TASK_READS.has(op) || !existsSync(path) || listLivesElsewhere(settings)) return null;
  return createTaskStore({ path })[op](args ?? {});
}

function appSettingsPath() {
  return process.env.SMCP_SETTINGS || join(homedir(), "Library", "Application Support", "SMCP", "settings.json");
}

/** When another computer holds the list, the file here is an old copy and must not be shown as current. */
function listLivesElsewhere(path) {
  try {
    return Boolean(JSON.parse(readFileSync(path, "utf8")).tasksHost);
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

/** The list lives in SMCP.app, so writes always go through it and nothing keeps a second copy. */
export async function callApp(op, args, { helper = viaHelper, fallback = readSavedTasks } = {}) {
  let offline = false;
  const value = await helper("tasks", { op, args }, () => {
    const saved = fallback(op, args);
    if (saved === null) throw new Error("Open the SMCP app to use Tasks.");
    offline = true;
    return saved;
  });
  return { value, offline };
}

const tool = (op, wrap = textResult) => async (args) => {
  try {
    const { value, offline } = await callApp(op, args);
    const result = wrap(value);
    if (offline) result.content.unshift({ type: "text", text: OFFLINE_NOTE });
    return result;
  } catch (error) {
    return errorResult(error.message);
  }
};

export function registerTasks(server) {
  const reads = { readOnlyHint: true, openWorldHint: false };
  const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  const id = z.string().min(1).max(100).describe("Task id, from tasks_search or tasks_available.");
  const fields = {
    note: z.string().max(50_000).optional().describe("Detail and where it came from. End with 'Fuente: <path>'."),
    project: z.string().max(300).optional().describe("Exact name, from tasks_list_projects. Omit it only if it really belongs in the inbox."),
    tags: z.array(z.string().max(100)).max(20).optional(),
    waiting_for: z.string().max(80).optional().describe("Person it depends on. Creates their tag under 'Esperando a' if it does not exist."),
    due: z.string().max(40).nullable().optional().describe("YYYY-MM-DD. Only if there is a real consequence."),
    defer: z.string().max(40).nullable().optional().describe("YYYY-MM-DD on which it should appear as available."),
    planned: z.string().max(40).nullable().optional().describe("YYYY-MM-DD on which work is planned. Implies no consequence."),
    for_claude: z.boolean().optional().describe("true if Claude does it, false if the person does."),
    estimated_minutes: z.number().int().min(0).max(10_000).optional(),
    flagged: z.boolean().optional(),
  };

  server.registerTool(
    "tasks_available",
    {
      description: "Queue available today, ordered by urgency, with estimated minutes, plus the block of what is waiting on others.",
      annotations: reads,
    },
    tool("available", externalResult),
  );

  server.registerTool(
    "tasks_search",
    {
      description: "Searches tasks by name or note, ignoring accents. ALWAYS use it before creating one, to avoid duplicates.",
      inputSchema: { query: z.string().min(1).max(200), include_done: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20) },
      annotations: reads,
    },
    tool("search", externalResult),
  );

  server.registerTool(
    "tasks_list_projects",
    { description: "Lists existing folders, projects and tags.", annotations: reads },
    tool("listProjects"),
  );

  server.registerTool(
    "tasks_claude_queue",
    { description: "Available tasks marked for Claude to do, most urgent first.", annotations: reads },
    tool("claudeQueue", externalResult),
  );

  server.registerTool(
    "tasks_hygiene",
    { description: "System health: zombies, old waits, projects with no action, and balance by folder.", annotations: reads },
    tool("hygiene", externalResult),
  );

  server.registerTool(
    "tasks_forecast",
    {
      description: "Pending items by day: overdue, and what is due or planned for each of the coming days.",
      inputSchema: { days: z.number().int().min(1).max(370).default(30) },
      annotations: reads,
    },
    tool("forecast", externalResult),
  );

  server.registerTool(
    "tasks_review_list",
    { description: "Projects that are due for review.", annotations: reads },
    tool("reviewList", externalResult),
  );

  server.registerTool(
    "tasks_mark_reviewed",
    {
      description: "Marks a project as reviewed and schedules its next review.",
      inputSchema: { name: z.string().min(1).max(300) },
      annotations: writes,
    },
    tool("markReviewed"),
  );

  server.registerTool(
    "tasks_create",
    {
      description: "Creates a task. Look for duplicates with tasks_search first. It should have a project and an estimate when they are known.",
      inputSchema: {
        name: z.string().min(1).max(300),
        ...fields,
        repeat: z.string().max(120).optional().describe("Rule such as FREQ=WEEKLY;INTERVAL=1."),
        allow_duplicate: z
          .boolean()
          .default(false)
          .describe("SMCP rejects a pending task with the same name in the same project, ignoring accents and case. true skips that check."),
      },
      annotations: writes,
    },
    tool("create"),
  );

  server.registerTool(
    "tasks_update",
    {
      description: "Changes fields of a task. To add context without erasing the note, use tasks_append_note.",
      inputSchema: { id, name: z.string().min(1).max(300).optional(), ...fields },
      annotations: writes,
    },
    tool("update"),
  );

  server.registerTool(
    "tasks_append_note",
    { description: "Adds text to the end of a task's note.", inputSchema: { id, text: z.string().min(1).max(20_000) }, annotations: writes },
    tool("appendNote"),
  );

  server.registerTool(
    "tasks_complete",
    {
      description: "Marks a task as done. Only if it is 100% finished and verified.",
      inputSchema: { id },
      annotations: writes,
    },
    tool("complete"),
  );
}
