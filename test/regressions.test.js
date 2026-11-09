// One test per bug found in the review of November 2026.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openImap } from "../app/core/gmail.js";
import { createRemote } from "../app/core/remote.js";
import { createRemoteTasks } from "../app/core/tasks-hub.js";
import { createTaskStore, nextOccurrence } from "../app/core/tasks.js";
import { retry } from "../app/core/throttle.js";
import { failureDetail } from "../app/core/whatsapp.js";
import { createConfirmGate } from "../src/confirm-gate.js";
import { readPolicy } from "../src/policy.js";
import { localJxa } from "../src/tools/apps.js";
import { isBlocked } from "../src/tools/files.js";

const NOW = new Date("2026-11-08T12:00:00").getTime();
const tempFile = async (name) => join(await mkdtemp(join(tmpdir(), "smcp-test-")), name);
const store = async () => createTaskStore({ path: await tempFile("tasks.json"), now: () => NOW });

test("el secreto de un cliente remoto no vence, tampoco el de uno ya registrado", async () => {
  const statePath = await tempFile("remote.json");
  await writeFile(statePath, JSON.stringify({ clients: { viejo: { client_id: "viejo", client_secret_expires_at: 1 } }, tokens: {} }));
  const remote = createRemote({ baseUrl: "https://example.test", buildServer: () => null, statePath, port: 0 });
  const port = await remote.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const refresh = (body) =>
      fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "no-existe", ...body }) }).then((response) => response.json());

    const created = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Prueba", redirect_uris: ["https://example.test/cb"], token_endpoint_auth_method: "client_secret_post" }) })).json();
    assert.equal(created.client_secret_expires_at, 0);

    const real = Date.now;
    Date.now = () => real() + 31 * 86_400_000;
    try {
      assert.equal((await refresh({ client_id: created.client_id, client_secret: created.client_secret })).error, "invalid_grant");
    } finally {
      Date.now = real;
    }
  } finally {
    await remote.stop();
  }
});

test("una conexión caída de Gmail no es una excepción sin capturar", () => {
  const client = openImap({ email: "a@example.test", password: "x" });
  assert.equal(client.listenerCount("error"), 1);
});

