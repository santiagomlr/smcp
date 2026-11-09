import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createRemoteTasks, createTasksHub, identifyFromServe, loginFromStatus } from "../app/core/tasks-hub.js";
import { createTaskStore, nextOccurrence, TASK_OPERATIONS } from "../app/core/tasks.js";
import { denialFor, toolGroup } from "../src/policy.js";
import { REMOTE_TOOLS } from "../src/remote-tools.js";

const NOW = new Date("2026-11-10T12:00:00").getTime();
let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-tasks-"));
});
after(() => rm(dir, { recursive: true, force: true }));

let counter = 0;
function fresh(now = () => NOW) {
  const path = join(dir, `t${counter++}.json`);
  const store = createTaskStore({ path, now });
  store.importOmniFocus({
    projects: [
      { name: "Atlas", folder: "🚀 Ventures", status: "active" },
      { name: "Orion", folder: "🚌 Nube", status: "active" },
      { name: "Pausado", folder: "🚌 Nube", status: "onhold" },
    ],
    tags: [
      { name: "🎯 MIT" },
      { name: "🤖 Claude" },
      { name: "🔥 Profundo" },
      { name: "💤 Algún día" },
      { name: "⏳ Esperando a" },
      { name: "Franky", parent: "⏳ Esperando a" },
    ],
  });
  return { store, path };
}

test("disponibles respeta inicio futuro y proyectos en pausa", () => {
  const { store } = fresh();
  store.create({ name: "Hoy", project: "Atlas" });
  store.create({ name: "Futuro", project: "Atlas", defer: "2026-12-01" });
  store.create({ name: "En pausa", project: "Pausado" });
  assert.deepEqual(store.available().accionables.map((task) => task.n), ["Hoy"]);
});

test("ordena: vence hoy, luego MIT, luego bandera, y Algún día al final", () => {
  const { store } = fresh();
  store.create({ name: "algun", tags: ["💤 Algún día"] });
  store.create({ name: "bandera", flagged: true });
  store.create({ name: "mit", tags: ["🎯 MIT"] });
  store.create({ name: "hoy", due: "2026-11-10" });
  assert.deepEqual(store.available().accionables.map((task) => task.n), ["hoy", "mit", "bandera", "algun"]);
});

test("la respuesta conserva la forma que usa el briefing", () => {
  const { store } = fresh();
  store.create({ name: "A", project: "Atlas", estimated_minutes: 30, tags: ["🤖 Claude", "🔥 Profundo"] });
  store.create({ name: "B", estimated_minutes: 15 });
  store.create({ name: "C" });
  const result = store.available();
  assert.equal(result.totalAccionables, 3);
  assert.equal(result.minutosTotales, 45);
  assert.deepEqual(result.sinEstimacion, ["C"]);
  const row = result.accionables.find((task) => task.n === "A");
  assert.equal(row.p, "Atlas");
  assert.equal(row.claude, true);
  assert.equal(row.energia, "🔥 Profundo");
});

test("las esperas se miden desde Prometido, no desde la última edición", () => {
  const { store } = fresh();
  const task = store.create({ name: "Mandar factura", waiting_for: "Franky", note: "Prometido: 2026-10-01" });
  store.appendNote({ id: task.id, text: "Le recordé hoy" });
  const result = store.available();
  assert.equal(result.totalAccionables, 0);
  assert.equal(result.esperando[0].quien, "Franky");
  assert.equal(result.esperando[0].desde, "2026-10-01");
  assert.equal(result.esperando[0].diasEsperando, 40);
});

test("una persona nueva crea su tag bajo Esperando a", () => {
  const { store } = fresh();
  store.create({ name: "X", waiting_for: "Arturo Jacobo" });
  const tag = store.listProjects().tags.find((item) => item.name === "Arturo Jacobo");
  assert.equal(tag.parent, "⏳ Esperando a");
  assert.equal(store.available().esperando.length, 1);
});

test("una fecha límite conserva su día aunque ya sea otro día en UTC", () => {
  const { store } = fresh();
  const task = store.create({ name: "X", due: "2026-11-09" });
  assert.equal(task.due, "2026-11-09");
  assert.equal(store.available().accionables[0].due, "2026-11-09");
});

test("no inventa proyectos ni tags", () => {
  const { store } = fresh();
  assert.throws(() => store.create({ name: "X", project: "Peptilab" }), /No existe el proyecto/);
  assert.throws(() => store.create({ name: "X", tags: ["Nuevo"] }), /No existe el tag/);
});

