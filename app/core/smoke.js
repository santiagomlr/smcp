// A start-up check for CI: open every window of the real app, read its state once, and quit with 0 or 1.
// It only runs when SMCP_SMOKE_TEST is set, so a normal launch never reaches it.

const LOAD_TIMEOUT_MS = 60_000;
const SETTLE_MS = 3_000;

/** Waits for a window's page to finish loading, failing if it cannot load or its renderer dies. */
function loaded(window, name) {
  const contents = window.webContents;
  if (!contents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    contents.once("did-finish-load", resolve);
    contents.once("did-fail-load", (_event, code, description) => reject(new Error(`${name}: could not load (${code} ${description})`)));
  });
}

/**
 * Collects page errors from the given windows, waits for them to load and settle, then runs `check`.
 * Resolves with the list of problems found; an empty list means the app started cleanly.
 */
export async function runSmokeTest({ windows, check, settleMs = SETTLE_MS, timeoutMs = LOAD_TIMEOUT_MS }) {
  const problems = [];
  for (const [name, window] of Object.entries(windows)) {
    const contents = window.webContents;
    contents.on("console-message", (event) => {
      if (event.level === "error") problems.push(`${name}: ${event.message}`);
    });
    contents.on("preload-error", (_event, path, error) => problems.push(`${name}: preload ${path}: ${error.message}`));
    contents.on("render-process-gone", (_event, details) => problems.push(`${name}: renderer gone (${details.reason})`));
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the windows did not load within ${timeoutMs / 1000}s`)), timeoutMs);
  });
  try {
    await Promise.race([Promise.all(Object.entries(windows).map(([name, window]) => loaded(window, name))), timeout]);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    await check();
  } catch (error) {
    problems.push(error.message);
  } finally {
    clearTimeout(timer);
  }
  return problems;
}
