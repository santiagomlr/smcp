import { z } from "zod";
import { errorResult, externalResult, textResult } from "../util.js";
import { createNotes } from "../vaults.js";

export function registerNotes(server, notes = createNotes()) {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const vault = z.string().max(200).describe("Vault name, as listed by notes_list_vaults.");
  const path = z.string().min(1).max(500).describe("Path of the note inside the vault, for example projects/plan.md.");
  const safe = (fn, wrap = externalResult) => async (args) => {
    try {
      return wrap(await fn(args));
    } catch (error) {
      return errorResult(error.message);
    }
  };

  server.registerTool(
    "notes_list_vaults",
    { description: "Lists the note vaults (Obsidian or Markdown folders) the person connected in SMCP.", annotations: readOnly },
    safe(() => notes.listVaults(), textResult),
  );

  server.registerTool(
    "notes_search",
    {
      description: "Searches notes by title and content. Every word must appear. Without `vault`, searches every vault.",
      inputSchema: { query: z.string().min(1).max(200), vault: vault.optional(), limit: z.number().int().min(1).max(50).default(20) },
      annotations: readOnly,
    },
    safe((args) => notes.search(args)),
  );

  server.registerTool(
    "notes_recent",
    {
      description: "Lists the most recently modified notes.",
      inputSchema: { vault: vault.optional(), limit: z.number().int().min(1).max(50).default(20) },
      annotations: readOnly,
    },
    safe((args) => notes.recent(args)),
  );

  server.registerTool(
    "notes_read",
    { description: "Reads a full note.", inputSchema: { vault, path }, annotations: readOnly },
    safe((args) => notes.read(args)),
  );

  server.registerTool(
    "notes_write",
    {
      description: "Creates a note, or appends to or replaces its content. By default it fails if the note exists.",
      inputSchema: { vault, path, content: z.string().max(200_000), mode: z.enum(["create", "append", "overwrite"]).default("create") },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe((args) => notes.write(args), textResult),
  );
}
