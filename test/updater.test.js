import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SWAP_SCRIPT, createUpdater, isNewer, readSignedManifest } from "../app/core/updater.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ type: "spki", format: "pem" });
const signed = (text) => sign(null, Buffer.from(text), privateKey).toString("base64");
const ZIP = Buffer.from("contenido del zip");
const SHA = createHash("sha256").update(ZIP).digest("hex");
const manifestFor = (version, build = {}) =>
  JSON.stringify({ version, mac: { arm64: { file: `SMCP-${version}-mac-arm64.zip`, sha256: SHA, size: ZIP.length, ...build } } });

function response(body, status = 200) {
  return new Response(body, { status });
}

function fakeFetch(text, signature = signed(text), zip = ZIP) {
  return async (url) => {
    if (url.endsWith("latest.json")) return response(text);
    if (url.endsWith("latest.json.sig")) return response(signature);
    return response(zip);
  };
}

function updater(overrides = {}) {
  const temp = mkdtempSync(join(tmpdir(), "smcp-updater-test-"));
  const calls = { swap: [], quit: 0 };
  const instance = createUpdater({
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    appBundle: join(temp, "SMCP.app"),
    tempRoot: temp,
    bundleId: "com.example.smcp",
    quit: () => (calls.quit += 1),
    publicKey: PUBLIC,
    run: async (command, args) => {
      if (command === "plutil") return { stdout: args[1] === "CFBundleIdentifier" ? "com.example.smcp\n" : "0.2.0\n" };
      return { stdout: "" };
    },
    startSwap: (script, args) => calls.swap.push({ script, args }),
    ...overrides,
  });
  return { instance, calls };
}

test("compara versiones como números, no como texto", () => {
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.0.9", "0.1.0"), false);
  assert.equal(isNewer("mala", "0.1.0"), false);
});

test("rechaza un manifiesto alterado o con otra llave", () => {
  const text = manifestFor("0.2.0");
  assert.equal(readSignedManifest(text, signed(text), PUBLIC).version, "0.2.0");
  assert.throws(() => readSignedManifest(text.replace("0.2.0", "9.9.9"), signed(text), PUBLIC), /signature/);
  const other = generateKeyPairSync("ed25519").privateKey;
  assert.throws(() => readSignedManifest(text, sign(null, Buffer.from(text), other).toString("base64"), PUBLIC), /signature/);
});

test("rechaza nombres de archivo que podrían salir de la carpeta de descargas", () => {
  const text = manifestFor("0.2.0", { file: "../../evil.zip" });
  assert.throws(() => readSignedManifest(text, signed(text), PUBLIC), /incomplete/);
});

test("no ofrece una versión igual o anterior", async () => {
  const text = manifestFor("0.1.0");
  const { instance } = updater({ fetchImpl: fakeFetch(text) });
  assert.equal((await instance.check()).status, "latest");
});

test("una firma mala se reporta y no permite instalar", async () => {
  const text = manifestFor("0.2.0");
  const { instance, calls } = updater({ fetchImpl: fakeFetch(text, signed("otra cosa")) });
  const state = await instance.check();
  assert.equal(state.status, "error");
  assert.equal(state.canInstall, false);
  await instance.install();
  assert.equal(calls.quit, 0);
});

test("instala solo si la descarga coincide con la versión firmada", async () => {
  const text = manifestFor("0.2.0");
  const good = updater({ fetchImpl: fakeFetch(text) });
  assert.equal((await good.instance.check()).status, "available");
  await good.instance.install({ background: true });
  assert.equal(good.calls.quit, 1);
  assert.equal(good.calls.swap[0].args[3], "background");

  const bad = updater({ fetchImpl: fakeFetch(text, signed(text), Buffer.from("x".repeat(ZIP.length))) });
  await bad.instance.check();
  const state = await bad.instance.install();
  assert.equal(state.status, "error");
  assert.equal(bad.calls.quit, 0);
  assert.equal(bad.calls.swap.length, 0);
});

test("reports download progress up to 100 and clears it before verifying", async () => {
  const text = manifestFor("0.2.0");
  const seen = [];
  const { instance } = updater({ fetchImpl: fakeFetch(text), onChange: (state) => seen.push(state.progress) });
  await instance.check();
  await instance.install();
  assert.equal(seen.includes(0), true);
  assert.equal(seen.includes(100), true);
  assert.equal(seen.at(-1), null);
});

test("en Windows avisa de la versión nueva sin intentar instalarla", async () => {
  const text = manifestFor("0.2.0");
  const { instance } = updater({ platform: "win32", arch: "x64", fetchImpl: fakeFetch(text) });
  const state = await instance.check();
  assert.equal(state.status, "available");
  assert.equal(state.canInstall, false);
});

test("el cambio de app reemplaza el paquete y la vuelve a abrir", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "smcp-swap-test-"));
  const target = join(root, "SMCP.app");
  const fresh = join(root, "work", "SMCP.app");
  mkdirSync(target, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(target, "version"), "vieja");
  writeFileSync(join(fresh, "version"), "nueva");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const opened = join(root, "opened");
  writeFileSync(join(bin, "open"), `#!/bin/sh\necho "$@" > "${opened}"\n`, { mode: 0o755 });
  const script = join(root, "swap.sh");
  writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
  const gone = spawn("/usr/bin/true");
  await new Promise((resolve) => gone.on("exit", resolve));
  execFileSync("/bin/sh", [script, String(gone.pid), fresh, target, "background", join(root, "work")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(readFileSync(join(target, "version"), "utf8"), "nueva");
  assert.match(readFileSync(opened, "utf8"), /--background/);
  assert.equal(existsSync(join(root, "work")), false);
});

test("reintenta cuando GitHub responde 504 y luego encuentra la versión", async () => {
  const text = manifestFor("0.2.0");
  const ok = fakeFetch(text);
  let failures = 2;
  const waits = [];
  const { instance } = updater({
    fetchImpl: async (url) => (url.endsWith("latest.json") && failures-- > 0 ? response("", 504) : ok(url)),
    sleep: async (ms) => waits.push(ms),
  });
  const result = await instance.check();
  assert.equal(result.status, "available");
  assert.equal(waits.length, 2);
});

test("reintenta un fallo de red y se rinde con un mensaje claro si GitHub sigue caído", async () => {
  let calls = 0;
  const { instance } = updater({
    fetchImpl: async (url) => {
      calls += 1;
      if (url.endsWith(".sig")) throw new TypeError("fetch failed");
      return response("", 504);
    },
    sleep: async () => {},
  });
  const result = await instance.check();
  assert.equal(result.status, "error");
  assert.equal(calls, 6);
});

test("no reintenta un 404", async () => {
  let calls = 0;
  const waits = [];
  const { instance } = updater({
    fetchImpl: async () => (calls++, response("", 404)),
    sleep: async (ms) => waits.push(ms),
  });
  const result = await instance.check();
  assert.match(result.message, /GitHub responded 404/);
  assert.equal(waits.length, 0);
});

test("el mensaje de 504 persistente dice que GitHub no responde", async () => {
  const { instance } = updater({ fetchImpl: async () => response("", 504), sleep: async () => {} });
  assert.match((await instance.check()).message, /GitHub is not responding right now \(504\)/);
});
