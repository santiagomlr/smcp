import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { requestHelper, startHelper, viaHelper } from "../src/helper.js";

let dir;
let server;
let path;
const noLaunch = async () => {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-helper-"));
  path = join(dir, "h.sock");
  server = await startHelper(
    {
      echo: async (params) => params,
      fail: async () => {
        throw new Error("falló");
      },
    },
    path,
  );
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test("el socket solo lo puede abrir el usuario dueño", async () => {
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("responde y conserva acentos y saltos de línea", async () => {
  assert.deepEqual(await requestHelper("echo", { a: "ñandú\ný" }, { path }), { a: "ñandú\ný" });
});

test("rechaza operaciones que no están en la lista, incluidas las heredadas", async () => {
  await assert.rejects(requestHelper("borrar", {}, { path }), /desconocida/);
  await assert.rejects(requestHelper("constructor", {}, { path }), /desconocida/);
});

test("un error de la operación se reporta y no cae al modo local", async () => {
  let usedLocal = false;
  const local = async () => {
    usedLocal = true;
  };
  await assert.rejects(viaHelper("fail", {}, local, { path, launch: noLaunch }), /falló/);
  assert.equal(usedLocal, false);
});

test("con SMCP abierto no usa el modo local", async () => {
  const value = await viaHelper("echo", 7, async () => "local", { path, launch: noLaunch });
  assert.equal(value, 7);
});

test("sin SMCP intenta abrirlo y luego usa el modo local", async () => {
  let launched = 0;
  const value = await viaHelper("echo", 7, async () => "local", {
    path: join(dir, "no-existe.sock"),
    launch: async () => {
      launched += 1;
    },
  });
  assert.equal(value, "local");
  assert.equal(launched, 1);
});

test("si SMCP abre mientras espera, usa SMCP", async () => {
  const late = join(dir, "tarde.sock");
  let lateServer;
  const value = await viaHelper("echo", 7, async () => "local", {
    path: late,
    launch: async () => {
      lateServer = await startHelper({ echo: async (params) => params }, late);
    },
  });
  assert.equal(value, 7);
  await new Promise((resolve) => lateServer.close(resolve));
});

test("un socket viejo no impide arrancar", async () => {
  const stale = join(dir, "viejo.sock");
  await writeFile(stale, "");
  const fresh = await startHelper({ echo: async (params) => params }, stale);
  assert.equal(await requestHelper("echo", 1, { path: stale }), 1);
  await new Promise((resolve) => fresh.close(resolve));
});
