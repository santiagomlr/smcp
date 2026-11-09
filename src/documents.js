// Text from PDFs and word-processor files, with tools that come with macOS: PDFKit and textutil.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { runJxa } from "./jxa.js";
import { run } from "./util.js";

const TEXTUTIL_FORMATS = new Set([".doc", ".docx", ".rtf", ".odt", ".html", ".htm", ".webarchive"]);
const PLAIN_FORMATS = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".ics", ".vcf", ".log", ".yaml", ".yml"]);

const PDF_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("PDFKit");
function main(a) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a.path));
  if (!doc || doc.isNil()) throw new Error("NOT_PDF");
  if (doc.isLocked) throw new Error("LOCKED");
  const text = doc.string;
  return { pages: Number(doc.pageCount), text: text && !text.isNil() ? text.js : "" };
}`;

export function documentKind(name) {
  const extension = extname(String(name ?? "")).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (TEXTUTIL_FORMATS.has(extension)) return "textutil";
  if (PLAIN_FORMATS.has(extension)) return "plain";
  return null;
}

/** Converts a document on disk. Throws a sentence a person understands. */
export async function documentText(path, { exec = run, jxa = runJxa } = {}) {
  const kind = documentKind(path);
  if (kind === "pdf") {
    try {
      return await jxa("", PDF_SCRIPT, { path }, { timeoutMs: 60_000, exec, failure: "" });
    } catch (error) {
      if (/LOCKED/.test(error.message)) throw new Error("That PDF is protected with a password.");
      throw new Error("Could not read that PDF.");
    }
  }
  if (kind === "textutil") {
    const result = await exec("/usr/bin/textutil", ["-convert", "txt", "-stdout", "--", path], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error("Could not read that document.");
    return { text: result.stdout };
  }
  throw new Error("That kind of file cannot be turned into text.");
}

/** For attachments, which exist only in memory: written to a private temporary folder and removed. */
export async function bufferText(name, content, options) {
  const kind = documentKind(name);
  if (kind === "plain") return { text: Buffer.from(content).toString("utf8") };
  if (!kind) throw new Error("That kind of attachment cannot be turned into text. PDFs, Word, RTF, HTML and plain text can.");
  const folder = await mkdtemp(join(tmpdir(), "smcp-doc-"));
  try {
    const file = join(folder, `document${extname(name).toLowerCase()}`);
    await writeFile(file, content, { mode: 0o600 });
    return await documentText(file, options);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
