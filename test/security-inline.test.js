import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAccountStore, createGmail } from "../app/core/gmail.js";
import { annotateLinks, riskyLinks, scanAttachment, securityOn } from "../src/security/inline.js";
import { createWhatsApp } from "../src/tools/whatsapp.js";

// Built from parts so this test file is not itself flagged by other antivirus products.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-ANTIVIRUS-", "TEST-FILE!$H+H*"].join("");
const PHISH = "http://bbva-mx-verificar.top/login";
const JID = "5215512345678@s.whatsapp.net";
const PASSWORD = "abcdabcdabcdabcd";
const payload = (result) => JSON.parse(result.content[0].text).data;
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" });

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-inline-"));
});
after(() => rm(dir, { recursive: true, force: true }));

// Shared pieces

test("el interruptor del antivirus también apaga la revisión automática", () => {
  assert.equal(securityOn({ disabled: { security: false } }), true);
  assert.equal(securityOn({ disabled: { security: true } }), false);
  assert.equal(securityOn({ disabled: {} }), true);
});

test("un adjunto se califica por sus bytes y avisa si es malicioso", () => {
  const bad = scanAttachment(Buffer.from(EICAR), "factura.pdf.exe");
  assert.equal(bad.verdict, "malicious");
  assert.match(bad.warning, /not to open/);
  const good = scanAttachment(Buffer.from("Hola"), "nota.txt");
  assert.equal(good.verdict, "clean");
  assert.equal(good.warning, undefined);
});

test("solo se listan los enlaces riesgosos", () => {
  const links = riskyLinks(`Mira https://www.google.com/ y entra a ${PHISH} hoy`);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, PHISH);
  assert.equal(links[0].verdict, "dangerous");
});

test("marca los mensajes con enlaces de phishing y deja igual los demás", () => {
  const data = { messages: [{ MsgID: "a", Text: "hola" }, { MsgID: "b", Text: `Tu cuenta se bloqueó: ${PHISH}` }, { MsgID: "c", MediaCaption: "https://www.paypal.com/" }] };
  const { value, marked } = annotateLinks(data);
  assert.equal(marked, 1);
  assert.equal(value.messages[0].security, undefined);
  assert.equal(value.messages[1].security.links[0].url, PHISH);
  assert.equal(value.messages[2].security, undefined);
  assert.equal(data.messages[1].security, undefined, "the original is not changed");
  assert.equal(annotateLinks("texto").value, "texto");
});

// Gmail

async function gmailWith({ attachments = [], body = "Hola", protect = () => true } = {}) {
  const store = createAccountStore({ path: join(dir, `${Math.random()}.json`), encrypt: (t) => t, decrypt: (t) => t });
  await store.add({ label: "Trabajo", email: "yo@x.com", password: PASSWORD });
  const imap = () => ({
    connect: async () => {},
    logout: async () => {},
    list: async () => [{ path: "INBOX" }, { path: "[Gmail]/Todos", specialUse: "\\All" }],
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async () => {
      const parts = attachments
        .map((a) => `--b\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(a.body).toString("base64")}\r\n`)
        .join("");
      return { source: Buffer.from(`From: ana@x.com\r\nSubject: Pago\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${body}\r\n${parts}--b--\r\n`) };
    },
  });
  return createGmail({ store, imap, smtp: () => ({}), confirm: async () => false, protect });
}

test("al leer un correo, cada adjunto llega escaneado y los enlaces de phishing marcados", async () => {
  const gmail = await gmailWith({
    body: `Paga aquí: ${PHISH}`,
    attachments: [
      { name: "factura.pdf.exe", type: "application/octet-stream", body: EICAR },
      { name: "nota.txt", type: "text/plain", body: "todo bien" },
    ],
  });
  const mail = await gmail.read({ account: "trabajo", uid: 5 });
  assert.equal(mail.attachments[0].security.verdict, "malicious");
  assert.equal(mail.attachments[1].security.verdict, "clean");
  assert.equal(mail.security.flaggedAttachments, 1);
  assert.equal(mail.security.riskyLinks[0].url, PHISH);
  assert.match(mail.security.warning, /Warn the person/);
});

