// The scanning engine: identifies what a file really is, hashes it, checks it against known threats
// and against behaviour rules, and returns a verdict with the reasons. It never runs the file.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { loadHashes, RULES } from "./signatures.js";

/** Bytes read for content rules. Hashes always cover the whole file. */
export const CONTENT_BYTES = 8 * 1024 * 1024;
export const MAX_HASH_BYTES = 512 * 1024 * 1024;

const EXECUTABLE_EXT = new Set([
  ".exe", ".scr", ".com", ".pif", ".bat", ".cmd", ".msi", ".dll", ".cpl", ".hta", ".vbs", ".vbe", ".js", ".jse",
  ".wsf", ".wsh", ".ps1", ".lnk", ".jar", ".app", ".command", ".pkg", ".sh", ".scpt",
]);
const DOCUMENT_EXT = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".jpg", ".jpeg", ".png", ".gif", ".mp3", ".mp4", ".mov", ".zip", ".rtf", ".csv"]);
const SCRIPT_EXT = new Set([".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".bat", ".cmd", ".sh", ".bash", ".zsh", ".command", ".py", ".rb", ".pl", ".applescript", ".scpt"]);
const MACRO_OFFICE_EXT = new Set([".docm", ".xlsm", ".pptm", ".dotm", ".xltm", ".xlam"]);
const SINGLE_TAKE_EXT = new Set([".scr", ".pif", ".hta", ".vbe", ".jse", ".wsf", ".cpl"]);

/** What the bytes say the file is, regardless of its name. */
export function fileKind(head, name = "") {
  const ext = extname(name).toLowerCase();
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return "pe";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46) return "elf";
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) {
      // 0xcafebabe is also a Java class; universal Mach-O binaries have a small architecture count.
      if (magic === 0xcafebabe && head.length >= 8 && head.readUInt32BE(4) > 30) return "java";
      return "macho";
    }
    if (magic === 0x25504446) return "pdf";
    if (magic === 0xd0cf11e0) return "ole";
    if (magic === 0x504b0304) {
      const text = head.toString("latin1");
      if (/\[Content_Types\]\.xml|word\/|xl\/|ppt\//.test(text) || MACRO_OFFICE_EXT.has(ext) || [".docx", ".xlsx", ".pptx"].includes(ext)) return "office";
      return "zip";
    }
  }
  if (head.length >= 4 && head.readUInt32LE(0) === 0x0000004c) return "lnk";
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return "script";
  if (SCRIPT_EXT.has(ext)) return "script";
  const sample = head.subarray(0, 4096);
  if (sample.includes(0)) return "binary";
  const text = sample.toString("latin1");
  if (/<html|<script|<!doctype html/i.test(text) || [".html", ".htm", ".svg"].includes(ext)) return "html";
  return "text";
}

/** Shannon entropy in bits per byte, 0 to 8. Packed or encrypted data is close to 8. */
export function entropy(buffer) {
  if (!buffer.length) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of buffer) counts[byte] += 1;
  let bits = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / buffer.length;
    bits -= p * Math.log2(p);
  }
  return Math.round(bits * 1000) / 1000;
}

function matches(pattern, text) {
  return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
}

/** Text of a buffer for rules: latin1 keeps every byte, plus UTF-16 strings that Windows programs use. */
function searchableText(buffer, kind) {
  const latin = buffer.toString("latin1");
  if (!["pe", "ole", "binary"].includes(kind)) return latin;
  // Wide strings: keep the low byte of each pair when the high byte is zero.
  const wide = [];
  for (let i = 0; i + 1 < buffer.length && wide.length < 4 * 1024 * 1024; i += 2) {
    if (buffer[i + 1] === 0 && buffer[i] >= 0x20 && buffer[i] < 0x7f) wide.push(buffer[i]);
    else if (wide.length && wide[wide.length - 1] !== 0x0a) wide.push(0x0a);
  }
  return `${latin}\n${Buffer.from(wide).toString("latin1")}`;
}

/** Problems that only show in the name: double extensions, hidden right-to-left tricks, disguises. */
export function nameFindings(name, kind) {
  const findings = [];
  const lower = name.toLowerCase();
  const parts = lower.split(".");
  const last = parts.length > 1 ? `.${parts.at(-1)}` : "";
  const previous = parts.length > 2 ? `.${parts.at(-2)}` : "";
  if (/[‮‭‏‎⁦-⁩]/.test(name)) {
    findings.push({ id: "name.rtlo", title: "The name hides its real extension with invisible text-direction characters", severity: "high", weight: 45 });
  }
  if (EXECUTABLE_EXT.has(last) && DOCUMENT_EXT.has(previous)) {
    findings.push({ id: "name.double_extension", title: `Looks like a ${previous} file but is a program (${last})`, severity: "high", weight: 40 });
  }
  if (/\s{6,}\.\w+$/.test(name)) {
    findings.push({ id: "name.padding", title: "Many spaces before the extension to hide it", severity: "medium", weight: 25 });
  }
  const isProgram = ["pe", "elf", "macho"].includes(kind);
  if (isProgram && DOCUMENT_EXT.has(last)) {
    findings.push({ id: "type.disguised_program", title: `A program disguised as a ${last} file`, severity: "high", weight: 45 });
  }
  if (SINGLE_TAKE_EXT.has(last)) {
    findings.push({ id: "type.rare_executable", title: `${last} files are rarely legitimate and are often used to spread malware`, severity: "medium", weight: 20 });
  }
  if (MACRO_OFFICE_EXT.has(last)) {
    findings.push({ id: "type.macro_document", title: "Office document type that can carry macros", severity: "low", weight: 10 });
  }
  return findings;
}

