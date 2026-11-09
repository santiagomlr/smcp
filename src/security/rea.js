// Optional deep analysis with REA (Reverse Engineer Anything, MIT, github.com/morluto/rea).
// REA reads binaries without running them. SMCP only uses it when it is already installed: it never
// downloads it on its own, because that would run code the person did not choose to install.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { run } from "../util.js";

const TIMEOUT_MS = 120_000;
const MAX_JSON_CHARS = 60_000;

export const REA_INSTALL_HINT = "Install REA to enable deep analysis: npm install --global rea-agents (see github.com/morluto/rea).";

/** The rea command: SMCP_REA_BIN if set, otherwise the first one on PATH. */
export function reaBin(env = process.env) {
  if (env.SMCP_REA_BIN) return existsSync(env.SMCP_REA_BIN) ? env.SMCP_REA_BIN : null;
  // A .cmd shim would need a shell, and file names could then be read as commands, so it is not used.
  const names = process.platform === "win32" ? ["rea.exe"] : ["rea"];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Which REA inspections fit each kind of file. All of them read the file without executing it. */
export function reaCommandsFor(kind) {
  if (kind === "pe") return ["inspect-binary-hardening", "inspect-pe-imports", "inspect-pe-certificates", "inspect-pe-load-config"];
  if (kind === "elf" || kind === "macho") return ["inspect-binary-hardening"];
  return ["inspect-artifact"];
}

function trimmed(stdout) {
  try {
    const value = JSON.parse(stdout);
    const text = JSON.stringify(value);
    return text.length <= MAX_JSON_CHARS ? value : { truncated: true, preview: text.slice(0, MAX_JSON_CHARS) };
  } catch {
    return { raw: stdout.slice(0, MAX_JSON_CHARS) };
  }
}

export async function reaAnalyze(path, kind, { bin = reaBin(), exec = run } = {}) {
  if (!bin) return { available: false, hint: REA_INSTALL_HINT };
  const reports = {};
  for (const command of reaCommandsFor(kind)) {
    const { code, stdout, stderr, timedOut, spawnError } = await exec(bin, [command, path, "--json"], { timeoutMs: TIMEOUT_MS });
    if (spawnError) return { available: false, hint: `${REA_INSTALL_HINT} (${spawnError.message})` };
    reports[command] = code === 0 ? trimmed(stdout) : { failed: true, timedOut, error: (stderr || stdout).trim().slice(0, 2000) };
  }
  return { available: true, bin, reports };
}