test("un correo limpio no trae advertencia", async () => {
  const gmail = await gmailWith({ attachments: [{ name: "nota.txt", type: "text/plain", body: "hola" }] });
  const mail = await gmail.read({ account: "trabajo", uid: 5 });
  assert.equal(mail.security.checked, true);
  assert.equal(mail.security.warning, undefined);
});

test("un adjunto malicioso se bloquea y ni siquiera se convierte a texto", async () => {
  const gmail = await gmailWith({ attachments: [{ name: "eicar.txt", type: "text/plain", body: EICAR }] });
  const result = await gmail.attachment({ account: "trabajo", uid: 5, index: 0 });
  assert.equal(result.blocked, true);
  assert.equal(result.text, undefined);
  assert.equal(result.security.verdict, "malicious");
});

test("con el antivirus apagado, el correo se lee como antes", async () => {
  const gmail = await gmailWith({ body: PHISH, attachments: [{ name: "eicar.txt", type: "text/plain", body: EICAR }], protect: () => false });
  const mail = await gmail.read({ account: "trabajo", uid: 5 });
  assert.equal(mail.security, undefined);
  assert.equal(mail.attachments[0].security, undefined);
  const result = await gmail.attachment({ account: "trabajo", uid: 5, index: 0 });
  assert.equal(result.blocked, undefined);
  assert.match(result.text, /EICAR/);
});

// WhatsApp

function whatsappWith({ show = { MediaType: "document", Filename: "factura.pdf.exe", SenderName: "Desconocido" }, fileBody = EICAR, protect = () => true, messages = [] } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args);
    if (args.includes("show")) return show ? ok(show) : { code: 1, stdout: "", stderr: "no rows" };
    if (args.includes("media")) {
      const output = args.find((arg) => arg.startsWith("--output=")).slice("--output=".length);
      await writeFile(output, fileBody);
      return ok({ path: output });
    }
    if (args.includes("list")) return ok({ messages });
    return ok({});
  };
  return { calls, ...createWhatsApp({ exec, protect }) };
}

test("whatsapp_scan_file baja el archivo, lo escanea, lo borra y solo regresa el veredicto", async () => {
  const { scanFile, calls } = whatsappWith();
  const result = payload(await scanFile({ chat: JID, id: "ABC123" }));
  assert.equal(result.verdict, "malicious");
  assert.equal(result.file, "factura.pdf.exe");
  assert.match(result.warning, /not to open/);
  assert.equal(JSON.stringify(result).includes("EICAR-STANDARD"), false, "the file content never reaches the AI");
  const download = calls.find((args) => args.includes("media"));
  assert.ok(download.includes("--read-only"));
  const output = download.find((arg) => arg.startsWith("--output=")).slice("--output=".length);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(output), false, "the temporary copy is deleted");
});

test("whatsapp_scan_file rechaza mensajes sin archivo y respeta el interruptor", async () => {
  const text = whatsappWith({ show: { Text: "hola" } });
  assert.match((await text.scanFile({ chat: JID, id: "ABC123" })).content[0].text, /no file/);
  const off = whatsappWith({ protect: () => false });
  assert.match((await off.scanFile({ chat: JID, id: "ABC123" })).content[0].text, /turned off/);
  assert.equal(off.calls.length, 0);
});

test("los mensajes de WhatsApp con phishing llegan marcados", async () => {
  const { read } = whatsappWith({ messages: [{ MsgID: "a", Text: `Ganaste un premio: ${PHISH}` }, { MsgID: "b", Text: "ok" }] });
  const data = payload(await read(["messages", "list", `--chat=${JID}`], "Read messages"));
  assert.equal(data.messages[0].security.links[0].url, PHISH);
  assert.equal(data.messages[1].security, undefined);
});
