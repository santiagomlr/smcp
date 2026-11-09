import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { confirmGate } from "../confirm-gate.js";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, run, textResult } from "../util.js";

const SCREENSHOT_MAX_PIXELS = "1600";
const SCREEN_ACTIONS = new Set(["clickPath", "clickAt", "type", "key"]);

// Parameters always travel as one JSON argv item, so they are never spliced into script source.
const PRELUDE = `
ObjC.import("stdlib");
const se = Application("System Events");
function proc(name) {
  const p = se.processes.byName(name);
  if (!p.exists()) throw new Error("The app is not open: " + name);
  return p;
}
function safe(fn) { try { const v = fn(); return v === null ? undefined : v; } catch (e) { return undefined; } }
function byPath(p, windowIndex, path) {
  let el = p.windows[windowIndex];
  for (const i of path) el = el.uiElements[i];
  return el;
}
`;

const SCRIPTS = {
  listApps: `
function main() {
  return se.processes.whose({ backgroundOnly: false })().map((p) => ({
    name: p.name(), pid: p.unixId(), frontmost: p.frontmost(),
  }));
}`,
  listWindows: `
function main(a) {
  return proc(a.app).windows().map((w, index) => ({
    index, title: safe(() => w.name()), position: safe(() => w.position()), size: safe(() => w.size()),
  }));
}`,
  focus: `
function main(a) {
  Application(a.app).activate();
  return { focused: a.app };
}`,
  tree: `
function main(a) {
  const p = proc(a.app);
  const w = p.windows[a.window];
  if (!w.exists()) throw new Error("That window does not exist.");
  const q = a.query ? a.query.toLowerCase() : null;
  const out = [];
  let visited = 0;
  let truncated = false;
  function walk(el, path, depth) {
    let kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (let i = 0; i < kids.length; i++) {
      if (out.length >= a.maxNodes || visited >= a.maxVisited) { truncated = true; return; }
      visited++;
      const k = kids[i];
      const childPath = path.concat(i);
      const node = {
        path: childPath, role: safe(() => k.role()), title: safe(() => k.title()) || safe(() => k.name()),
        description: safe(() => k.description()), value: safe(() => String(k.value()).slice(0, 200)),
        position: safe(() => k.position()), size: safe(() => k.size()),
      };
      const text = [node.role, node.title, node.description, node.value].join(" ").toLowerCase();
      if (!q || text.includes(q)) out.push(node);
      if (depth + 1 < a.maxDepth) walk(k, childPath, depth + 1);
    }
  }
  walk(w, [], 0);
  return { window: safe(() => w.name()), nodes: out, truncated };
}`,
  clickPath: `
function main(a) {
  const p = proc(a.app);
  p.frontmost = true;
  const el = byPath(p, a.window, a.path);
  if (!el.exists()) throw new Error("That element no longer exists. Read the tree again.");
  el.click();
  return { clicked: a.path, role: safe(() => el.role()), title: safe(() => el.title()) };
}`,
  clickAt: `
function main(a) {
  proc(a.app).frontmost = true;
  delay(0.2);
  se.click({ at: [a.x, a.y] });
  return { clicked_at: [a.x, a.y] };
}`,
  // keystroke drops spaces and corrupts accents, so paste instead and put the clipboard back.
  type: `
ObjC.import("AppKit");
function main(a) {
  proc(a.app).frontmost = true;
  delay(0.2);
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = [];
  const items = pb.pasteboardItems;
  const itemCount = items.isNil() ? 0 : items.count;
  for (let i = 0; i < itemCount; i++) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const entries = [];
    for (let t = 0; t < types.count; t++) {
      const type = types.objectAtIndex(t);
      const data = item.dataForType(type);
      if (!data.isNil()) entries.push([type, data]);
    }
    saved.push(entries);
  }
  try {
    pb.clearContents;
    pb.setStringForType($(a.text), $.NSPasteboardTypeString);
    se.keystroke("v", { using: "command down" });
    delay(0.5);
  } finally {
    pb.clearContents;
    const restored = saved.map((entries) => {
      const item = $.NSPasteboardItem.alloc.init;
      entries.forEach(([type, data]) => item.setDataForType(data, type));
      return item;
    });
    if (restored.length) pb.writeObjects($(restored));
  }
  return { typed_chars: a.text.length };
}`,
  key: `
function main(a) {
  proc(a.app).frontmost = true;
  delay(0.2);
  const using = a.modifiers.map((m) => m + " down");
  if (a.keyCode !== null) se.keyCode(a.keyCode, { using });
  else se.keystroke(a.key, { using });
  return { pressed: a.key, modifiers: a.modifiers };
}`,
};

