import assert from "node:assert/strict";
import { test } from "node:test";
import { createWhatsApp, isValidRecipient } from "../src/tools/whatsapp.js";

const JID = "5215512345678@s.whatsapp.net";

function fakeExec(handler = () => ({ code: 0, stdout: "{}", stderr: "" })) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args);
    return handler(args);
  };
  const sends = () => calls.filter((args) => args.includes("send"));
  return { exec, calls, sends };
}

test("acepta JID y teléfono, rechaza nombres y banderas", () => {
  assert.ok(isValidRecipient(JID));
  assert.ok(isValidRecipient("120363000000000000@g.us"));
  assert.ok(isValidRecipient("+52 (55) 1234-5678"));
  assert.ok(!isValidRecipient("Mamá"));
  assert.ok(!isValidRecipient("--all"));
  assert.ok(!isValidRecipient("evil@example.com"));
});

test("cancelar la ventana no envía nada", async () => {
  const fake = fakeExec();
  const { send } = createWhatsApp({ exec: fake.exec, confirm: async () => false });
  const result = await send({ to: JID, message: "hola" });
  assert.equal(fake.sends().length, 0);
  assert.match(result.content[0].text, /"sent": false/);
});

test("confirmar envía exactamente al destinatario y texto mostrados", async () => {
  const fake = fakeExec();
  let shown;
  const { send } = createWhatsApp({
    exec: fake.exec,
    confirm: async (body) => {
      shown = body;
      return true;
    },
  });
  const message = "--hola\ncon salto";
  await send({ to: JID, message });
  assert.equal(fake.sends().length, 1);
  const args = fake.sends()[0];
  assert.ok(args.includes(`--to=${JID}`));
  assert.ok(args.includes(`--message=${message}`));
  assert.ok(!args.includes("--read-only"));
  assert.ok(shown.startsWith(`To: ${JID}`));
  assert.ok(shown.includes(message));
});

test("no pregunta ni envía si el destinatario o el mensaje son inválidos", async () => {
  const fake = fakeExec();
  let asked = false;
  const { send } = createWhatsApp({
    exec: fake.exec,
    confirm: async () => {
      asked = true;
      return true;
    },
  });
  for (const input of [
    { to: "Mamá", message: "hola" },
    { to: JID, message: "   " },
    { to: JID, message: "x".repeat(2001) },
  ]) {
    assert.equal((await send(input)).isError, true);
  }
  assert.equal(asked, false);
  assert.equal(fake.sends().length, 0);
});

test("muestra el nombre del chat en la confirmación", async () => {
  const fake = fakeExec((args) =>
    args.includes("show")
      ? { code: 0, stdout: JSON.stringify({ data: { name: "Ana" } }), stderr: "" }
      : { code: 0, stdout: "{}", stderr: "" },
  );
  let shown;
  const { send } = createWhatsApp({
    exec: fake.exec,
    confirm: async (body) => {
      shown = body;
      return false;
    },
  });
  await send({ to: JID, message: "hola" });
  assert.ok(shown.startsWith(`To: Ana (${JID})`));
});

test("las lecturas siempre van con --read-only y marcan el contenido como externo", async () => {
  const fake = fakeExec(() => ({ code: 0, stdout: '{"data":{"messages":[]}}', stderr: "" }));
  const { read } = createWhatsApp({ exec: fake.exec });
  const result = await read(["messages", "list"], "Leer");
  assert.ok(fake.calls[0].includes("--read-only"));
  assert.match(result.content[0].text, /_untrusted_external/);
});

test("si el chat no existe, toma el nombre del contacto", async () => {
  const fake = fakeExec((args) => {
    if (args.includes("show")) return { code: 1, stdout: '{"success":false,"error":"sql: no rows"}', stderr: "" };
    if (args.includes("search")) {
      return { code: 0, stdout: JSON.stringify({ success: true, data: [{ alias: "Ana", name: "A" }] }), stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  });
  let shown;
  const { send } = createWhatsApp({
    exec: fake.exec,
    confirm: async (body) => {
      shown = body;
      return false;
    },
  });
  await send({ to: JID, message: "hola" });
  assert.ok(shown.startsWith(`To: Ana (${JID})`));
});

test("success:false con código 0 nunca cuenta como enviado", async () => {
  const fake = fakeExec((args) =>
    args.includes("send")
      ? { code: 0, stdout: '{"success":false,"error":"rechazado"}', stderr: "" }
      : { code: 0, stdout: "{}", stderr: "" },
  );
  const { send } = createWhatsApp({ exec: fake.exec, confirm: async () => true });
  const result = await send({ to: JID, message: "hola" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rechazado/);
});

test("sin vincular, el error indica cómo vincular", async () => {
  const fake = fakeExec(() => ({
    code: 1,
    stdout: '{"success":false,"error":"stat /x/wacli.db: no such file or directory"}',
    stderr: "",
  }));
  const { read } = createWhatsApp({ exec: fake.exec });
  const result = await read(["chats", "list"], "Listar");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /whatsapp:login/);
});

test("un envío fallido avisa que el resultado puede ser incierto", async () => {
  const fake = fakeExec((args) =>
    args.includes("send") ? { code: 1, stdout: "", stderr: "timeout" } : { code: 0, stdout: "{}", stderr: "" },
  );
  const { send } = createWhatsApp({ exec: fake.exec, confirm: async () => true });
  const result = await send({ to: JID, message: "hola" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /uncertain/);
  assert.equal(fake.sends().length, 1);
});
