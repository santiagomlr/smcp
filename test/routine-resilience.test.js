import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTaskStore } from "../app/core/tasks.js";
import { denialFor, readPolicy, writePolicy } from "../src/policy.js";
import { REMOTE_TASK_WRITES, REMOTE_TASK_WRITES_OFF, REMOTE_TOOLS, remoteTaskWriteDenial } from "../src/remote-tools.js";
import { searchFiles } from "../src/tools/files.js";
import { smcpStatus } from "../src/tools/status.js";
import { callApp, OFFLINE_NOTE, readSavedTasks } from "../src/tools/tasks.js";
import { fold } from "../src/util.js";
import { createNotes, nameVaults } from "../src/vaults.js";

let dir;
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "smcp-routine-")));
});
after(() => rm(dir, { recursive: true, force: true }));

const nfd = (text) => text.normalize("NFD");

test("fold iguala NFC, NFD, mayúsculas y acentos", () => {
  assert.equal(fold(nfd("Revisión ÁTLAS")), "revision atlas");
  assert.equal(fold("Revisión"), fold(nfd("revision")));
});

test("las notas se encuentran aunque el archivo o la búsqueda vengan en NFD", async () => {
  const vault = join(dir, "vault");
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, nfd("Reunión comité.md")), nfd("Acordamos la migración del almacén."));
  const notes = createNotes({ vaults: () => nameVaults([vault]) });
  const byTitle = await notes.search({ query: "reunion comite" });
  assert.equal(byTitle.total, 1);
  const byText = await notes.search({ query: "Migración ALMACEN" });
  assert.equal(byText.total, 1);
  assert.match(byText.notes[0].snippet, /migración/);
});

test("file_search encuentra nombres de macOS (NFD) escritos sin acento", async () => {
  const folder = join(dir, "docs");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, nfd("Presupuesto Diseño.xlsx")), "x");
  const result = JSON.parse((await searchFiles({ root: folder, name: "diseno", limit: 5 })).content[0].text);
  assert.equal(result.data.matches.length, 1);
});

test("crear desde la IA rechaza un gemelo pendiente, ignorando acentos, mayúsculas y puntuación", () => {
  const store = createTaskStore({ path: join(dir, "dupes.json") });
  store.createProject({ name: "Atlas" });
  const first = store.create({ name: "Revisar presupuesto de diseño", project: "Atlas", allow_duplicate: false });
  assert.throws(
    () => store.create({ name: nfd("revisar Presupuesto de DISEÑO."), project: "Atlas", allow_duplicate: false }),
    (error) => error.message.includes(first.id),
  );
  // In another project, on purpose, or from the app's quick add, it is allowed.
  store.create({ name: "Revisar presupuesto de diseño", allow_duplicate: false });
  store.create({ name: "Revisar presupuesto de diseño", project: "Atlas", allow_duplicate: true });
  store.create({ name: "Revisar presupuesto de diseño", project: "Atlas" });
  // A completed one does not block a new one.
  const done = createTaskStore({ path: join(dir, "dupes-done.json") });
  done.complete({ id: done.create({ name: "Pagar luz" }).id });
  done.create({ name: "Pagar luz", allow_duplicate: false });
});

test("con la app cerrada, las lecturas salen del archivo guardado y las escrituras no", async () => {
  const path = join(dir, "offline.json");
  const settings = join(dir, "settings-none.json");
  const store = createTaskStore({ path });
  store.create({ name: "Llamar al banco", estimated_minutes: 10 });
  const appClosed = (_name, _params, local) => local();
  const read = (op, args) => readSavedTasks(op, args, path, settings);

  const available = await callApp("available", {}, { helper: appClosed, fallback: read });
  assert.equal(available.offline, true);
  assert.equal(available.value.totalAccionables, 1);
  assert.equal(readSavedTasks("create", { name: "x" }, path, settings), null);
  await assert.rejects(callApp("create", { name: "x" }, { helper: appClosed, fallback: read }), /Open the SMCP app/);
  assert.match(OFFLINE_NOTE, /did not respond/);

  // Reading never writes the file.
  const before = await readFile(path, "utf8");
  read("hygiene", {});
  assert.equal(await readFile(path, "utf8"), before);
});

test("sin fallback si la lista vive en otra computadora", async () => {
  const path = join(dir, "stale.json");
  createTaskStore({ path }).create({ name: "Copia vieja" });
  const settings = join(dir, "settings-remote.json");
  await writeFile(settings, JSON.stringify({ tasksHost: "mac-mini.tail.ts.net" }));
  assert.equal(readSavedTasks("available", {}, path, settings), null);
});

test("las ediciones remotas de tareas están apagadas por defecto y se prenden con la política", async () => {
  const config = join(dir, "config.json");
  assert.equal(readPolicy(config).remote.taskWrites, false);
  assert.equal(remoteTaskWriteDenial(readPolicy(config)), REMOTE_TASK_WRITES_OFF);
  const policy = readPolicy(config);
  policy.remote.taskWrites = true;
  writePolicy(policy, config);
  assert.equal(remoteTaskWriteDenial(readPolicy(config)), null);
  for (const name of REMOTE_TASK_WRITES) {
    assert.ok(name.startsWith("tasks_"), name);
    assert.ok(!REMOTE_TOOLS.has(name), name);
  }
  // Read-only still wins over the remote switch.
  const locked = { ...readPolicy(config), readOnly: true };
  assert.match(denialFor("tasks_create", { readOnlyHint: false, destructiveHint: true }, locked), /read-only/);
});

test("smcp_status responde aunque esté en pausa y explica cada área", async () => {
  const base = readPolicy(join(dir, "nope.json"));
  assert.equal(denialFor("smcp_status", { readOnlyHint: true }, { ...base, paused: true }), null);

  const probes = {
    tasks: async () => ({ available: 3, minutes: 45, waiting: 1, inbox: 0 }),
    gmail: async () => {
      throw new Error("No Gmail account is connected.");
    },
    notes: async () => ({ vaults: 1 }),
    whatsapp: () => new Promise(() => {}),
  };
  const status = await smcpStatus({ policy: base, probes, remote: true, timeoutMs: 50 }).catch((error) => error);
  assert.ok(!(status instanceof Error));
  assert.equal(status.areas.tasks.ok, true);
  assert.equal(status.areas.tasks.canWrite, false);
  assert.equal(status.areas.gmail.reason, "No Gmail account is connected.");
  assert.equal(status.areas.terminal.ok, false);
  assert.ok(status.working.includes("tasks"));
  assert.ok(status.notWorking.includes("gmail"));
  assert.equal(status.areas.whatsapp.reason, "Did not answer in time.");

  const paused = await smcpStatus({ policy: { ...base, paused: true }, probes });
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.working, []);
});