const KEY_CODES = {
  return: 36, enter: 76, tab: 48, space: 49, delete: 51, escape: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
};

function friendlyError(stderr) {
  if (/assistive|-1719|-25211|not allowed/i.test(stderr)) {
    return (
      "macOS has not granted permission. Open SMCP > Settings > macOS Permissions and turn on Accessibility.\n" +
      `Detail: ${stderr.trim().slice(0, 300)}`
    );
  }
  const message = stderr
    .replace(/^.*?execution error:\s*/s, "")
    .replace(/^(Error:\s*)+/, "")
    .replace(/\s*\(-?\d+\)\s*$/, "")
    .trim();
  return message.slice(0, 1000) || "Unknown osascript error.";
}

/** Runs a named script in this process. SMCP.app calls this; tools go through callJxa. */
export async function localJxa(name, params = {}, timeoutMs = 30_000, { gate = confirmGate, exec = run } = {}) {
  if (!Object.hasOwn(SCRIPTS, name)) return { error: "Unknown action." };
  // Only a person may answer a send confirmation, so the screen is off limits while one is open.
  if (SCREEN_ACTIONS.has(name) && gate.isConfirming()) {
    return { error: "A confirmation window is open. Wait for the person to answer." };
  }
  const body = `${PRELUDE}${SCRIPTS[name]}
function run(argv) { return JSON.stringify(main(JSON.parse(argv[0]))); }`;
  const execute = () => exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", body, JSON.stringify(params)], { timeoutMs });
  const result = await (SCREEN_ACTIONS.has(name) ? gate.act(execute) : execute());
  if (result.timedOut) return { error: "The operation took too long. Reduce the depth or the number of nodes." };
  if (result.code !== 0) return { error: friendlyError(result.stderr) };
  return { value: JSON.parse(result.stdout) };
}

export async function callJxa(name, params = {}, timeoutMs = 30_000) {
  try {
    return await viaHelper("jxa", { name, params, timeoutMs }, () => localJxa(name, params, timeoutMs));
  } catch (error) {
    return { error: error.message };
  }
}

function jxaTool(name, toParams = (args) => args, { external = false, timeoutMs } = {}) {
  return async (args) => {
    const { value, error } = await callJxa(name, toParams(args), timeoutMs);
    if (error) return errorResult(error);
    return external ? externalResult(value) : textResult(value);
  };
}

export async function screenshot({ window_id }) {
  try {
    return await viaHelper("screenshot", { window_id }, () => localScreenshot({ window_id }));
  } catch (error) {
    return errorResult(error.message);
  }
}

