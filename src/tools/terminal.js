import { homedir } from "node:os";
import { z } from "zod";
import { errorResult, run, textResult } from "../util.js";

const MAX_RETURNED_CHARS = 100_000;

function clip(text) {
  return text.length > MAX_RETURNED_CHARS ? `${text.slice(0, MAX_RETURNED_CHARS)}\n[salida recortada]` : text;
}

export async function runCommand({ command, cwd, timeout_seconds }) {
  const result = await run("/bin/zsh", ["-lc", command], {
    cwd: cwd ?? homedir(),
    timeoutMs: timeout_seconds * 1000,
  });
  if (result.spawnError) return errorResult(`No se pudo ejecutar: ${result.spawnError.message}`);
  return textResult({
    exit_code: result.code,
    timed_out: result.timedOut,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
  });
}

export function registerTerminal(server) {
  server.registerTool(
    "run_command",
    {
      description: "Ejecuta un comando de zsh en este Mac, sin restricciones de ruta. Devuelve salida y código de salida.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional().describe("Carpeta de trabajo; por defecto, tu carpeta de usuario."),
        timeout_seconds: z.number().int().min(1).max(600).default(60),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    runCommand,
  );
}
