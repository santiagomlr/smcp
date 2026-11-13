// The page where the person approves what was asked from outside this computer.
//
// It is served only inside the person's Tailscale network (Tailscale Serve, never Funnel), and it
// answers only their own login, which Tailscale adds to each request and no client can set. So a
// stolen connector token can ask for a send, but it cannot reach this page to approve it.
//
// A browser on the tailnet is "signed in" by where it is, not by a cookie, so any web page the person
// has open could try to post here. Every button therefore carries a secret that only this page knows
// and another site cannot read, the request must come from this page itself, and the page cannot be
// framed.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { identifyFromServe } from "./tasks-hub.js";

export const APPROVAL_PORT = 47826;
export const APPROVAL_LOCAL_PORT = 47827;
const MAX_FORM_BYTES = 4 * 1024;
const WAIT_FOR_RESULT_MS = 20_000;

/** Used when no translator is given: English, with the {placeholders} filled in. */
const plain = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match)) : text);

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
:root{color-scheme:light dark;--bg:oklch(.975 .005 172);--card:oklch(1 0 0);--ink:oklch(.25 .022 172);--muted:oklch(.5 .018 172);--rule:oklch(.86 .012 172);--accent:oklch(.45 .08 172);--on:oklch(.98 .006 172);--warn:oklch(.54 .12 48)}
@media(prefers-color-scheme:dark){:root{--bg:oklch(.2 .012 172);--card:oklch(.25 .012 172);--ink:oklch(.94 .008 172);--muted:oklch(.71 .016 172);--rule:oklch(.36 .015 172);--accent:oklch(.76 .085 172);--on:oklch(.2 .02 172);--warn:oklch(.76 .11 55)}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;padding:24px 16px 48px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{width:100%;max-width:560px;margin:0 auto}h1{margin:0 0 4px;font-size:24px;font-weight:600;line-height:1.2}h2{margin:0 0 4px;font-size:17px;font-weight:600}
p{margin:0 0 16px;color:var(--muted)}section{margin:16px 0;padding:16px;background:var(--card);border:1px solid var(--rule);border-radius:12px}
pre{margin:12px 0;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.45 ui-monospace,monospace;background:var(--bg);border:1px solid var(--rule);border-radius:9px}
.meta{font-size:13px;color:var(--muted);margin:0}.row{display:flex;gap:10px;margin-top:12px}form{flex:1;margin:0}
button{width:100%;padding:13px;font:600 16px/1 system-ui,sans-serif;border-radius:9px;cursor:pointer;border:1px solid var(--rule);background:transparent;color:inherit}
button.go{color:var(--on);background:var(--accent);border-color:var(--accent)}.done{color:var(--accent);font-weight:600}.bad{color:var(--warn);font-weight:600}
`;

function page(title, body, { refresh = 0, lang = "en" } = {}) {
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/**
 * `approvals` is the store from approvals.js. `owner` is the person's Tailscale login.
 * `tr` words the page in the app's language; `lang` is that language's code.
 */
export function createApprovalPage({ approvals, owner, identify = identifyFromServe, tr = plain, lang = () => "en", host = "127.0.0.1", port = APPROVAL_LOCAL_PORT, secret = randomBytes(32) }) {
  const nonce = (id) => createHmac("sha256", secret).update(id).digest("base64url");
  const sameNonce = (id, given) => {
    const expected = Buffer.from(nonce(id));
    const got = Buffer.from(String(given ?? ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const when = (time) => new Date(time).toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" });
  const from = (item) => (item.source === "peer" ? tr("another of your computers") : tr("the remote connector")) + (item.client ? ` · ${item.client}` : "");

  // Written out one by one so the translation check finds every text.
  const STATUS = {
    done: () => ["done", tr("Approved and done.")],
    failed: () => ["bad", tr("Approved, but it did not work:")],
    approved: () => ["done", tr("Approved. SMCP is doing it now.")],
    rejected: () => ["bad", tr("Rejected. Nothing was done.")],
    expired: () => ["bad", tr("It expired before you answered. Nothing was done.")],
  };

  const render = () => {
    const pending = approvals.pending();
    const recent = approvals.recent(8);
    const cards = pending
      .map(
        (item) => `<section><h2>${escapeHtml(item.title)}</h2>
<p class="meta">${escapeHtml(tr("Asked from {from} at {time}", { from: from(item), time: when(item.createdAt) }))}</p>
<pre>${escapeHtml(item.body)}</pre>
<p class="meta">${escapeHtml(tr("SMCP will do exactly what you see here. It expires at {time}.", { time: when(item.expiresAt) }))}</p>
<div class="row">
<form method="post" action="decide"><input type="hidden" name="id" value="${escapeHtml(item.id)}"><input type="hidden" name="nonce" value="${escapeHtml(nonce(item.id))}"><input type="hidden" name="answer" value="reject"><button type="submit">${escapeHtml(tr("Reject"))}</button></form>
<form method="post" action="decide"><input type="hidden" name="id" value="${escapeHtml(item.id)}"><input type="hidden" name="nonce" value="${escapeHtml(nonce(item.id))}"><input type="hidden" name="answer" value="approve"><button class="go" type="submit">${escapeHtml(item.action)}</button></form>
</div></section>`,
      )
      .join("");
    const history = recent
      .map((item) => {
        const [css, text] = STATUS[item.status]?.() ?? ["bad", item.status];
        return `<section><h2>${escapeHtml(item.title)}</h2><p class="${css}">${escapeHtml(text)}${item.status === "failed" && item.outcome ? ` ${escapeHtml(item.outcome.slice(0, 300))}` : ""}</p><p class="meta">${escapeHtml(when(item.decidedAt ?? item.createdAt))}</p></section>`;
      })
      .join("");
    const body = `<h1>${escapeHtml(tr("SMCP approvals"))}</h1>
<p>${escapeHtml(pending.length ? tr("Read each request and choose. Nothing goes out until you approve it.") : tr("Nothing is waiting for your approval. This page checks again by itself."))}</p>
${cards}${history ? `<h2 style="margin-top:28px">${escapeHtml(tr("Recent"))}</h2>${history}` : ""}`;
    // With nothing to read, the page reloads so it can be left open while the AI prepares a send.
    return page(tr("SMCP approvals"), body, { refresh: pending.length ? 0 : 5, lang: lang() });
  };

  const server = createServer((req, res) => {
    const send = (status, html, headers = {}) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        ...headers,
      });
      res.end(html);
    };
    const user = identify(req);
    if (!user || user !== owner) {
      return send(403, page("SMCP", `<h1>SMCP</h1><p>${escapeHtml(tr("This page only opens on your own devices, signed in to your Tailscale account."))}</p>`, { lang: lang() }));
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/") return send(200, render());
    if (req.method !== "POST" || path !== "/decide") return send(404, page("SMCP", "<h1>SMCP</h1>", { lang: lang() }));

    // Only this page's own form may post: another site's form arrives with that site as its origin.
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    let sameOrigin = !origin;
    try {
      if (origin) sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin || (site && site !== "same-origin" && site !== "none")) return send(403, page("SMCP", `<h1>SMCP</h1><p>${escapeHtml(tr("That request did not come from this page."))}</p>`, { lang: lang() }));

    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", async () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const id = form.get("id") ?? "";
      const answer = form.get("answer");
      if (!sameNonce(id, form.get("nonce")) || !["approve", "reject"].includes(answer)) {
        return send(400, page("SMCP", `<h1>SMCP</h1><p>${escapeHtml(tr("That request is not valid. Open the page again."))}</p>`, { lang: lang() }));
      }
      const decided = approvals.decide(id, answer === "approve");
      // Wait a moment for the result, so the page the person lands on already says how it ended.
      if (decided && answer === "approve") await approvals.whenFinished(id, WAIT_FOR_RESULT_MS);
      // Back to the list, so reloading never posts the form again.
      send(303, "", { location: "./" });
    });
  });

  return {
    nonce,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address().port));
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
