import { homedir } from "node:os";
import { z } from "zod";
import { errorResult, run, textResult, userShell } from "../util.js";

const MAX_RETURNED_CHARS = 100_000;

function clip(text) {
  return text.length > MAX_RETURNED_CHARS ? `${text.slice(0, MAX_RETURNED_CHARS)}\n[output truncated]` : text;
}

export async function runCommand({ command, cwd, timeout_seconds }) {
  const result = await run(userShell(), ["-lc", command], {
    cwd: cwd ?? homedir(),
    timeoutMs: timeout_seconds * 1000,
  });
  if (result.spawnError) return errorResult(`Could not run: ${result.spawnError.message}`);
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
      description: "Runs a shell command on this computer (zsh on a Mac), with no path restrictions. Returns output and exit code.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional().describe("Working folder; by default, your home folder."),
        timeout_seconds: z.number().int().min(1).max(600).default(60),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    runCommand,
  );
}