test("valida nombre, fechas y minutos", () => {
  const { store } = fresh();
  assert.throws(() => store.create({ name: "  " }), /nombre/);
  assert.throws(() => store.create({ name: "X", due: "mañana" }), /fecha/);
  assert.throws(() => store.create({ name: "X", estimated_minutes: -1 }), /minutos/);
});

test("buscar ignora acentos, incluidos los que vienen descompuestos", () => {
  const { store } = fresh();
  store.create({ name: "Revisar nómina" });
  store.create({ name: "Otra", note: "tema de la nómina de Citi".normalize("NFD") });
  assert.equal(store.search({ query: "nomina" }).total, 2);
  assert.equal(store.search({ query: "nomina citi" }).total, 1);
});

test("completar saca de la cola, y buscar lo encuentra solo si se pide", () => {
  const { store } = fresh();
  const task = store.create({ name: "Hecha" });
  store.complete({ id: task.id });
  assert.equal(store.available().totalAccionables, 0);
  assert.equal(store.search({ query: "hecha" }).total, 0);
  assert.equal(store.search({ query: "hecha", include_done: true }).total, 1);
  store.reopen({ id: task.id });
  assert.equal(store.available().totalAccionables, 1);
});

test("las repetitivas crean la siguiente al completarse, conservando la distancia entre fechas", () => {
  const { store } = fresh();
  const task = store.create({ name: "Revisión", due: "2026-11-10", defer: "2026-11-09", repeat: "FREQ=WEEKLY;INTERVAL=1" });
  store.complete({ id: task.id });
  const next = store.list({ view: "deferred" }).find((item) => item.n === "Revisión");
  assert.equal(next.due, "2026-11-17");
  assert.equal(next.defer, "2026-11-16");
  assert.equal(nextOccurrence("FREQ=RARA", new Date(NOW)), null);
});

test("la cola de Claude excluye esperas y va por urgencia", () => {
  const { store } = fresh();
  store.create({ name: "Sin fecha", tags: ["🤖 Claude"], estimated_minutes: 5 });
  store.create({ name: "Con fecha", tags: ["🤖 Claude"], due: "2026-11-11" });
  store.create({ name: "Espera", tags: ["🤖 Claude"], waiting_for: "Franky" });
  store.create({ name: "No Claude" });
  assert.deepEqual(store.claudeQueue().map((task) => task.n), ["Con fecha", "Sin fecha"]);
});

test("higiene: zombies, esperas viejas y proyectos sin acción", () => {
  let current = NOW - 40 * 86_400_000;
  const { store } = fresh(() => current);
  store.create({ name: "Zombie", project: "Atlas" });
  store.create({ name: "Con fecha", project: "Atlas", due: "2026-12-30" });
  store.create({ name: "Parqueada", project: "Atlas", tags: ["💤 Algún día"] });
  store.create({ name: "Espera", project: "Atlas", waiting_for: "Franky" });
  current = NOW;
  const report = store.hygiene();
  assert.deepEqual(report.zombies.map((task) => task.n), ["Zombie"]);
  assert.deepEqual(report.esperasViejas.map((task) => task.n), ["Espera"]);
  assert.deepEqual(report.proyectosSinAccion.map((project) => project.n), ["Orion"]);
  assert.ok(report.dominiosSinActividad30d.includes("🚌 Nube"));
});

