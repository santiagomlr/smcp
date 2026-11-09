import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { downloadModel } from "../app/core/whisper.js";
import { denialFor } from "../src/policy.js";
import { createWhatsApp } from "../src/tools/whatsapp.js";

const JID = "5215512345678@s.whatsapp.net";
const LOCAL = { readOnlyHint: false, destructiveHint: false };
const allOn = { whatsapp: false, gmail: false, notes: false, tasks: false, files: false, terminal: false, apps: false };
const policy = (whatsapp) => ({ paused: false, readOnly: false, disabled: { ...allOn }, whatsapp });
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" });

let dir;
const saved = {};
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-audio-test-"));
  for (const key of ["WHISPER_BIN", "WHISPER_MODEL"]) saved[key] = process.env[key];
  process.env.WHISPER_BIN = join(dir, "whisper-cli");
  process.env.WHISPER_MODEL = join(dir, "modelo.bin");
  await writeFile(process.env.WHISPER_BIN, "");
  await chmod(process.env.WHISPER_BIN, 0o755);
  await writeFile(process.env.WHISPER_MODEL, "listo");
});
after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

function pipeline({ show = { MediaType: "audio", SenderName: "Ana", Timestamp: "2026-11-08T10:00:00Z" }, whisper = { code: 0, stdout: " Hola, ¿cómo estás?\n", stderr: "" }, download = ok({ path: "x" }) } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (args.includes("show")) return show ? ok(show) : { code: 1, stdout: "", stderr: "no rows" };
    if (args.includes("media")) return download;
    if (file === "/usr/bin/afconvert") return { code: 0, stdout: "", stderr: "" };
    return whisper;
  };
  return { calls, ...createWhatsApp({ exec }) };
}

const audioFolder = (calls) => {
  const output = calls.find(({ args }) => args.includes("media")).args.find((arg) => arg.startsWith("--output=")).slice(9);
  return output.slice(0, output.lastIndexOf("/"));
};

test("escuchar audios está apagado hasta encenderlo, y necesita leer", () => {
  const name = "whatsapp_transcribe_audio";
  assert.match(denialFor(name, LOCAL, policy({ read: true, send: true, audio: false })), /Escuchar audios de WhatsApp está apagado/);
  assert.match(denialFor(name, LOCAL, policy({ read: false, send: false, audio: true })), /Leer los chats.*necesita/);
  assert.equal(denialFor(name, LOCAL, policy({ read: true, send: false, audio: true })), null);
  assert.equal(denialFor(name, LOCAL, { ...policy({ read: true, audio: true }), readOnly: true }), null);
});

test("transcribe localmente, marca el texto como externo y borra el audio", async () => {
  const { calls, transcribe } = pipeline();
  const result = await transcribe({ chat: JID, id: "ABC123DEF" });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body._untrusted_external, true);
  assert.equal(body.data.transcript, "Hola, ¿cómo estás?");
  assert.equal(body.data.sender, "Ana");
  const download = calls.find(({ args }) => args.includes("media"));
  assert.ok(download.args.includes("--read-only"));
  const whisper = calls.at(-1);
  assert.equal(whisper.file, process.env.WHISPER_BIN);
  assert.deepEqual(whisper.args.slice(0, 2), ["-m", process.env.WHISPER_MODEL]);
  assert.equal(existsSync(audioFolder(calls)), false);
});

test("usa el idioma pedido y avisa si no hay voz", async () => {
  const { calls, transcribe } = pipeline({ whisper: { code: 0, stdout: " [BLANK_AUDIO]\n", stderr: "" } });
  const result = await transcribe({ chat: JID, id: "ABC123DEF", language: "es" });
  assert.ok(calls.at(-1).args.join(" ").includes("-l es"));
  assert.match(result.content[0].text, /no se detectó voz/);
});

test("rechaza mensajes que no son audio sin descargarlos", async () => {
  const { calls, transcribe } = pipeline({ show: { MediaType: "image" } });
  const result = await transcribe({ chat: JID, id: "ABC123DEF" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no es un audio/);
  assert.ok(!calls.some(({ args }) => args.includes("media")));
});

test("una transcripción que falla también borra el audio", async () => {
  const { calls, transcribe } = pipeline({ whisper: { code: 1, stdout: "", stderr: "boom" } });
  const result = await transcribe({ chat: JID, id: "ABC123DEF" });
  assert.equal(result.isError, true);
  assert.equal(existsSync(audioFolder(calls)), false);
});

test("sin el modelo, dice dónde encenderlo", async () => {
  process.env.WHISPER_MODEL = join(dir, "no-existe.bin");
  try {
    const { calls, transcribe } = pipeline();
    const result = await transcribe({ chat: JID, id: "ABC123DEF" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Ajustes/);
    assert.equal(calls.length, 0);
  } finally {
    process.env.WHISPER_MODEL = join(dir, "modelo.bin");
  }
});

async function withServer(body, fn) {
  const server = createServer((_request, response) => response.end(body));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/m.bin`);
  } finally {
    server.close();
  }
}

test("el modelo solo se guarda si la suma coincide, con avance por porcentaje entero", async () => {
  const body = Buffer.alloc(300_000, 7);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const path = join(dir, "bueno", "modelo.bin");
  const seen = [];
  await withServer(body, (url) => downloadModel({ url, bytes: body.length, sha256, path, onProgress: (percent) => seen.push(percent) }));
  assert.deepEqual(await readFile(path), body);
  assert.equal(existsSync(`${path}.part`), false);
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.every((percent) => percent <= 99));
});

test("un modelo dañado o una descarga cancelada no dejan nada", async () => {
  const body = Buffer.alloc(1000, 1);
  const path = join(dir, "malo", "modelo.bin");
  await withServer(body, (url) => assert.rejects(downloadModel({ url, bytes: body.length, sha256: "0".repeat(64), path }), /dañado/));
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.part`), false);
  const stop = new AbortController();
  stop.abort();
  await withServer(body, (url) => assert.rejects(downloadModel({ url, bytes: body.length, sha256: "0".repeat(64), path, signal: stop.signal })));
  assert.equal(existsSync(path), false);
});
