import { appendFile, mkdir, open, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { documentKind, documentText } from "../documents.js";
import { errorResult, externalResult, fold, textResult } from "../util.js";
import { storeDir } from "./whatsapp.js";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 50_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".Trash", "Library"]);

/** Credentials and private stores. run_command is not limited by this list. */
export function blockedPaths() {
  const home = homedir();
  const inHome = (...parts) => join(home, ...parts);
  return [
    inHome(".ssh"),
    inHome(".aws"),
    inHome(".gnupg"),
    inHome(".kube"),
    inHome(".netrc"),
    inHome(".wacli"),
    inHome(".claude.json"),
    inHome(".claude"),
    inHome(".config", "gh"),
    inHome(".config", "gcloud"),
    inHome(".docker"),
    inHome(".npmrc"),
    inHome(".pc-remote"),
    inHome(".zsh_history"),
    inHome(".bash_history"),
    inHome("Library", "Application Support", "smcp"),
    inHome("Library", "Application Support", "SMCP"),
    inHome("Library", "Application Support", "Claude"),
    inHome("Library", "Application Support", "Firefox"),
    inHome("Library", "Safari"),
    inHome("Library", "Keychains"),
    inHome("Library", "Cookies"),
    inHome("Library", "Messages"),
    inHome("Library", "Application Support", "Google", "Chrome"),
    // Holds the WhatsApp session and the permissions, which file tools must not rewrite.
    inHome(".smcp"),
    storeDir(),
  ];
}

export function isBlocked(path) {
  return blockedPaths().some((blocked) => path === blocked || path.startsWith(blocked + sep));
}

/** Resolves ~ and symlinks, including for paths that do not exist yet. */
export async function resolveSafe(input) {
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(expanded)) throw new Error("Use an absolute path or one that starts with ~/.");
  let current = resolve(expanded);
  const missing = [];
  for (;;) {
    try {
      const real = join(await realpath(current), ...missing);
      if (isBlocked(real)) throw new BlockedError();
      return real;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A dangling symlink would create its target on write, so follow it instead of skipping it.
      const target = await readlink(current).catch(() => null);
      if (target !== null) {
        current = resolve(dirname(current), target);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

class BlockedError extends Error {
  constructor() {
    super("That path is blocked because it contains credentials or private data.");
  }
}

const handle = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (error) {
    return errorResult(error.message);
  }
};

export async function listDir({ path, limit }) {
  const dir = await resolveSafe(path);
  const entries = await readdir(dir, { withFileTypes: true });
  const items = await Promise.all(
    entries.slice(0, limit).map(async (entry) => {
      const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
      const info = await stat(join(dir, entry.name)).catch(() => null);
      return { name: entry.name, type, size: info?.size, modified: info?.mtime };
    }),
  );
  return externalResult({ path: dir, total: entries.length, truncated: entries.length > limit, items });
}

/** PDFs and Word files come back as their text; offset and max_bytes then count characters. */
async function readDocument(file, info, offset, max) {
  const { text, pages } = await documentText(file);
  const chunk = text.slice(offset, offset + max);
  return externalResult({
    path: file,
    size: info.size,
    ...(pages === undefined ? {} : { pages }),
    converted_from: documentKind(file),
    offset,
    next_offset: offset + chunk.length < text.length ? offset + chunk.length : null,
    content: chunk,
  });
}

export async function readText({ path, offset, max_bytes }) {
  const file = await resolveSafe(path);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("That path is not a file.");
  if (["pdf", "textutil"].includes(documentKind(file))) return readDocument(file, info, offset, max_bytes);
  const handleFile = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(max_bytes, Math.max(info.size - offset, 0)));
    const { bytesRead } = await handleFile.read(buffer, 0, buffer.length, offset);
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) throw new Error("It looks like a binary file; it cannot be read as text.");
    return externalResult({
      path: file,
      size: info.size,
      offset,
      next_offset: offset + bytesRead < info.size ? offset + bytesRead : null,
      content: chunk.toString("utf8"),
    });
  } finally {
    await handleFile.close();
  }
}

export async function searchFiles({ root, name, limit }) {
  const start = await resolveSafe(root);
  const needle = fold(name);
  const matches = [];
  const pending = [start];
  let seen = 0;
  while (pending.length && matches.length < limit && seen < MAX_WALK_ENTRIES) {
    const dir = pending.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      seen += 1;
      const full = join(dir, entry.name);
      if (isBlocked(full)) continue;
      if (fold(entry.name).includes(needle) && matches.length < limit) matches.push(full);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) pending.push(full);
    }
  }
  return externalResult({
    root: start,
    matches,
    complete: pending.length === 0 && matches.length < limit,
  });
}

export async function writeText({ path, content, mode }) {
  const file = await resolveSafe(path);
  await mkdir(dirname(file), { recursive: true });
  if (mode === "append") {
    await appendFile(file, content, "utf8");
  } else {
    await writeFile(file, content, { encoding: "utf8", flag: mode === "overwrite" ? "w" : "wx" });
  }
  return textResult({ written: true, path: file, bytes: Buffer.byteLength(content), mode });
}

export function registerFiles(server) {
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "file_list",
    {
      description: "Lists the contents of a folder.",
      inputSchema: {
        path: z.string().describe("Absolute path or one with ~/."),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: readOnly,
    },
    handle(listDir),
  );

  server.registerTool(
    "file_read",
    {
      description: "Reads a text file. PDFs and Word, RTF and HTML documents come back as their text. For large files, use next_offset to keep reading.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().min(0).default(0),
        max_bytes: z.number().int().min(1).max(MAX_READ_BYTES).default(200_000),
      },
      annotations: readOnly,
    },
    handle(readText),
  );

  server.registerTool(
    "file_search",
    {
      description: "Searches files and folders by name inside a folder. Skips node_modules, .git and Library.",
      inputSchema: {
        root: z.string().describe("Folder to start from."),
        name: z.string().min(1).max(200).describe("Part of the name, case-insensitive."),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: readOnly,
    },
    handle(searchFiles),
  );

  server.registerTool(
    "file_write",
    {
      description: "Writes a text file. By default it fails if the file exists; use overwrite or append to change it.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        mode: z.enum(["create", "overwrite", "append"]).default("create"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    handle(writeText),
  );
}
