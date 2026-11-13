// Limits on calls that come from outside this computer, so a stolen token or a runaway routine cannot
// hammer it: a number of calls per minute, and a cap on how many heavy ones run at once.

/** A sliding window per key. `check` counts the call when it is allowed. */
export function createRateLimiter({ perMinute, now = Date.now, windowMs = 60_000 }) {
  const calls = new Map();
  return {
    /** Returns null when the call may run, or how many seconds until the next one may. */
    check(key) {
      const cutoff = now() - windowMs;
      const recent = (calls.get(key) ?? []).filter((at) => at > cutoff);
      if (recent.length >= perMinute) {
        calls.set(key, recent);
        return Math.max(1, Math.ceil((recent[0] + windowMs - now()) / 1000));
      }
      recent.push(now());
      calls.set(key, recent);
      // Keys of clients that went quiet are dropped, so the map cannot grow without limit.
      if (calls.size > 500) for (const [other, list] of calls) if (!list.some((at) => at > cutoff)) calls.delete(other);
      return null;
    },
  };
}

/** At most `max` at a time. `enter` returns a release function, or null when it is full. */
export function createGate(max) {
  let running = 0;
  return {
    enter() {
      if (running >= max) return null;
      running += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        running -= 1;
      };
    },
    running: () => running,
  };
}
