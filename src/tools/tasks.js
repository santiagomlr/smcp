import { z } from "zod";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, textResult } from "../util.js";

/** The list lives in SMCP.app, so tools always go through it and never keep a copy. */
function callApp(op, args) {
  return viaHelper("tasks", { op, args }, () => {
    throw new Error("Open the SMCP app to use Tasks.");
  });
}

const tool = (op, wrap = textResult) => async (args) => {
  try {
    return wrap(await callApp(op, args));
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
      inputSchema: { name: z.string().min(1).max(300), ...fields, repeat: z.string().max(120).optional().describe("Rule such as FREQ=WEEKLY;INTERVAL=1.") },
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
