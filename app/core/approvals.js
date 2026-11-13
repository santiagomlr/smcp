// Approvals for actions asked from outside this computer. A send that starts on the phone, the web or
// another of the person's computers cannot use the confirmation window, because nobody is in front of
// this screen to see it. Instead the request waits here, the person opens the approval page on one of
// their own devices, reads exactly what will go out, and presses a button.
//
// The tool that asked keeps running in this process while it waits, holding the very arguments the page
// shows, so what is sent after an approval is what was approved: nothing can change in between.
import { randomBytes } from "node:crypto";
import { currentOrigin } from "../../src/origin.js";

export const APPROVAL_TTL_MS = 15 * 60 * 1000;
const KEEP_FINISHED_MS = 60 * 60 * 1000;
const MAX_FINISHED = 50;
const MAX_BODY_CHARS = 6000;

export const TOO_MANY_WAITING = "Too many approvals are already waiting. The person has to answer or reject those first.";

export function createApprovals({ now = Date.now, ttlMs = APPROVAL_TTL_MS, maxPending = 10, onChange = () => {}, newId = () => randomBytes(9).toString("base64url") } = {}) {
  /** id → record. A record is pending until it is approved, rejected or expires, then kept for a while. */
  const records = new Map();
  /** callId → callbacks waiting to hear that this call asked for an approval. */
  const watchers = new Map();

  const describe = (record) => ({
    id: record.id,
    status: record.status,
    title: record.title,
    action: record.action,
    body: record.body,
    source: record.origin?.source ?? null,
    client: record.origin?.client ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt ?? null,
    ...(record.outcome ? { outcome: record.outcome } : {}),
  });

  const prune = () => {
    const finished = [...records.values()].filter((record) => record.status !== "pending").sort((a, b) => b.decidedAt - a.decidedAt);
    for (const [index, record] of finished.entries()) {
      if (index >= MAX_FINISHED || now() - record.decidedAt > KEEP_FINISHED_MS) records.delete(record.id);
    }
  };

  const settle = (record, status, approved) => {
    if (record.status !== "pending") return false;
    clearTimeout(record.timer);
    record.status = status;
    record.decidedAt = now();
    record.resolve(approved);
    prune();
    onChange();
    return true;
  };

  const api = {
    /**
     * Starts waiting for the person. `decision` resolves to true only if they approve before it expires.
     * `body` is the full text of what will happen, shown as it is.
     */
    request({ title, action = "Approve", body, origin = currentOrigin() }) {
      if ([...records.values()].filter((record) => record.status === "pending").length >= maxPending) throw new Error(TOO_MANY_WAITING);
      const record = {
        id: newId(),
        status: "pending",
        title: String(title ?? "").slice(0, 120),
        action: String(action).slice(0, 40),
        body: String(body ?? "").slice(0, MAX_BODY_CHARS),
        origin,
        createdAt: now(),
        expiresAt: now() + ttlMs,
      };
      record.decision = new Promise((resolve) => {
        record.resolve = resolve;
      });
      record.timer = setTimeout(() => settle(record, "expired", false), ttlMs);
      record.timer.unref?.();
      records.set(record.id, record);
      for (const tell of watchers.get(origin?.callId) ?? []) tell(record.id);
      onChange();
      return { id: record.id, decision: record.decision, expiresAt: record.expiresAt };
    },

    /** The same as a confirmation window: resolves to whether the person said yes. */
    async confirm({ title, action, body }) {
      return api.request({ title, action, body }).decision;
    },

    /** The person's answer. Returns false when there was nothing left to answer. */
    decide(id, approve) {
      const record = records.get(id);
      if (!record) return false;
      if (record.status === "pending" && record.expiresAt <= now()) return settle(record, "expired", false) && false;
      return settle(record, approve ? "approved" : "rejected", Boolean(approve));
    },

    /** What happened after an approval: the tool that was waiting finished, well or badly. */
    finish(id, { ok, text }) {
      const record = records.get(id);
      if (!record || record.status !== "approved") return;
      record.status = ok ? "done" : "failed";
      record.outcome = String(text ?? "").slice(0, 2000);
      for (const tell of record.finishWatchers ?? []) tell();
      onChange();
    },

    /** Resolves when an approved request has finished, or after `ms`, whichever comes first. */
    whenFinished(id, ms) {
      const record = records.get(id);
      if (!record || record.status !== "approved") return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        (record.finishWatchers ??= []).push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },

    get(id) {
      const record = records.get(id);
      return record ? describe(record) : null;
    },

    pending() {
      return [...records.values()].filter((record) => record.status === "pending").map(describe);
    },

    recent(limit = 10) {
      return [...records.values()]
        .filter((record) => record.status !== "pending")
        .sort((a, b) => b.decidedAt - a.decidedAt)
        .slice(0, limit)
        .map(describe);
    },

    /**
     * How a request ended, for the tool that asks on the AI's behalf. It can wait a little for the
     * person to answer, and it never returns the text that was asked: only its title and the outcome.
     */
    async describeStatus(id, { waitSeconds = 0, url = null } = {}) {
      const key = String(id ?? "");
      const until = now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), 50) * 1000;
      while (records.get(key)?.status === "pending" && now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
      // An approved request is about to finish: give it a moment, so one call usually gets the result.
      if (records.get(key)?.status === "approved") await api.whenFinished(key, Math.max(until - now(), 2_000));
      const found = records.get(key);
      if (!found) return null;
      return {
        id: found.id,
        status: found.status,
        what: found.title,
        expires_at: new Date(found.expiresAt).toISOString(),
        ...(found.outcome ? { result: found.outcome } : {}),
        ...(found.status === "pending" ? { approve_at: url, note: "The person has not answered yet. Nothing has happened." } : {}),
        ...(found.status === "approved" ? { note: "Approved. SMCP is carrying it out; ask again in a moment for the result." } : {}),
      };
    },

    /** Used by the "turn everything off" button: nothing that was waiting may still go out. */
    rejectAll() {
      let count = 0;
      for (const record of records.values()) if (settle(record, "rejected", false)) count += 1;
      return count;
    },

    /** Calls `tell(id)` when the tool call `callId` asks for an approval. Returns a function that stops listening. */
    watchCall(callId, tell) {
      const list = watchers.get(callId) ?? [];
      list.push(tell);
      watchers.set(callId, list);
      return () => watchers.delete(callId);
    },

    /** The pending request a tool call is waiting on, if any. */
    pendingForCall(callId) {
      for (const record of records.values()) if (record.status === "pending" && record.origin?.callId === callId) return record.id;
      return null;
    },
  };
  return api;
}
