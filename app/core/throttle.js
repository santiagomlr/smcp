/** Callers that arrive while `fn` is running share its result instead of starting another run. */
export function coalesce(fn) {
  let running = null;
  return () => {
    running ??= Promise.resolve()
      .then(fn)
      .finally(() => {
        running = null;
      });
    return running;
  };
}

/** Runs `fn` until it succeeds or the attempts run out, then rejects with its last error. */
export async function retry(fn, { attempts = 20, delayMs = 15_000, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await wait(delayMs);
    }
  }
}

/** Calls `fn` only when `value` differs from the last one, so a repeated value does nothing. */
export function whenChanged(fn) {
  let last;
  return (value) => {
    const key = JSON.stringify(value);
    if (key === last) return false;
    last = key;
    fn(value);
    return true;
  };
}
