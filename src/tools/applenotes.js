// Apple Notes, read only, through the Notes app's scripting interface. Locked notes stay locked.
import { z } from "zod";
import { viaHelper } from "../helper.js";
import { runJxa } from "../jxa.js";
import { errorResult, externalResult } from "../util.js";

const MAX_READ_CHARS = 100_000;
const SNIPPET_CHARS = 200;
const NOTE_ID = /^x-coredata:\/\/[0-9A-Za-z-]+\/ICNote\/p\d+$/;

const PRELUDE = `
const Notes = Application("Notes");
function safe(fn) { try { const v = fn(); return v === null ? undefined : v; } catch (e) { return undefined; } }
function brief(note, withSnippet, snippetChars) {
  const locked = Boolean(safe(() => note.passwordProtected()));
  const out = {
    id: note.id(),
    title: safe(() => note.name()) || "",
    folder: safe(() => note.container().name()) || "",
    modified: safe(() => note.modificationDate()),
    locked,
  };
  if (withSnippet && !locked) out.snippet = (safe(() => note.plaintext()) || "").replace(/\\s+/g, " ").trim().slice(0, snippetChars);
  return out;
}
function newest(ids, dates, limit) {
  return ids.map((id, i) => [id, dates[i] ? dates[i].getTime() : 0]).sort((a, b) => b[1] - a[1]).slice(0, limit).map((pair) => pair[0]);
}
`;

const SCRIPTS = {
  search: `
function main(a) {
  const found = Notes.notes.whose({ _or: [{ name: { _contains: a.query } }, { plaintext: { _contains: a.query } }] });
  const ids = found.id();
  const order = newest(ids, found.modificationDate(), a.limit);
  return { total: ids.length, notes: order.map((id) => brief(Notes.notes.byId(id), true, a.snippetChars)) };
}`,
  recent: `
function main(a) {
  const order = newest(Notes.notes.id(), Notes.notes.modificationDate(), a.limit);
  return order.map((id) => brief(Notes.notes.byId(id), false, 0));
}`,
  read: `
function main(a) {
  const note = Notes.notes.byId(a.id);
  if (!safe(() => note.id())) throw new Error("NOT_FOUND");
  const out = brief(note, false, 0);
  out.created = safe(() => note.creationDate());
  if (out.locked) return { ...out, content: "", note: "This note is locked. Open it in Notes to read it." };
  const text = safe(() => note.plaintext()) || "";
  return { ...out, content: text.slice(0, a.maxChars), truncated: text.length > a.maxChars };
}`,
};

/** Runs in this process. SMCP.app calls it so the Automation permission is asked under its name. */
export async function localAppleNotes(name, params = {}, { jxa = runJxa } = {}) {
  if (!Object.hasOwn(SCRIPTS, name)) throw new Error("Unknown operation.");
  try {
    return await jxa(PRELUDE, SCRIPTS[name], params, { timeoutMs: 60_000, failure: "Could not read Apple Notes." });
  } catch (error) {
    if (/NOT_FOUND/.test(error.message)) throw new Error("That note was not found. Use applenotes_search.");
    throw error;
  }
}

function callNotes(name, params) {
  return viaHelper("applenotes", { name, params }, () => localAppleNotes(name, params));
}

export function registerAppleNotes(server, { call = callNotes } = {}) {
  const reads = { readOnlyHint: true, openWorldHint: false };
  const safe = (fn) => async (args) => {
    try {
      return externalResult(await fn(args ?? {}));
    } catch (error) {
      return errorResult(error.message);
    }
  };

  server.registerTool(
    "applenotes_search",
    {
      description: "Searches Apple Notes by title and content. Most recently edited first. Locked notes show only their title.",
      inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) },
      annotations: reads,
    },
    safe(({ query, limit }) => call("search", { query, limit, snippetChars: SNIPPET_CHARS })),
  );

  server.registerTool(
    "applenotes_recent",
    {
      description: "Lists the most recently edited Apple Notes.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
      annotations: reads,
    },
    safe(({ limit }) => call("recent", { limit })),
  );

  server.registerTool(
    "applenotes_read",
    {
      description: "Reads an Apple Note as plain text, using the `id` from applenotes_search or applenotes_recent.",
      inputSchema: { id: z.string().regex(NOTE_ID).describe("Note id, which starts with x-coredata://.") },
      annotations: reads,
    },
    safe(({ id }) => call("read", { id, maxChars: MAX_READ_CHARS })),
  );
}
