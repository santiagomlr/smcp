import { z } from "zod";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, textResult } from "../util.js";

/** The list lives in SMCP.app, so tools always go through it and never keep a copy. */
function callApp(op, args) {
  return viaHelper("tasks", { op, args }, () => {
    throw new Error("Abre la app SMCP para usar Tareas.");
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
  const id = z.string().min(1).max(100).describe("id de la tarea, según tasks_search o tasks_available.");
  const fields = {
    note: z.string().max(50_000).optional().describe("Detalle y de dónde salió. Cierra con 'Fuente: <ruta>'."),
    project: z.string().max(300).optional().describe("Nombre exacto, según tasks_list_projects. Omítelo solo si de verdad va a la bandeja."),
    tags: z.array(z.string().max(100)).max(20).optional(),
    waiting_for: z.string().max(80).optional().describe("Persona de la que depende. Crea su tag bajo Esperando a si no existe."),
    due: z.string().max(40).nullable().optional().describe("AAAA-MM-DD. Solo si hay consecuencia real."),
    defer: z.string().max(40).nullable().optional().describe("AAAA-MM-DD en que debe aparecer como disponible."),
    planned: z.string().max(40).nullable().optional().describe("AAAA-MM-DD en que se planea trabajar. No implica consecuencia."),
    for_claude: z.boolean().optional().describe("true si la hace Claude, false si la hace la persona."),
    estimated_minutes: z.number().int().min(0).max(10_000).optional(),
    flagged: z.boolean().optional(),
  };

  server.registerTool(
    "tasks_available",
    {
      description: "Cola disponible hoy, ordenada por urgencia, con minutos estimados, y el bloque de lo que espera a terceros.",
      annotations: reads,
    },
    tool("available", externalResult),
  );

  server.registerTool(
    "tasks_search",
    {
      description: "Busca tareas por nombre o nota, sin distinguir acentos. Úsala SIEMPRE antes de crear una, para no duplicar.",
      inputSchema: { query: z.string().min(1).max(200), include_done: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20) },
      annotations: reads,
    },
    tool("search", externalResult),
  );

  server.registerTool(
    "tasks_list_projects",
    { description: "Lista carpetas, proyectos y tags existentes.", annotations: reads },
    tool("listProjects"),
  );

  server.registerTool(
    "tasks_claude_queue",
    { description: "Tareas disponibles marcadas para que Claude las ejecute, primero las más urgentes.", annotations: reads },
    tool("claudeQueue", externalResult),
  );

  server.registerTool(
    "tasks_hygiene",
    { description: "Salud del sistema: zombies, esperas viejas, proyectos sin acción y balance por carpeta.", annotations: reads },
    tool("hygiene", externalResult),
  );

  server.registerTool(
    "tasks_forecast",
    {
      description: "Pendientes por día: vencidos, y lo que vence o está planeado para cada uno de los próximos días.",
      inputSchema: { days: z.number().int().min(1).max(370).default(30) },
      annotations: reads,
    },
    tool("forecast", externalResult),
  );

  server.registerTool(
    "tasks_review_list",
    { description: "Proyectos a los que ya les toca revisión.", annotations: reads },
    tool("reviewList", externalResult),
  );

  server.registerTool(
    "tasks_mark_reviewed",
    {
      description: "Marca un proyecto como revisado y programa su siguiente revisión.",
      inputSchema: { name: z.string().min(1).max(300) },
      annotations: writes,
    },
    tool("markReviewed"),
  );

  server.registerTool(
    "tasks_create",
    {
      description: "Crea una tarea. Antes busca duplicados con tasks_search. Debe llevar proyecto y estimación cuando se conozcan.",
      inputSchema: { name: z.string().min(1).max(300), ...fields, repeat: z.string().max(120).optional().describe("Regla como FREQ=WEEKLY;INTERVAL=1.") },
      annotations: writes,
    },
    tool("create"),
  );

  server.registerTool(
    "tasks_update",
    {
      description: "Cambia campos de una tarea. Para agregar contexto sin borrar la nota, usa tasks_append_note.",
      inputSchema: { id, name: z.string().min(1).max(300).optional(), ...fields },
      annotations: writes,
    },
    tool("update"),
  );

  server.registerTool(
    "tasks_append_note",
    { description: "Agrega texto al final de la nota de una tarea.", inputSchema: { id, text: z.string().min(1).max(20_000) }, annotations: writes },
    tool("appendNote"),
  );

  server.registerTool(
    "tasks_complete",
    {
      description: "Marca una tarea como hecha. Solo si está 100% terminada y verificada.",
      inputSchema: { id },
      annotations: writes,
    },
    tool("complete"),
  );
}