export async function localScreenshot({ window_id }) {
  if (window_id !== undefined && !Number.isInteger(window_id)) return errorResult("Invalid window_id.");
  const dir = await mkdtemp(join(tmpdir(), "smcp-"));
  const file = join(dir, "shot.png");
  try {
    const args = ["-x", "-t", "png"];
    if (window_id !== undefined) args.push("-l", String(window_id));
    const shot = await run("/usr/sbin/screencapture", [...args, file], { timeoutMs: 15_000 });
    const data = shot.code === 0 ? await readFile(file).catch(() => null) : null;
    if (!data) {
      return errorResult(
        "Could not capture. Open SMCP > Settings > macOS Permissions and turn on Screen Recording.\n" +
          shot.stderr.trim().slice(0, 300),
      );
    }
    await run("/usr/bin/sips", ["-Z", SCREENSHOT_MAX_PIXELS, file], { timeoutMs: 15_000 });
    return {
      content: [{ type: "image", mimeType: "image/png", data: (await readFile(file)).toString("base64") }],
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function registerApps(server) {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const acting = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  const app = z.string().min(1).max(200).describe("App name, exactly as it appears in app_list.");
  const window = z.number().int().min(0).default(0).describe("Window index; 0 is the main window.");

  server.registerTool(
    "app_list",
    { description: "Lists open apps that have a visible interface.", annotations: readOnly },
    jxaTool("listApps", () => ({})),
  );

  server.registerTool(
    "window_list",
    {
      description: "Lists an app's windows, with title, position and size.",
      inputSchema: { app },
      annotations: readOnly,
    },
    jxaTool("listWindows"),
  );

  server.registerTool(
    "app_focus",
    {
      description: "Opens an app or brings it to the front.",
      inputSchema: { app },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    jxaTool("focus"),
  );

  server.registerTool(
    "ui_read_tree",
    {
      description:
        "Reads a window's elements through Accessibility. Each node has a `path` to use with ui_click. With `query`, returns only what matches.",
      inputSchema: {
        app,
        window,
        query: z.string().max(200).optional().describe("Filters by role, title, description or value."),
        max_depth: z.number().int().min(1).max(15).default(6),
        max_nodes: z.number().int().min(1).max(1000).default(300),
      },
      annotations: readOnly,
    },
    jxaTool(
      "tree",
      ({ app, window, query, max_depth, max_nodes }) => ({
        app,
        window,
        query,
        maxDepth: max_depth,
        maxNodes: max_nodes,
        maxVisited: 3000,
      }),
      { external: true, timeoutMs: 60_000 },
    ),
  );

  server.registerTool(
    "ui_click",
    {
      description: "Clicks an element by its `path` from ui_read_tree (preferred) or at screen coordinates x, y.",
      inputSchema: {
        app,
        window,
        path: z.array(z.number().int().min(0)).min(1).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      },
      annotations: acting,
    },
    async ({ app, window, path, x, y }) => {
      const hasPoint = x !== undefined && y !== undefined;
      if (Boolean(path) === hasPoint) return errorResult("Give `path`, or `x` and `y`, but not both.");
      return jxaTool(path ? "clickPath" : "clickAt")(path ? { app, window, path } : { app, x, y });
    },
  );

  server.registerTool(
    "ui_type",
    {
      description: "Brings the app to the front and inserts text at the cursor. It pastes through the clipboard and then restores it.",
      inputSchema: { app, text: z.string().min(1).max(5000) },
      annotations: acting,
    },
    jxaTool("type", (args) => args, { timeoutMs: 60_000 }),
  );

  server.registerTool(
    "ui_key",
    {
      description: `Presses a key or shortcut in an app. Named keys: ${Object.keys(KEY_CODES).join(", ")}; or a single character.`,
      inputSchema: {
        app,
        key: z.string().min(1).max(10),
        modifiers: z.array(z.enum(["command", "shift", "option", "control"])).default([]),
      },
      annotations: acting,
    },
    ({ app, key, modifiers }) => {
      const keyCode = KEY_CODES[key.toLowerCase()] ?? null;
      if (keyCode === null && [...key].length !== 1) {
        return errorResult(`Unknown key: ${key}`);
      }
      return jxaTool("key")({ app, key, keyCode, modifiers });
    },
  );

  server.registerTool(
    "screenshot",
    {
      description: "Captures the main screen, or a window by its macOS window_id, silently.",
      inputSchema: { window_id: z.number().int().min(0).optional() },
      annotations: readOnly,
    },
    screenshot,
  );
}
