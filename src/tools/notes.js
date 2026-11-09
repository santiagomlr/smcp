import { z } from "zod";
import { errorResult, externalResult, textResult } from "../util.js";
import { createNotes } from "../vaults.js";

export function registerNotes(server, notes = createNotes()) {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const vault = z.string().max(200).describe("Nombre de la bóveda, según notes_list_vaults.");
  const path = z.string().min(1).max(500).describe("Ruta de la nota dentro de la bóveda, por ejemplo projects/plan.md.");
  const safe = (fn, wrap = externalResult) => async (args) => {
    try {
      return wrap(await fn(args));
    } catch (error) {
      return errorResult(error.message);
    }
  };

  server.registerTool(
    "notes_list_vaults",
    { description: "Lista las bóvedas de notas (Obsidian o carpetas de Markdown) que la persona conectó en SMCP.", annotations: readOnly },
    safe(() => notes.listVaults(), textResult),
  );

  server.registerTool(
    "notes_search",
    {
      description: "Busca notas por título y contenido. Todas las palabras deben aparecer. Sin `vault`, busca en todas las bóvedas.",
      inputSchema: { query: z.string().min(1).max(200), vault: vault.optional(), limit: z.number().int().min(1).max(50).default(20) },
      annotations: readOnly,
    },
    safe((args) => notes.search(args)),
  );

  server.registerTool(
    "notes_recent",
    {
      description: "Lista las notas modificadas más recientemente.",
      inputSchema: { vault: vault.optional(), limit: z.number().int().min(1).max(50).default(20) },
      annotations: readOnly,
    },
    safe((args) => notes.recent(args)),
  );

  server.registerTool(
    "notes_read",
    { description: "Lee una nota completa.", inputSchema: { vault, path }, annotations: readOnly },
    safe((args) => notes.read(args)),
  );

  server.registerTool(
    "notes_write",
    {
      description: "Crea una nota, o agrega o reemplaza su contenido. Por defecto falla si la nota ya existe.",
      inputSchema: { vault, path, content: z.string().max(200_000), mode: z.enum(["create", "append", "overwrite"]).default("create") },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe((args) => notes.write(args), textResult),
  );
}
