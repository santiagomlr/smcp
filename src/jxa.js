// Runs fixed JavaScript for Automation scripts. Parameters always travel as one JSON argv item, so
// nothing the AI sends is ever spliced into script source.
import { run } from "./util.js";

/** Lets an asynchronous Cocoa callback finish before the script returns. */
export const WAIT_FOR = `
function waitFor(isDone, seconds) {
  for (let i = 0; i < seconds * 5 && !isDone(); i++) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
  }
}
`;

export function scriptBody(prelude, script) {
  return `${prelude}${script}
function run(argv) { return JSON.stringify(main(JSON.parse(argv[0]))); }`;
}

/** Returns the script's value or throws with a short reason. */
export async function runJxa(prelude, script, params = {}, { timeoutMs = 30_000, exec = run, failure = "macOS could not complete the action." } = {}) {
  const result = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", scriptBody(prelude, script), JSON.stringify(params)], { timeoutMs });
  if (result.timedOut) throw new Error(`${failure} It took too long.`);
  if (result.code !== 0) {
    const detail = String(result.stderr ?? "")
      .replace(/^.*?execution error:\s*/s, "")
      .replace(/^(Error:\s*)+/, "")
      .replace(/\s*\(-?\d+\)\s*$/, "")
      .trim()
      .slice(0, 300);
    if (/-1743|not authorized|not allowed/i.test(detail)) {
      throw new Error(`${failure} macOS has not given SMCP permission. Allow it in System Settings > Privacy & Security.`);
    }
    throw new Error(detail ? `${failure} ${detail}` : failure);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(failure);
  }
}