test("durante una confirmación se rechazan clics y teclas, y se siguen permitiendo lecturas", async () => {
  const gate = createConfirmGate();
  const calls = [];
  const exec = async (_file, args) => {
    calls.push(args);
    return { code: 0, stdout: "{}", stderr: "" };
  };
  let close;
  const open = gate.confirm(() => new Promise((resolve) => (close = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  for (const name of ["clickPath", "clickAt", "type", "key"]) {
    assert.match((await localJxa(name, {}, 1000, { gate, exec })).error, /confirmation/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await localJxa("tree", {}, 1000, { gate, exec }), { value: {} });
  close();
  await open;
  assert.deepEqual(await localJxa("key", {}, 1000, { gate, exec }), { value: {} });
});

test("una confirmación espera a que termine la acción de pantalla en curso", async () => {
  const gate = createConfirmGate();
  const order = [];
  let finish;
  const action = gate.act(async () => {
    await new Promise((resolve) => (finish = resolve));
    order.push("acción");
  });
  const dialog = gate.confirm(async () => order.push("ventana"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  finish();
  await Promise.all([action, dialog]);
  assert.deepEqual(order, ["acción", "ventana"]);
});

test("terminal y control de apps empiezan apagados, sin cambiar lo que la persona ya guardó", async () => {
  const fresh = readPolicy(await tempFile("no-existe.json"));
  assert.equal(fresh.disabled.terminal, true);
  assert.equal(fresh.disabled.apps, true);
  const path = await tempFile("config.json");
  await writeFile(path, JSON.stringify({ disabled: { terminal: false, apps: false } }));
  assert.equal(readPolicy(path).disabled.terminal, false);
  assert.equal(readPolicy(path).disabled.apps, false);
});

test("las credenciales de otras herramientas están bloqueadas", () => {
  for (const path of [".config/gh/hosts.yml", ".zsh_history", ".claude/.credentials.json", ".pc-remote/config.json", "Library/Application Support/smcp/settings.json"]) {
    assert.equal(isBlocked(join(homedir(), path)), true, path);
  }
  assert.equal(isBlocked(join(homedir(), "Documents", "nota.txt")), false);
});

test("deshacer una tarea repetitiva quita la siguiente, salvo que ya se haya tocado", async () => {
  const tasks = await store();
  const untouched = tasks.create({ name: "semanal", due: "2026-11-08", repeat: "FREQ=WEEKLY" });
  tasks.complete({ id: untouched.id });
  tasks.reopen({ id: untouched.id });
  assert.deepEqual(tasks.list({ view: "all" }).map((task) => task.due), ["2026-11-08"]);

  tasks.complete({ id: untouched.id });
  const next = tasks.list({ view: "all" })[0];
  let later = NOW;
  const edited = createTaskStore({ path: await tempFile("tasks.json"), now: () => later });
  const original = edited.create({ name: "semanal", due: "2026-11-08", repeat: "FREQ=WEEKLY" });
  edited.complete({ id: original.id });
  const copy = edited.list({ view: "all" })[0];
  later += 60_000;
  edited.appendNote({ id: copy.id, text: "ya avancé" });
  edited.reopen({ id: original.id });
  assert.equal(edited.list({ view: "all" }).length, 2);
  assert.equal(next.due, "2026-11-15");
});

test("una repetición avanza también la fecha planeada", async () => {
  const tasks = await store();
  const task = tasks.create({ name: "x", due: "2026-11-08", planned: "2026-11-08", repeat: "FREQ=WEEKLY" });
  tasks.complete({ id: task.id });
  assert.equal(tasks.list({ view: "all" })[0].planned, "2026-11-15");
});

test("una repetición mensual se queda en el mes siguiente", () => {
  const next = new Date(nextOccurrence("FREQ=MONTHLY", new Date("2026-01-31T23:59:00")));
  assert.deepEqual([next.getMonth(), next.getDate()], [1, 28]);
  const leap = new Date(nextOccurrence("FREQ=YEARLY", new Date("2028-02-29T08:00:00")));
  assert.deepEqual([leap.getMonth(), leap.getDate()], [1, 28]);
});

test("una edición rechazada no cambia nada", async () => {
  const tasks = await store();
  const task = tasks.create({ name: "original" });
  assert.throws(() => tasks.update({ id: task.id, name: "cambiado", waiting_for: "Ana", due: "basura" }));
  assert.equal(tasks.get({ id: task.id }).n, "original");
  assert.equal(tasks.listProjects().tags.some((tag) => tag.name === "Ana"), false);

  assert.throws(() => tasks.create({ name: "otra", waiting_for: "Beto", due: "basura" }));
  assert.equal(tasks.listProjects().tags.some((tag) => tag.name === "Beto"), false);

  tasks.createProject({ name: "P", folder: "A" });
  assert.throws(() => tasks.updateProject({ name: "P", folder: "B", review_days: 9999 }));
  assert.equal(Object.keys(tasks.listProjects().folders).includes("B"), false);
});

test("un proyecto archivado sale de Próximo y de la búsqueda, y se puede restaurar", async () => {
  const tasks = await store();
  tasks.createProject({ name: "P" });
  tasks.create({ name: "pendiente", project: "P", due: "2026-11-01" });
  tasks.updateProject({ name: "P", status: "dropped" });
  assert.equal(tasks.forecast({ days: 30 }).past.length, 0);
  assert.equal(tasks.catalog().counts.forecast, 0);
  assert.equal(tasks.search({ query: "pendiente" }).total, 0);
  tasks.restoreProject({ name: "P" });
  assert.equal(tasks.forecast({ days: 30 }).past.length, 1);
});

test("lo planeado para un día pasado sigue visible en hoy y no cuenta como vencido", async () => {
  const tasks = await store();
  tasks.create({ name: "planeada ayer", planned: "2026-11-07" });
  const forecast = tasks.forecast({ days: 30 });
  assert.equal(forecast.past.length, 0);
  assert.equal(forecast.days[0].tasks.length, 1);
});

test("MIT es una palabra completa", async () => {
  const tasks = await store();
  tasks.createTag({ name: "Comité" });
  tasks.createTag({ name: "🎯 MIT" });
  assert.equal(tasks.create({ name: "a", tags: ["Comité"] }).mit, false);
  assert.equal(tasks.create({ name: "b", waiting_for: "Smith" }).mit, false);
  assert.equal(tasks.create({ name: "c", tags: ["🎯 MIT"] }).mit, true);
});

test("un id como __proto__ no existe", async () => {
  const tasks = await store();
  assert.throws(() => tasks.appendNote({ id: "__proto__", text: "x" }), /does not exist/);
  assert.equal({}.note, undefined);
});

test("una fecha que no existe se rechaza", async () => {
  const tasks = await store();
  assert.throws(() => tasks.create({ name: "x", due: "2026-02-31" }), /not valid/);
  assert.equal(tasks.create({ name: "y", due: "2028-02-29" }).due, "2028-02-29");
});

test("una respuesta que no es JSON da el mensaje claro", async () => {
  const remote = createRemoteTasks({ host: "x", fetchImpl: async () => new Response("", { status: 502 }) });
  await assert.rejects(remote.summary(), /Cannot reach/);
});

test("wacli con success:false y código 0 cuenta como fallo", () => {
  assert.equal(failureDetail({ code: 0, stdout: '{"success":false,"error":"sin sesión"}' }), "sin sesión");
  assert.equal(failureDetail({ code: 1, stderr: '{"error":"bloqueado"}' }), "bloqueado");
  assert.equal(failureDetail({ code: 0, stdout: '{"success":true}' }), null);
  assert.equal(failureDetail({ code: null }), "");
});

test("retry reintenta y al final entrega el último error", async () => {
  let calls = 0;
  const wait = async () => {};
  assert.equal(await retry(async () => (++calls < 3 ? Promise.reject(new Error("aún no")) : "listo"), { attempts: 5, wait }), "listo");
  assert.equal(calls, 3);
  await assert.rejects(retry(async () => { throw new Error("nunca"); }, { attempts: 2, wait }), /nunca/);
});
