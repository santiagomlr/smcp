// Keeps the person's VPNs up while keep awake runs: a computer used as a server with its screen off is
// no use if the work VPN drops after a few idle minutes and nobody is there to press Connect.
//
// - Remembers every VPN seen connected during the session, and reconnects it if it drops, with a
//   growing pause between tries so a VPN that needs a password is not hammered.
// - Never fights the person: a VPN turned off through SMCP stays off. One that drops while someone is
//   using the computer (at the keyboard or through Screen Sharing) is left alone until they have been
//   away for two minutes, so turning it off in its own app for a moment is not undone under them.
// - Apps that can only be opened (FortiClient without a system VPN) are never popped up on screen;
//   the person is told instead.
// - Sends a ping to the VPN's probe name every minute, when it has one, so a gateway that cuts idle
//   tunnels (FortiGate's default is 5 minutes) sees traffic.
// - Logs each drop with the time and whether the screen was off, so "why did it drop" has an answer.
import { TAILSCALE_ID } from "../../src/vpn.js";

/** Pauses before each reconnect try: right away, then 1, 2, 5 and 10 minutes. */
const BACKOFF_MS = [0, 60_000, 120_000, 300_000, 600_000];
/** Someone who touched the keyboard or trackpad (or Screen Sharing) this recently is using the computer. */
const PRESENT_SECONDS = 60;
/** A VPN that dropped while someone was there comes back once nobody has touched anything this long. */
const AWAY_SECONDS = 120;
const KEEPALIVE_MS = 60_000;
/** Checks are about 30 seconds apart, so a turn-off just before the last sighting still counts. */
const CHECK_SLACK_MS = 60_000;
const MAX_EVENTS = 20;
const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;

export function createVpnGuard({
  vpn,
  run,
  now = () => Date.now(),
  idleSeconds = async () => null,
  turnedOff = () => ({}),
  load = () => [],
  save = () => {},
  onNotice = () => {},
}) {
  /** id -> { name, kind, droppedAt, tries, nextTry, told } */
  const watched = new Map();
  const events = [];
  let lastKeepalive = 0;

  // Loaded from a restart: count them as seen now, so an old "turned off" never matches them.
  for (const id of load()) watched.set(id, { name: id, kind: null, seenAt: now(), droppedAt: null, tries: 0, nextTry: 0, told: false });

  const persist = () => save([...watched.keys()]);
  const log = (event) => {
    events.push({ at: new Date(now()).toISOString(), ...event });
    if (events.length > MAX_EVENTS) events.shift();
  };

  function forget(id) {
    watched.delete(id);
    persist();
  }

  /** One look at the VPNs: learn the ones that are up, and bring back the ones that dropped. */
  async function check({ displaySleepMinutes = null } = {}) {
    const state = await vpn.status();
    const all = [
      { id: TAILSCALE_ID, name: "Tailscale", kind: "tailscale", connected: state.tailscale.installed ? state.tailscale.running === true : null },
      ...state.vpns.map((item) => ({ id: item.id, name: item.name, kind: item.kind, connected: item.connected, probe: item.probe ?? null })),
    ];
    const off = turnedOff();
    let idle;
    const readIdle = async () => (idle === undefined ? (idle = await idleSeconds()) : idle);

    for (const item of all) {
      if (item.connected === true) {
        const known = watched.get(item.id);
        if (!known) {
          watched.set(item.id, { name: item.name, kind: item.kind, seenAt: now(), droppedAt: null, tries: 0, nextTry: 0, told: false, probe: item.probe });
          persist();
        } else {
          if (known.droppedAt) log({ vpn: item.name, event: "back", afterSeconds: Math.round((now() - known.droppedAt) / 1000) });
          Object.assign(known, { name: item.name, kind: item.kind, seenAt: now(), droppedAt: null, waitForAway: false, tries: 0, nextTry: 0, told: false, probe: item.probe });
        }
        continue;
      }
      const known = watched.get(item.id);
      // Unknown state (an app VPN with no probe name) proves nothing either way.
      if (!known || item.connected !== false) continue;
      known.name = item.name;
      known.kind = item.kind;

      if (!known.droppedAt) {
        // Turned off through SMCP after it was last seen on: the person's choice.
        if (Number.isFinite(off[item.id]) && off[item.id] >= known.seenAt - CHECK_SLACK_MS) {
          log({ vpn: item.name, event: "turned-off-in-smcp" });
          forget(item.id);
          continue;
        }
        const seconds = await readIdle();
        const screenOff = seconds !== null && displaySleepMinutes > 0 ? seconds >= displaySleepMinutes * 60 : null;
        known.droppedAt = now();
        // Someone is at the computer: wait until they step away before bringing it back.
        known.waitForAway = seconds !== null && seconds < PRESENT_SECONDS;
        log({
          vpn: item.name,
          event: known.waitForAway ? "dropped-while-in-use" : "dropped",
          ...(screenOff === null ? {} : { screenOff }),
          ...(seconds === null ? {} : { idleSeconds: seconds }),
        });
      }

      if (known.waitForAway) {
        const seconds = await readIdle();
        if (seconds !== null && seconds < AWAY_SECONDS) continue;
        known.waitForAway = false;
      }

      if (item.kind === "app") {
        if (!known.told) {
          known.told = true;
          onNotice({ vpn: item.name, kind: "needs-you" });
          log({ vpn: item.name, event: "needs-you", note: "This VPN can only be connected in its own app." });
        }
        continue;
      }
      if (now() < known.nextTry) continue;
      known.tries += 1;
      known.nextTry = now() + BACKOFF_MS[Math.min(known.tries, BACKOFF_MS.length - 1)];
      try {
        const result = await vpn.connect(item.id);
        if (result?.connected) {
          log({ vpn: item.name, event: "reconnected", afterSeconds: Math.round((now() - known.droppedAt) / 1000) });
          onNotice({ vpn: item.name, kind: "reconnected" });
          Object.assign(known, { seenAt: now(), droppedAt: null, tries: 0, nextTry: 0, told: false });
        } else log({ vpn: item.name, event: "reconnect-pending", try: known.tries });
      } catch (error) {
        log({ vpn: item.name, event: "reconnect-failed", try: known.tries, error: String(error.message).slice(0, 200) });
        if (known.tries === 3 && !known.told) {
          known.told = true;
          onNotice({ vpn: item.name, kind: "failed", error: error.message });
        }
      }
    }

    // A little traffic through each tunnel that has a name to reach, so idle timeouts never fire.
    if (now() - lastKeepalive >= KEEPALIVE_MS) {
      lastKeepalive = now();
      for (const [, known] of watched) {
        if (!known.droppedAt && known.probe && SAFE_HOST.test(known.probe)) {
          await run("/sbin/ping", ["-c", "1", "-t", "3", known.probe], { timeoutMs: 6_000 });
        }
      }
    }
  }

  return {
    check,
    /** The session ended: stop watching. */
    reset() {
      watched.clear();
      persist();
    },
    describe() {
      return {
        watching: [...watched.entries()].map(([id, known]) => ({
          id,
          name: known.name,
          ...(known.droppedAt ? { down: true, since: new Date(known.droppedAt).toISOString(), tries: known.tries } : { down: false }),
          keepalive: Boolean(known.probe),
        })),
        events: [...events].reverse(),
      };
    },
  };
}
