// Where a tool call came from. A call made at this computer has no origin; one that arrived through
// the remote connector or from another of the person's computers carries one, so anything that would
// open a window here (a send confirmation) can ask the person where they actually are instead.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

export const AWAY_SOURCES = ["remote", "peer"];

/** Keeps only the fields an origin may hold, so nothing else can ride along on it. */
export function cleanOrigin(origin) {
  if (!origin || !AWAY_SOURCES.includes(origin.source)) return null;
  return {
    source: origin.source,
    client: origin.client ? String(origin.client).slice(0, 80) : null,
    callId: origin.callId ? String(origin.callId).slice(0, 64) : null,
  };
}

export function runWithOrigin(origin, fn) {
  return store.run(cleanOrigin(origin), fn);
}

export const currentOrigin = () => store.getStore() ?? null;

/** True when the person is not known to be in front of this computer for the call in progress. */
export const isAway = (origin = currentOrigin()) => AWAY_SOURCES.includes(origin?.source);

/** Why something that needed the person's yes did not happen, worded for where they were asked. */
export function notConfirmed(nothing = "Nothing was sent.") {
  return isAway()
    ? `The person did not approve it on their own device: they rejected it, it expired, or the approval page was not available. ${nothing}`
    : `Not confirmed in the macOS window. ${nothing}`;
}
