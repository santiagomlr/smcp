import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../util.js";

const SNAPSHOT_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 60_000;
const SNAPSHOT_NAME = "wacli.db";
const EMPTY_INIT = "sqliterc";

/**
 * The sqlite3 command-line tool as a function `(args, { cwd, timeoutMs }) => result`, where the
 * result is the one `run()` gives. macOS always has it in /usr/bin; elsewhere it is looked up on
 * PATH. Never through a shell.
 */
export function createSqlite({ platform = process.platform, exists = existsSync, runner = run } = {}) {
  const file = platform === "darwin" && exists("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
  return async (args, options = {}) => {
    const result = await runner(file, args, options);
    if (result.spawnError?.code === "ENOENT") {
      throw Object.assign(new Error("sqlite3 was not found on this computer."), { code: "SQLITE_MISSING" });
    }
    return result;
  };
}

function failure(result) {
  if (result.spawnError) return result.spawnError.message;
  if (result.timedOut) return "sqlite3 took too long";
  const text = result.stderr.trim() || result.stdout.trim();
  return text ? text.split("\n")[0] : `sqlite3 ended with code ${result.code}`;
}

/** Every call names an empty init file, so a personal ~/.sqliterc (timers, echo, modes) cannot change the output. */
async function sqliteOk(sqlite, dir, args, timeoutMs) {
  const result = await sqlite(["-init", EMPTY_INIT, ...args], { cwd: dir, timeoutMs });
  if (result.code !== 0 || result.timedOut || result.spawnError) throw new Error(failure(result));
  return result;
}

/** A copy is only good if it answers queries: one taken in the middle of a checkpoint can open and then fail to read. */
function verify(sqlite, dir) {
  const counts = ["messages", "chats", "contacts"].map((table) => `SELECT count(*) FROM ${table};`).join(" ");
  return sqliteOk(sqlite, dir, ["-readonly", SNAPSHOT_NAME, counts], QUERY_TIMEOUT_MS);
}

async function removeCopy(dir) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(join(dir, SNAPSHOT_NAME + suffix), { force: true });
}

/**
 * One attempt. First the online backup through a read-only connection, which also reads what is
 * still in the write-ahead log and takes none of the writer's locks. If that fails, a plain copy
 * of the file and its log. sqlite3 runs inside the temporary folder and writes to a bare file
 * name, so no path ever has to be quoted for the dot-command.
 */
async function copyOnce(sqlite, storePath, dir) {
  try {
    await removeCopy(dir);
    await sqliteOk(sqlite, dir, ["-readonly", storePath, `.backup ${SNAPSHOT_NAME}`], SNAPSHOT_TIMEOUT_MS);
    await verify(sqlite, dir);
  } catch (error) {
    if (error.code === "SQLITE_MISSING") throw error;
    await removeCopy(dir);
    await copyFile(storePath, join(dir, SNAPSHOT_NAME));
    for (const suffix of ["-wal", "-shm"]) {
      await copyFile(storePath + suffix, join(dir, SNAPSHOT_NAME + suffix)).catch(() => {});
    }
    await verify(sqlite, dir);
  }
}

/**
 * Copies the store to a temporary folder before reading it. The store belongs to a process that
 * writes all the time, so one attempt can land on a checkpoint and fail although the next one
 * works: it retries, waiting twice as long each time. When no attempt works it throws, because a
 * store that could not be read must never look the same as a store with nothing new in it.
 * The caller deletes `dir` when it is done.
 */
export async function snapshotStore({ sqlite, storePath, attempts = 4, retryBaseMs = 3000, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  const source = resolve(storePath);
  if (!existsSync(source)) throw new Error(`The WhatsApp store was not found at ${source}.`);
  const dir = await mkdtemp(join(tmpdir(), "smcp-wa-export-"));
  const tries = Math.max(1, attempts);
  let last;
  try {
    await writeFile(join(dir, EMPTY_INIT), "");
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        await copyOnce(sqlite, source, dir);
        return { dir, attempt };
      } catch (error) {
        if (error.code === "SQLITE_MISSING") throw error;
        last = error;
        if (attempt < tries) await sleep(retryBaseMs * 2 ** (attempt - 1));
      }
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  await rm(dir, { recursive: true, force: true });
  throw new Error(`The WhatsApp store at ${source} could not be read after ${tries} attempts. Last error: ${last.message}`);
}

/** A value as SQL text. Chat ids come from the store itself, so quoting is the whole defence. */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function decode(type, hex) {
  if (type === "null") return null;
  const bytes = Buffer.from(hex, "hex");
  return type === "integer" || type === "real" ? Number(bytes.toString("latin1")) : bytes.toString("utf8");
}

/**
 * Reads rows from the snapshot. Each column travels as its type and its bytes in hexadecimal:
 * the tool's own JSON mode is not safe for this, some versions of it print control characters
 * without the backslash and the text comes back changed with no error. Hexadecimal also keeps
 * tabs, line breaks and separators inside a message exactly as stored.
 *
 * `run()` stops collecting at 5 MB and only says so with a flag, so rows are asked for in pages
 * and a page that was cut is asked for again at half the size. SQLite walks the table in the same
 * order with or without LIMIT, and ties in an ORDER BY keep the order of that walk either way.
 *
 * `columns` are SQL expressions, each optionally "expression AS name"; rows come back as objects.
 */
export async function queryRows({ sqlite, dir, columns, from, pageSize = 2000 }) {
  const specs = columns.map((column) => {
    const [expression, name] = column.split(/\s+AS\s+/);
    return { expression, name: name ?? expression };
  });
  const select = specs.map(({ expression }) => `typeof(${expression}), hex(${expression})`).join(", ");
  const rows = [];
  let size = Math.max(1, pageSize);
  for (;;) {
    const sql = `SELECT ${select} FROM ${from} LIMIT ${size} OFFSET ${rows.length}`;
    const result = await sqlite(["-init", EMPTY_INIT, "-readonly", "-list", "-noheader", "-separator", "|", SNAPSHOT_NAME, sql], { cwd: dir, timeoutMs: QUERY_TIMEOUT_MS });
    if (result.code !== 0 || result.timedOut || result.spawnError) throw new Error(`The copy of the WhatsApp store could not be queried: ${failure(result)}`);
    if (result.truncated) {
      if (size === 1) throw new Error("A row in the WhatsApp store is too large to read.");
      size = Math.floor(size / 2);
      continue;
    }
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const cells = line.split("|");
      if (cells.length !== specs.length * 2) throw new Error("The copy of the WhatsApp store answered in an unexpected format.");
      const row = {};
      specs.forEach(({ name }, index) => {
        row[name] = decode(cells[index * 2], cells[index * 2 + 1]);
      });
      rows.push(row);
    }
    if (lines.length < size) return rows;
  }
}