test("importar dos veces actualiza sin duplicar, y conserva las fechas originales", () => {
  const { store } = fresh();
  const tasks = [{ ofId: "of1", name: "De OF".normalize("NFD"), project: "Atlas", tags: ["🎯 MIT"], estimatedMinutes: 10, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" }];
  assert.equal(store.importOmniFocus({ tasks }).created, 1);
  const second = store.importOmniFocus({ tasks });
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  const [row] = store.list({ view: "available" });
  assert.equal(row.n, "De OF".normalize("NFC"));
  assert.equal(row.mit, true);
  assert.ok(store.hygiene().zombies.length === 1);
});

test("los datos sobreviven al reinicio, con permisos privados y respaldo", async () => {
  const { store, path } = fresh();
  store.create({ name: "Persistente" });
  store.create({ name: "Otra" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(createTaskStore({ path, now: () => NOW }).summary().available, 2);
  assert.ok(JSON.parse(await readFile(`${path}.bak`, "utf8")).tasks);
});

test("un archivo dañado no se reemplaza por una lista vacía", async () => {
  const path = join(dir, "roto.json");
  await writeFile(path, "{ dañado");
  assert.throws(() => createTaskStore({ path }), /respaldo/);
  assert.equal(await readFile(path, "utf8"), "{ dañado");
});

test("la otra computadora comparte la lista, y un equipo ajeno no entra", async () => {
  const { store } = fresh();
  let caller = "owner";
  const hub = createTasksHub({ store, port: 47877, owner: "owner", identify: () => caller });
  await hub.start();
  const remote = createRemoteTasks({ host: "127.0.0.1", port: 47877 });
  try {
    const created = await remote.create({ name: "Desde la M4", project: "Atlas" });
    assert.equal(store.available().accionables[0].id, created.id);
    await assert.rejects(remote.create({ name: "X", project: "No existe" }), /No existe el proyecto/);
    caller = "otro";
    await assert.rejects(remote.summary(), /no pertenece/);
    caller = null;
    await assert.rejects(remote.summary(), /no pertenece/);
    caller = "owner";
    const bad = await fetch("http://127.0.0.1:47877/tasks", { method: "POST", body: JSON.stringify({ op: "importOmniFocus", args: {} }) });
    assert.equal(bad.status, 400);
  } finally {
    await hub.stop();
  }
  await assert.rejects(createRemoteTasks({ host: "127.0.0.1", port: 47878 }).summary(), /No se puede llegar/);
});

test("la identidad viene de Tailscale, y sin ella nadie entra", async () => {
  assert.equal(identifyFromServe({ headers: { "tailscale-user-login": "a@x.com" } }), "a@x.com");
  assert.equal(identifyFromServe({ headers: {} }), null);
  assert.equal(loginFromStatus({ Self: { UserID: 7 }, User: { 7: { LoginName: "a@x.com" } } }), "a@x.com");
  assert.equal(loginFromStatus({}), null);
  const { store } = fresh();
  const hub = createTasksHub({ store, port: 47879, owner: "a@x.com" });
  await hub.start();
  try {
    const call = (headers) => fetch("http://127.0.0.1:47879/tasks", { method: "POST", headers, body: JSON.stringify({ op: "summary" }) });
    assert.equal((await call({})).status, 403);
    assert.equal((await call({ "tailscale-user-login": "otro@x.com" })).status, 403);
    assert.equal((await call({ "tailscale-user-login": "a@x.com" })).status, 200);
  } finally {
    await hub.stop();
  }
});

test("Yo o Claude: una sola marca que entra y sale sin tocar otros tags", () => {
  const { store } = fresh();
  const task = store.create({ name: "X", tags: ["🎯 MIT"], for_claude: true });
  assert.deepEqual(task.tags.sort(), ["🎯 MIT", "🤖 Claude"].sort());
  assert.equal(task.claude, true);
  assert.equal(store.claudeQueue().length, 1);
  const mine = store.update({ id: task.id, for_claude: false });
  assert.deepEqual(mine.tags, ["🎯 MIT"]);
  assert.equal(store.claudeQueue().length, 0);
});

test("una lista nueva ya trae la marca de Claude", () => {
  const store = createTaskStore({ path: join(dir, "nueva.json"), now: () => NOW });
  assert.equal(store.create({ name: "X", for_claude: true }).claude, true);
});

test("pronóstico: vencidas en pasado, y cada tarea en su día", () => {
  const { store } = fresh();
  store.create({ name: "Vencida", due: "2026-11-05" });
  store.create({ name: "Hoy", due: "2026-11-10" });
  store.create({ name: "Planeada", planned: "2026-11-12" });
  store.create({ name: "Lejana", due: "2027-06-01" });
  store.create({ name: "Sin fecha" });
  const result = store.forecast({ days: 14 });
  assert.equal(result.today, "2026-11-10");
  assert.deepEqual(result.past.map((task) => task.n), ["Vencida"]);
  assert.deepEqual(result.days[0].tasks.map((task) => task.n), ["Hoy"]);
  assert.deepEqual(result.days[2].tasks.map((task) => task.n), ["Planeada"]);
  assert.equal(result.future, 1);
});

test("consultas: bandera, proyecto, tag con sus hijos y perspectivas", () => {
  const { store } = fresh();
  store.create({ name: "Con bandera", flagged: true, project: "Atlas" });
  store.create({ name: "Espera", waiting_for: "Franky" });
  store.create({ name: "Profunda", tags: ["🔥 Profundo"] });
  assert.deepEqual(store.query({ kind: "flagged" }).map((task) => task.n), ["Con bandera"]);
  assert.deepEqual(store.query({ kind: "project", value: "Atlas" }).map((task) => task.n), ["Con bandera"]);
  assert.deepEqual(store.query({ kind: "tag", value: "⏳ Esperando a" }).map((task) => task.n), ["Espera"]);
  assert.deepEqual(store.query({ kind: "deep" }).map((task) => task.n), ["Profunda"]);
  assert.deepEqual(store.query({ kind: "hoy" }).map((task) => task.n), ["Con bandera"]);
  assert.throws(() => store.query({ kind: "rara" }), /desconocida/);
});

test("revisión: aparece cuando toca, y al marcarla se programa la siguiente", () => {
  let current = NOW;
  const { store } = fresh(() => current);
  store.updateProject({ name: "Atlas", review_days: 7 });
  assert.equal(store.reviewList().length, 0);
  current = NOW + 8 * 86_400_000;
  assert.deepEqual(store.reviewList().map((project) => project.name), ["Atlas"]);
  assert.equal(store.catalog().counts.review, 1);
  store.markReviewed({ name: "Atlas" });
  assert.equal(store.reviewList().length, 0);
});

test("renombrar un proyecto lleva sus tareas consigo", () => {
  const { store } = fresh();
  store.create({ name: "X", project: "Atlas" });
  store.updateProject({ name: "Atlas", rename: "Atlas 2" });
  assert.equal(store.query({ kind: "project", value: "Atlas 2" }).length, 1);
  assert.throws(() => store.updateProject({ name: "Atlas 2", rename: "Orion" }), /Ya existe/);
});

test("reimportar solo campos nuevos no pisa lo editado en SMCP", () => {
  const { store } = fresh();
  store.importOmniFocus({ tasks: [{ ofId: "a", name: "Original", project: "Atlas" }] });
  const [row] = store.query({ kind: "project", value: "Atlas" });
  store.update({ id: row.id, name: "Editada" });
  const result = store.importOmniFocus({
    schemaOnly: true,
    projects: [{ name: "Atlas", reviewDays: 14, nextReview: "2026-11-01T00:00:00.000Z" }],
    tasks: [{ ofId: "a", name: "Original", planned: "2026-11-20T08:00:00.000Z" }],
  });
  assert.equal(result.tasksUpdated, 1);
  const [after] = store.query({ kind: "project", value: "Atlas" });
  assert.equal(after.n, "Editada");
  assert.equal(after.planned, "2026-11-20");
  assert.equal(store.reviewList().length, 1);
});

test("archivar todo deja la lista vacía y es reversible, tarea por tarea", () => {
  const { store } = fresh();
  const task = store.create({ name: "Vieja", project: "Atlas" });
  store.create({ name: "Otra", project: "Orion" });
  const done = store.create({ name: "Hecha" });
  store.complete({ id: done.id });
  assert.deepEqual({ tasks: 2, projects: 3 }, (({ tasks, projects }) => ({ tasks, projects }))(store.archiveAll()));
  assert.equal(store.available().totalAccionables, 0);
  assert.equal(store.search({ query: "vieja" }).total, 0);
  assert.equal(store.query({ kind: "archive" }).length, 2);
  assert.equal(store.query({ kind: "completed" }).length, 1);
  assert.ok(Object.values(store.catalog().folders).flat().every((project) => project.status === "dropped"));
  store.reopen({ id: task.id });
  assert.equal(store.available().accionables[0].n, "Vieja");
  assert.equal(store.query({ kind: "project", value: "Atlas" }).length, 1);
  assert.equal(Object.values(store.catalog().folders).flat().find((project) => project.name === "Atlas").status, "active");
  assert.equal(Object.values(store.catalog().folders).flat().find((project) => project.name === "Orion").status, "dropped");
});

test("restaurar un proyecto recupera el estado que tenía", () => {
  const { store } = fresh();
  store.archiveAll();
  store.restoreProject({ name: "Pausado" });
  assert.equal(Object.values(store.catalog().folders).flat().find((project) => project.name === "Pausado").status, "onhold");
});

test("archivar todo no se puede pedir desde otra computadora", () => {
  assert.ok(!TASK_OPERATIONS.includes("archiveAll"));
});

test("Hoy incluye lo planeado para hoy", () => {
  const { store } = fresh();
  store.create({ name: "Planeada", planned: "2026-11-10" });
  store.create({ name: "Otro día", planned: "2026-11-20" });
  assert.deepEqual(store.query({ kind: "hoy" }).map((task) => task.n), ["Planeada"]);
});

test("permisos: grupo propio, solo lectura bloquea escribir, y el teléfono solo lee", () => {
  assert.equal(toolGroup("tasks_create"), "tasks");
  const policy = { paused: false, readOnly: true, disabled: { tasks: false } };
  assert.match(denialFor("tasks_create", { destructiveHint: true }, policy), /solo lectura/);
  assert.equal(denialFor("tasks_available", { readOnlyHint: true }, policy), null);
  assert.ok(REMOTE_TOOLS.has("tasks_available"));
  for (const name of ["tasks_create", "tasks_update", "tasks_complete", "tasks_append_note"]) assert.ok(!REMOTE_TOOLS.has(name), name);
});