const KIND_LABELS = {
  pe: "Windows program",
  elf: "Linux program",
  macho: "macOS program",
  java: "Java class",
  pdf: "PDF",
  ole: "old Office document",
  office: "Office document",
  zip: "ZIP archive",
  lnk: "Windows shortcut",
  script: "script",
  html: "web page",
  text: "text",
  binary: "binary data",
};

export function verdictFor(score, findings) {
  if (findings.some((finding) => finding.severity === "malicious") || score >= 80) return "malicious";
  if (score >= 30) return "suspicious";
  return "clean";
}

/**
 * Scans bytes already in memory, such as an email attachment. `hash` lets a caller pass the hash of
 * the full content when `buffer` is only its first part.
 */
export function scanBuffer(buffer, { name = "", sha256, hashes = loadHashes() } = {}) {
  const digest = sha256 ?? createHash("sha256").update(buffer).digest("hex");
  const kind = fileKind(buffer, name);
  const findings = [];
  const known = hashes.get(digest);
  if (known) findings.push({ id: "hash.known_threat", title: `Known threat: ${known}`, severity: "malicious", weight: 100 });

  findings.push(...nameFindings(name, kind));

  const text = searchableText(buffer, kind);
  for (const rule of RULES) {
    if (rule.kinds && !rule.kinds.includes(kind)) continue;
    const ok = rule.all ? rule.all.every((pattern) => matches(pattern, text)) : rule.any.some((pattern) => matches(pattern, text));
    if (ok && !findings.some((finding) => finding.id === rule.id)) {
      findings.push({ id: rule.id, title: rule.title, severity: rule.severity, weight: rule.weight });
    }
  }

  const bits = entropy(buffer.subarray(0, Math.min(buffer.length, 2 * 1024 * 1024)));
  if (["pe", "elf", "macho"].includes(kind) && bits > 7.4 && buffer.length > 4096) {
    findings.push({ id: "binary.packed", title: "The program is packed or encrypted, which hides what it does", severity: "low", weight: 15 });
  }
  if (kind === "office" && /vbaProject\.bin/.test(text)) {
    findings.push({ id: "office.has_macros", title: "Contains macros", severity: "low", weight: 10 });
  }

  const score = Math.min(100, findings.reduce((sum, finding) => sum + finding.weight, 0));
  return {
    verdict: verdictFor(score, findings),
    score,
    kind,
    kindLabel: KIND_LABELS[kind] ?? kind,
    sha256: digest,
    entropy: bits,
    findings: findings.map(({ id, title, severity }) => ({ id, title, severity })),
  };
}

async function hashFile(path, size) {
  if (size > MAX_HASH_BYTES) return null;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function readHead(path, bytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Scans one file on disk. `path` must already be resolved and checked against blocked paths. */
export async function scanPath(path, { hashes = loadHashes() } = {}) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("That path is not a file.");
  const head = await readHead(path, Math.min(info.size, CONTENT_BYTES));
  const sha256 = info.size <= CONTENT_BYTES ? undefined : await hashFile(path, info.size);
  const result = scanBuffer(head, { name: basename(path), sha256: sha256 ?? undefined, hashes });
  const executable = (info.mode & 0o111) !== 0;
  return {
    path,
    size: info.size,
    modified: info.mtime,
    ...result,
    ...(sha256 === null ? { sha256: null, note: "Too large to hash; content rules covered the first 8 MB." } : {}),
    ...(info.size > CONTENT_BYTES ? { partial: true } : {}),
    ...(executable && ["pe", "elf", "macho", "script"].includes(result.kind) ? { executable: true } : {}),
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".Trash", "Library", ".cache", ".npm"]);

/**
 * Walks a folder and scans every file. `isBlocked` keeps it away from credential stores.
 * Clean files are only counted, so the answer stays short.
 */
export async function scanTree(root, { isBlocked = () => false, maxFiles = 2000, maxDepth = 6, includeClean = false, hashes = loadHashes() } = {}) {
  const pending = [{ dir: root, depth: 0 }];
  const flagged = [];
  const clean = [];
  const errors = [];
  let scanned = 0;
  let skipped = 0;
  while (pending.length && scanned < maxFiles) {
    const { dir, depth } = pending.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
      errors.push({ path: dir, error: error.code ?? error.message });
      return [];
    });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (isBlocked(full)) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < maxDepth) pending.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || scanned >= maxFiles) continue;
      scanned += 1;
      try {
        const result = await scanPath(full, { hashes });
        if (result.verdict !== "clean") flagged.push(result);
        else if (includeClean) clean.push({ path: full, kind: result.kind });
      } catch (error) {
        errors.push({ path: full, error: error.code ?? error.message });
      }
    }
  }
  const order = { malicious: 0, suspicious: 1 };
  flagged.sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
  return {
    root,
    scanned,
    complete: pending.length === 0 && scanned < maxFiles,
    malicious: flagged.filter((item) => item.verdict === "malicious").length,
    suspicious: flagged.filter((item) => item.verdict === "suspicious").length,
    flagged,
    ...(includeClean ? { clean } : {}),
    ...(skipped ? { skippedPrivate: skipped } : {}),
    ...(errors.length ? { errors: errors.slice(0, 50) } : {}),
  };
}
