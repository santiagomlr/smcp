// The approval page: only the person, only from their own devices, and only by pressing its own button.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalPage } from "../app/core/approval-page.js";
import { createApprovals, TOO_MANY_WAITING } from "../app/core/approvals.js";
import { runWithOrigin } from "../src/origin.js";

let BASE;

/** Each test gets its own port: a connection kept alive to a page that already stopped would fail the next one. */
async function withPage(run, { owner = "ana@example.com" } = {}) {
  const approvals = createApprovals();
  let caller = owner;
  const page = createApprovalPage({ approvals, owner, identify: () => caller, port: 0 });
  BASE = `http://127.0.0.1:${await page.start()}`;
  try {
    await run({ approvals, page, as: (login) => (caller = login) });
  } finally {
    await page.stop();
  }
}

const form = (fields, headers = {}) =>
  fetch(`${BASE}/decide`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });

const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];

test("the page shows exactly what will be sent and who asked, and escapes it", async () => {
  await withPage(async ({ approvals }) => {
    runWithOrigin({ source: "remote", client: "Claude · abc" }, () => approvals.request({ title: "SMCP: send WhatsApp", action: "Send", body: "To: Ana <script>alert(1)</script>\n\nMessage:\nHola & adiós" }));
    const html = await (await fetch(BASE)).text();
    assert.match(html, /SMCP: send WhatsApp/);
    assert.match(html, /Hola &#38; adiós/);
    assert.ok(!html.includes("<script>alert"));
    assert.match(html, /the remote connector · Claude · abc/);
    assert.match(html, /exactly what you see here/);
  });
});

test("approving on the page resolves the request, and a second press changes nothing", async () => {
  await withPage(async ({ approvals }) => {
    const request = approvals.request({ title: "Send", body: "hello" });
    const html = await (await fetch(BASE)).text();
    const id = field(html, "id");
    const nonce = field(html, "nonce");
    assert.equal(id, request.id);
    const response = await form({ id, nonce, answer: "approve" }, { origin: BASE });
    assert.equal(response.status, 303);
    assert.equal(await request.decision, true);
    assert.equal(approvals.get(id).status, "approved");
    await form({ id, nonce, answer: "reject" }, { origin: BASE });
    assert.equal(approvals.get(id).status, "approved");
  });
});

test("rejecting sends nothing", async () => {
  await withPage(async ({ approvals, page }) => {
    const request = approvals.request({ title: "Send", body: "hello" });
    await form({ id: request.id, nonce: page.nonce(request.id), answer: "reject" });
    assert.equal(await request.decision, false);
    assert.equal(approvals.get(request.id).status, "rejected");
  });
});

test("someone who is not the person cannot open the page or answer, even with the right id", async () => {
  await withPage(async ({ approvals, page, as }) => {
    const request = approvals.request({ title: "Send", body: "secret text" });
    for (const login of ["someone@else.example", null, ""]) {
      as(login);
      const view = await fetch(BASE);
      assert.equal(view.status, 403);
      assert.ok(!(await view.text()).includes("secret text"));
      assert.equal((await form({ id: request.id, nonce: page.nonce(request.id), answer: "approve" })).status, 403);
    }
    assert.equal(approvals.get(request.id).status, "pending");
  });
});

test("knowing the id is not enough: the button's secret is needed, so another site cannot approve", async () => {
  await withPage(async ({ approvals, page }) => {
    const request = approvals.request({ title: "Send", body: "hello" });
    assert.equal((await form({ id: request.id, nonce: "guess", answer: "approve" })).status, 400);
    assert.equal((await form({ id: request.id, answer: "approve" })).status, 400);
    // A form on another site arrives with that site as its origin, even with a valid secret.
    assert.equal((await form({ id: request.id, nonce: page.nonce(request.id), answer: "approve" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await form({ id: request.id, nonce: page.nonce(request.id), answer: "approve" }, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal(approvals.get(request.id).status, "pending");
    // The secret of one request does not open another.
    const other = approvals.request({ title: "Send", body: "other" });
    assert.equal((await form({ id: other.id, nonce: page.nonce(request.id), answer: "approve" })).status, 400);
  });
});

test("the page cannot be framed or cached, and only accepts its own form", async () => {
  await withPage(async () => {
    const response = await fetch(BASE);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${BASE}/anything`)).status, 404);
    assert.equal((await fetch(`${BASE}/decide`)).status, 404);
  });
});

test("a different secret is made every time the page starts", async () => {
  const approvals = createApprovals();
  const one = createApprovalPage({ approvals, owner: "a", port: 0 });
  const two = createApprovalPage({ approvals, owner: "a", port: 0 });
  assert.notEqual(one.nonce("same-id"), two.nonce("same-id"));
});

test("the approval store: one answer, an expiry, a cap, and a way to reject everything at once", async () => {
  let clock = 1_000;
  const approvals = createApprovals({ now: () => clock, ttlMs: 60_000, maxPending: 2 });
  const first = approvals.request({ title: "one", body: "1" });
  const second = approvals.request({ title: "two", body: "2" });
  assert.throws(() => approvals.request({ title: "three", body: "3" }), new RegExp(TOO_MANY_WAITING.slice(0, 20)));
  assert.equal(approvals.pending().length, 2);

  clock += 61_000;
  // Too late: answering an expired request sends nothing.
  assert.equal(approvals.decide(first.id, true), false);
  assert.equal(await first.decision, false);
  assert.equal(approvals.get(first.id).status, "expired");

  assert.equal(approvals.rejectAll(), 1);
  assert.equal(await second.decision, false);
  assert.equal(approvals.get("nope"), null);
  assert.equal(approvals.decide("nope", true), false);

  // A result is only recorded for something that was approved.
  approvals.finish(second.id, { ok: true, text: "sent" });
  assert.equal(approvals.get(second.id).status, "rejected");
});

test("a tool call hears about the approval it asked for", () => {
  const approvals = createApprovals();
  const heard = [];
  const stop = approvals.watchCall("call-1", (id) => heard.push(id));
  const request = runWithOrigin({ source: "peer", client: "laptop", callId: "call-1" }, () => approvals.request({ title: "t", body: "b" }));
  runWithOrigin({ source: "peer", client: "laptop", callId: "call-2" }, () => approvals.request({ title: "t", body: "b" }));
  assert.deepEqual(heard, [request.id]);
  assert.equal(approvals.pendingForCall("call-1"), request.id);
  assert.equal(approvals.get(request.id).source, "peer");
  stop();
});
