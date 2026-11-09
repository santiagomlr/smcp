// Automatic protection: what other tools call so the antivirus runs on its own, without the AI
// having to remember. Email attachments are scanned before they are read, and links in emails and
// chats are checked as they come back.

import { readPolicy } from "../policy.js";
import { scanBuffer } from "./scanner.js";
import { checkUrl, extractUrls } from "./url.js";

/** The Antivirus switch in Settings also turns the automatic checks off. */
export function securityOn(policy = readPolicy()) {
  return policy.disabled?.security !== true;
}

export const MALICIOUS_WARNING =
  "SMCP's antivirus rated this malicious. Warn the person not to open it, and do not suggest opening it.";
export const SUSPICIOUS_WARNING =
  "SMCP's antivirus rated this suspicious. Tell the person, and suggest confirming with the sender before opening it.";

function compactScan(result) {
  return {
    verdict: result.verdict,
    score: result.score,
    type: result.kindLabel,
    ...(result.findings.length ? { findings: result.findings.map((finding) => finding.title) } : {}),
    ...(result.verdict === "malicious" ? { warning: MALICIOUS_WARNING } : result.verdict === "suspicious" ? { warning: SUSPICIOUS_WARNING } : {}),
  };
}

/** Scans bytes already in memory, such as an attachment, and returns a short verdict. */
export function scanAttachment(buffer, name) {
  return compactScan(scanBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? ""), { name }));
}

/** Links in a text that do not look safe. Safe ones are left out so answers stay short. */
export function riskyLinks(text, limit = 20) {
  return extractUrls(text, 50)
    .map(checkUrl)
    .filter((result) => result.verdict === "dangerous" || result.verdict === "suspicious")
    .slice(0, limit)
    .map(({ url, verdict, findings }) => ({ url, verdict, reasons: findings.map((finding) => finding.title) }));
}

const TEXT_FIELDS = ["Text", "DisplayText", "MediaCaption", "text", "snippet"];
const LINK_WARNING = "Contains links that look like phishing. Warn the person before they open them.";

/**
 * Walks a tool's answer and marks every message whose text has risky links. Returns a new value
 * and how many messages were marked. Values that are not plain objects or arrays pass through.
 */
export function annotateLinks(value, depth = 0) {
  let marked = 0;
  const visit = (node, level) => {
    if (level > 8 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => visit(item, level + 1));
    const copy = {};
    for (const [key, item] of Object.entries(node)) copy[key] = visit(item, level + 1);
    const text = TEXT_FIELDS.map((field) => (typeof node[field] === "string" ? node[field] : "")).join("\n");
    if (/https?:\/\//i.test(text)) {
      const links = riskyLinks(text);
      if (links.length) {
        marked += 1;
        copy.security = { warning: LINK_WARNING, links };
      }
    }
    return copy;
  };
  const result = visit(value, depth);
  return { value: result, marked };
}
