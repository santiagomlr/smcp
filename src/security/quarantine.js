// Quarantine: moves a dangerous file where nothing can open or run it, and can put it back.
// The folder lives under ~/.smcp, which the file tools cannot read or write.

import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function quarantineDir() {
  return process.env.SMCP_QUARANTINE || join(homedir(), ".smcp", "quarantine");
}

async function move(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    // Different disk: copy, then remove the original.
    await copyFile(from, to);
    await unlink(from);
  }
}

/** `scan` is the result of scanning the file, saved so the person can see why it was moved. */
export async function quarantineFile(path, { reason = "", scan = null, dir = quarantineDir() } = {}) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Only files can be put in quarantine.");
  const id = randomUUID();
  const box = join(dir, id);
  await mkdir(box, { recursive: true, mode: 0o700 });
  const stored = join(box, "file.quarantined");
  await move(path, stored);
  // Nobody may run or change it while it is here.
  await chmod(stored, 0o400);
  const record = {
    id,
    originalPath: path,
    name: basename(path),
    size: info.size,
    mode: info.mode & 0o777,
    quarantinedAt: new Date().toISOString(),
    reason: String(reason).slice(0, 500),
    ...(scan ? { verdict: scan.verdict, score: scan.score, sha256: scan.sha256, findings: scan.findings } : {}),
  };
  await writeFile(join(box, "record.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

export async function listQuarantine({ dir = quarantineDir() } = {}) {
  const ids = await readdir(dir).catch(() => []);
  const records = [];
  for (const id of ids) {
    try {
      records.push(JSON.parse(await readFile(join(dir, id, "record.json"), "utf8")));
    } catch {
      // A damaged entry is left alone rather than guessed at.
    }
  }
  return records.sort((a, b) => String(b.quarantinedAt).localeCompare(String(a.quarantinedAt)));
}

function boxFor(id, dir) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That quarantine id is not valid.");
  return join(dir, id);
}

/** Puts a file back where it was. It never overwrites a file that has since taken its place. */
export async function restoreFile(id, { dir = quarantineDir() } = {}) {
  const box = boxFor(id, dir);
  const record = JSON.parse(await readFile(join(box, "record.json"), "utf8").catch(() => {
    throw new Error("Nothing in quarantine has that id.");
  }));
  const exists = await stat(record.originalPath).then(() => true, () => false);
  if (exists) throw new Error("Another file now has that name, so nothing was restored.");
  await mkdir(dirname(record.originalPath), { recursive: true });
  const stored = join(box, "file.quarantined");
  await chmod(stored, 0o600);
  await move(stored, record.originalPath);
  await chmod(record.originalPath, record.mode ?? 0o644).catch(() => {});
  await rm(box, { recursive: true, force: true });
  return { restored: true, path: record.originalPath };
}

/** Deletes a quarantined file for good. */
export async function deleteQuarantined(id, { dir = quarantineDir() } = {}) {
  const box = boxFor(id, dir);
  const exists = await stat(join(box, "record.json")).then(() => true, () => false);
  if (!exists) throw new Error("Nothing in quarantine has that id.");
  await rm(box, { recursive: true, force: true });
  return { deleted: true, id };
}
