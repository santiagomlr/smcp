// Phishing checks for links, done offline: nothing is visited and nothing is sent anywhere.

import { domainToUnicode } from "node:url";

const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly", "shorturl.at", "tiny.cc", "rb.gy", "s.id", "t.ly", "v.gd",
]);

const RISKY_TLDS = new Set([
  "zip", "mov", "xyz", "top", "click", "country", "gq", "tk", "ml", "cf", "ga", "work", "rest", "fit", "loan", "support", "buzz", "monster", "cam", "icu",
]);

/** Second-level suffixes where the registrable domain has three labels. */
const MULTI_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "com.mx", "org.mx", "gob.mx", "edu.mx", "com.br", "com.ar", "com.co", "com.au", "co.jp", "co.kr", "com.es", "com.pe", "com.cl",
]);

/** Brands people are often impersonated as, with the domains that really belong to them. */
const BRANDS = {
  paypal: ["paypal.com", "paypal.me"],
  apple: ["apple.com", "icloud.com", "apple.news"],
  icloud: ["icloud.com", "apple.com"],
  microsoft: ["microsoft.com", "live.com", "office.com", "microsoftonline.com", "outlook.com", "microsoft365.com", "sharepoint.com"],
  office365: ["office.com", "microsoft.com"],
  outlook: ["outlook.com", "live.com", "microsoft.com"],
  google: ["google.com", "google.com.mx", "gmail.com", "youtube.com", "goo.gl"],
  gmail: ["gmail.com", "google.com"],
  amazon: ["amazon.com", "amazon.com.mx", "amazon.es", "amazon.co.uk", "amzn.to"],
  netflix: ["netflix.com"],
  facebook: ["facebook.com", "fb.com", "meta.com"],
  instagram: ["instagram.com"],
  whatsapp: ["whatsapp.com", "whatsapp.net", "wa.me"],
  dhl: ["dhl.com", "dhl.com.mx"],
  fedex: ["fedex.com"],
  binance: ["binance.com"],
  coinbase: ["coinbase.com"],
  bbva: ["bbva.com", "bbva.mx", "bbva.es"],
  santander: ["santander.com", "santander.com.mx", "santander.es"],
  banorte: ["banorte.com"],
  banamex: ["banamex.com", "citibanamex.com"],
  citibanamex: ["citibanamex.com", "banamex.com"],
  hsbc: ["hsbc.com", "hsbc.com.mx"],
  sat: ["sat.gob.mx", "gob.mx"],
  mercadolibre: ["mercadolibre.com", "mercadolibre.com.mx", "mercadopago.com", "mercadopago.com.mx"],
  mercadopago: ["mercadopago.com", "mercadopago.com.mx", "mercadolibre.com.mx"],
};

/** Letters that phishing domains swap for look-alike digits. */
const LOOKALIKE = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" };

export function registrableDomain(host) {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function deLookalike(text) {
  return text.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[0134578]/g, (digit) => LOOKALIKE[digit]);
}

/** Levenshtein distance up to a small limit, to catch typos like paypai or arnazon. */
function nearlyEqual(a, b) {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] === 1;
}

function belongsTo(domain, owners) {
  return owners.some((owner) => domain === owner || domain.endsWith(`.${owner}`));
}

export function checkUrl(input) {
  const raw = String(input ?? "").trim();
  const findings = [];
  const add = (id, title, severity, weight) => findings.push({ id, title, severity, weight });

  if (/^(javascript|vbscript|data):/i.test(raw)) {
    add("url.script_scheme", "The link runs code instead of opening a page", "high", 80);
    return result(raw, null, findings);
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return { url: raw, verdict: "unknown", score: 0, findings: [{ id: "url.invalid", title: "Not a valid link", severity: "low" }] };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const unicodeHost = domainToUnicode(host);
  const domain = registrableDomain(host);
  const tld = host.split(".").at(-1);

  if (!["http:", "https:"].includes(url.protocol)) add("url.unusual_scheme", `Unusual link type (${url.protocol})`, "low", 10);
  if (url.protocol === "http:") add("url.no_https", "The page is not encrypted (no https)", "low", 10);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) add("url.ip_host", "The link points to a bare IP address instead of a name", "medium", 30);
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    add("url.punycode", `The name uses look-alike international letters (it really reads ${unicodeHost})`, "high", 40);
  }
  if (url.username || url.password || /@/.test(raw.split("?")[0].replace(/^[a-z]+:\/\//i, "").split("/")[0])) {
    add("url.userinfo", "The link hides its real destination after an @", "high", 40);
  }
  if (SHORTENERS.has(domain) || SHORTENERS.has(host)) add("url.shortener", "Shortened link: the real destination is hidden", "low", 15);
  if (RISKY_TLDS.has(tld)) add("url.risky_tld", `Domain ending .${tld} is often used for phishing`, "medium", 20);
  if (host.split(".").length >= 5) add("url.deep_subdomains", "Unusually many subdomains, often used to fake a real name", "medium", 15);
  if (host.length > 60) add("url.long_host", "Very long domain name", "low", 10);
  if ((host.match(/-/g) ?? []).length >= 4) add("url.many_hyphens", "Many hyphens in the domain", "low", 10);
  if (url.port && !["80", "443"].includes(url.port)) add("url.odd_port", `Uses an unusual port (${url.port})`, "low", 10);
  if (/\.(exe|scr|msi|bat|cmd|ps1|vbs|js|jar|apk|dmg|pkg|iso|hta)(\?|#|$)/i.test(url.pathname)) {
    add("url.downloads_program", "The link downloads a program directly", "medium", 25);
  }
  if (/(login|signin|verify|verificar|account|cuenta|secure|update|actualiza|password|contrase|wallet|suspend|desbloq|unlock)/i.test(`${host}${url.pathname}`) && !Object.values(BRANDS).flat().some((owner) => belongsTo(domain, [owner]))) {
    add("url.credential_words", "Words like login, verify or account in a link that is not from a known service", "low", 10);
  }

  // Brand impersonation: a brand name in the host whose registrable domain is not the brand's.
  const hostWords = deLookalike(host).split(/[.-]/);
  const domainLabel = deLookalike(domain.split(".")[0]);
  for (const [brand, owners] of Object.entries(BRANDS)) {
    if (belongsTo(domain, owners)) continue;
    // Short brand names only count as a whole word, so pineapple.com is not taken for Apple.
    if (hostWords.includes(brand) || (brand.length >= 6 && deLookalike(host).includes(brand))) {
      add("url.brand_impersonation", `Mentions ${brand} but the site does not belong to ${brand} (${domain})`, "high", 45);
      break;
    }
    if (nearlyEqual(domainLabel, brand)) {
      add("url.typosquat", `${domain} is one letter away from ${brand}`, "high", 45);
      break;
    }
  }

  return result(raw, { host, unicodeHost, domain }, findings);
}

function result(url, parts, findings) {
  const score = Math.min(100, findings.reduce((sum, finding) => sum + finding.weight, 0));
  const verdict = score >= 60 ? "dangerous" : score >= 25 ? "suspicious" : "looks_safe";
  return {
    url,
    ...(parts ?? {}),
    verdict,
    score,
    findings: findings.map(({ id, title, severity }) => ({ id, title, severity })),
    note: "Checked offline from the link alone. A link that looks safe can still lead somewhere harmful.",
  };
}

/** Finds links in a piece of text such as an email or a chat message. */
export function extractUrls(text, limit = 50) {
  const found = String(text ?? "").match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) ?? [];
  return [...new Set(found.map((link) => link.replace(/[.,;:!?]+$/, "")))].slice(0, limit);
}
