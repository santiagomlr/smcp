import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAccountStore, createGmail, replyRecipients, replySubject } from "../app/core/gmail.js";
import { REMOTE_TOOLS } from "../src/remote-tools.js";
import { chunkNote, cosine, createSemanticSearch, decodeVector, encodeVector } from "../src/semantic.js";
import { compactMessage, createWhatsApp, readTranscripts, saveTranscript, searchTranscripts } from "../src/tools/whatsapp.js";

const JID = "5215512345678@s.whatsapp.net";
const PASSWORD = "abcdefghijklmnop";
let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-messaging-"));
});
after(() => rm(dir, { recursive: true, force: true }));

const payload = (result) => {
  const data = JSON.parse(result.content[0].text);
  return data._untrusted_external ? data.data : data;
};

// Gmail

test("el asunto de una respuesta lleva un solo Re:", () => {
  assert.equal(replySubject("Factura"), "Re: Factura");
  assert.equal(replySubject("RE: Factura"), "RE: Factura");
  assert.equal(replySubject("Factura\r\nBcc: x@y.com"), "Re: Factura Bcc: x@y.com");
});

test("responder a todos quita la propia cuenta y los repetidos, y prefiere Reply-To", () => {
  const envelope = {
    from: [{ address: "ana@x.com" }],
    replyTo: [{ address: "lista@x.com" }],
    to: [{ address: "YO@x.com" }, { address: "beto@x.com" }],
    cc: [{ address: "beto@x.com" }, { address: "no-es-correo" }],
  };
  assert.deepEqual(replyRecipients(envelope, "yo@x.com"), ["lista@x.com"]);
  assert.deepEqual(replyRecipients(envelope, "yo@x.com", true), ["lista@x.com", "beto@x.com"]);
});

async function gmailWith({ confirm = async () => true, attachments = [] } = {}) {
  const store = createAccountStore({ path: join(dir, `${Math.random()}.json`), encrypt: (t) => t, decrypt: (t) => t });
  await store.add({ label: "Trabajo", email: "yo@x.com", password: PASSWORD });
  const log = { appended: [], shown: [], sent: [] };
  const envelope = { messageId: "<orig@x>", subject: "Plan", from: [{ address: "ana@x.com" }], to: [{ address: "yo@x.com" }], cc: [{ address: "beto@x.com" }] };
  const imap = () => ({
    connect: async () => {},
    logout: async () => {},
    list: async () => [{ path: "INBOX" }, { path: "[Gmail]/Todos", specialUse: "\\All" }, { path: "[Gmail]/Borradores", specialUse: "\\Drafts" }],
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async (uid, query) => {
      if (query.envelope) return { envelope };
      const parts = attachments
        .map((a) => `--b\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(a.body).toString("base64")}\r\n`)
        .join("");
      return { source: Buffer.from(`From: ana@x.com\r\nSubject: Plan\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nHola\r\n${parts}--b--\r\n`) };
    },
    append: async (path, raw, flags) => (log.appended.push({ path, raw: raw.toString(), flags }), { uid: 77 }),
  });
  const smtp = () => ({ sendMail: async (mail) => (log.sent.push(mail), { messageId: "<id>", accepted: mail.to }), close() {} });
  const gmail = createGmail({ store, imap, smtp, confirm: async (body) => (log.shown.push(body), confirm(body)) });
  return { gmail, log };
}

test("un borrador se guarda en Borradores, sin ventana y sin enviarse", async () => {
  const { gmail, log } = await gmailWith();
  const result = await gmail.draft({ account: "trabajo", to: ["b@y.com"], subject: "Hola", body: "Texto ñ" });
  assert.equal(result.drafted, true);
  assert.equal(result.uid, 77);
  assert.equal(log.shown.length, 0);
  assert.equal(log.sent.length, 0);
  assert.equal(log.appended[0].path, "[Gmail]/Borradores");
  assert.deepEqual(log.appended[0].flags, ["\\Draft", "\\Seen"]);
  assert.match(log.appended[0].raw, /To: b@y\.com/);
});

test("un borrador de respuesta toma destinatarios, asunto e hilo del original", async () => {
  const { gmail, log } = await gmailWith();
  const result = await gmail.draft({ account: "yo@x.com", body: "Va", reply_to_uid: 5, reply_all: true });
  assert.deepEqual(result.to, ["ana@x.com", "beto@x.com"]);
  assert.equal(result.subject, "Re: Plan");
  assert.match(log.appended[0].raw, /In-Reply-To: <orig@x>/);
  await assert.rejects(gmail.draft({ account: "yo@x.com", to: ["no"], body: "x" }), /valid email/);
});

test("responder pasa por la ventana y no envía si se cancela", async () => {
  const cancelled = await gmailWith({ confirm: async () => false });
  const result = await cancelled.gmail.reply({ account: "yo@x.com", uid: 5, body: "Gracias" });
  assert.equal(result.sent, false);
  assert.equal(cancelled.log.sent.length, 0);
  assert.match(cancelled.log.shown[0], /To: ana@x\.com/);
  assert.match(cancelled.log.shown[0], /Subject: Re: Plan/);

  const confirmed = await gmailWith();
  await confirmed.gmail.reply({ account: "yo@x.com", uid: 5, body: "Gracias" });
  assert.equal(confirmed.log.sent[0].inReplyTo, "<orig@x>");
  assert.deepEqual(confirmed.log.sent[0].to, ["ana@x.com"]);
});

test("un adjunto de texto se lee; uno sin conversión, no", async () => {
  const { gmail } = await gmailWith({ attachments: [{ name: "lista.csv", type: "text/csv", body: "a,b\n1,2" }, { name: "foto.jpg", type: "image/jpeg", body: "xx" }] });
  const read = await gmail.attachment({ account: "yo@x.com", uid: 5, index: 0 });
  assert.equal(read.filename, "lista.csv");
  assert.equal(read.text, "a,b\n1,2");
  await assert.rejects(gmail.attachment({ account: "yo@x.com", uid: 5, index: 1 }), /cannot be turned into text/);
  await assert.rejects(gmail.attachment({ account: "yo@x.com", uid: 5, index: 9 }), /no attachment/);
});

// WhatsApp

function fakeExec(handler = () => ({ code: 0, stdout: "{}", stderr: "" })) {
  const calls = [];
  return { calls, exec: async (file, args) => (calls.push(args), handler(args)) };
}

test("enviar un archivo muestra nombre y tamaño, y cancelar no envía nada", async () => {
  const file = join(dir, "reporte.pdf");
  await writeFile(file, Buffer.alloc(2048));
  const fake = fakeExec();
  let shown;
  const { sendFile } = createWhatsApp({ exec: fake.exec, confirm: async (body) => ((shown = body), false), resolvePath: async (p) => p });
  const result = await sendFile({ to: JID, path: file, caption: "Aquí va" });
  assert.match(result.content[0].text, /"sent": false/);
  assert.match(shown, /File: reporte\.pdf \(2 KB\)/);
  assert.match(shown, /Caption:\nAquí va/);
  assert.equal(fake.calls.filter((args) => args.includes("send")).length, 0);
});

test("confirmar envía exactamente ese archivo, y las rutas bloqueadas ni preguntan", async () => {
  const file = join(dir, "foto.jpg");
  await writeFile(file, "x");
  const fake = fakeExec();
  let asked = 0;
  const { sendFile } = createWhatsApp({ exec: fake.exec, confirm: async () => (asked++, true), resolvePath: async (p) => p });
  await sendFile({ to: JID, path: file });
  const args = fake.calls.find((call) => call.includes("send"));
  assert.deepEqual(args.slice(1, 4), ["--json", "send", "file"]);
  assert.ok(args.includes(`--file=${file}`));
  assert.ok(!args.some((arg) => arg.startsWith("--caption")));

  const blocked = createWhatsApp({ exec: fake.exec, confirm: async () => (asked++, true) });
  const denied = await blocked.sendFile({ to: JID, path: "~/.ssh/id_rsa" });
  assert.equal(denied.isError, true);
  assert.equal(asked, 1);
  const badRecipient = await blocked.sendFile({ to: "Mamá", path: file });
  assert.match(badRecipient.content[0].text, /JID/);
});

test("el resumen de un chat recorre las páginas y lo devuelve del más viejo al más nuevo", async () => {
  const pages = [
    { messages: [{ MsgID: "m3", Text: "tres", SenderName: "Ana", Timestamp: "3" }, { MsgID: "r", ReactionToID: "m1", ReactionEmoji: "👍" }], page: { next_cursor: "c1" } },
    { messages: [{ MsgID: "m2", FromMe: true, Text: "dos", Timestamp: "2" }, { MsgID: "m1", MediaType: "image", MediaCaption: "foto", Timestamp: "1" }], page: {} },
  ];
  const fake = fakeExec((args) => ({ code: 0, stdout: JSON.stringify({ success: true, data: pages[args.some((a) => a === "--cursor=c1") ? 1 : 0] }), stderr: "" }));
  const { digest } = createWhatsApp({ exec: fake.exec });
  const data = payload(await digest({ chat: JID, after: "2026-11-01", limit: 500 }));
  assert.deepEqual(data.messages.map((m) => m.id), ["m1", "m2", "m3"]);
  assert.equal(data.messages[1].from, "me");
  assert.deepEqual(data.messages[0], { id: "m1", at: "1", from: "", text: "foto", media: "image" });
  assert.equal(data.complete, true);
  assert.ok(fake.calls.every((args) => args.includes("--read-only")));
  assert.equal(compactMessage({ MsgID: "x", Text: "a".repeat(1500) }).text.length, 1001);
});

test("las transcripciones se guardan y se buscan sin importar acentos; la más nueva reemplaza", async () => {
  const path = join(dir, "transcripts.jsonl");
  await saveTranscript({ chat: JID, id: "a1", timestamp: "2026-11-01", transcript: "Nos vemos en la reunión del martes" }, path);
  await saveTranscript({ chat: JID, id: "a2", timestamp: "2026-11-02", transcript: "Compra pan" }, path);
  await saveTranscript({ chat: JID, id: "a2", timestamp: "2026-11-02", transcript: "Compra leche" }, path);
  const entries = await readTranscripts(path);
  assert.equal(entries.length, 2);
  assert.deepEqual(searchTranscripts(entries, { query: "REUNION martes" }).map((e) => e.id), ["a1"]);
  assert.deepEqual(searchTranscripts(entries, { query: "pan" }), []);
  assert.deepEqual(searchTranscripts(entries, { query: "compra", chat: "otro@g.us" }), []);
  assert.equal(((await readFile(path)).length > 0), true);
});

// Semantic search

test("las notas se parten en pocos trozos, todos con el título", () => {
  const chunks = chunkNote("Viaje", `---\ntags: x\n---\n${"Párrafo uno. ".repeat(80)}\n\nPárrafo dos.`);
  assert.ok(chunks.length >= 2 && chunks.length <= 4);
  assert.ok(chunks.every((chunk) => chunk.text.startsWith("Viaje\n")));
  assert.ok(!chunks[0].text.includes("tags:"));
  assert.deepEqual(chunkNote("Vacía", ""), [{ text: "Vacía", preview: "" }]);
});

test("los vectores se guardan compactos y la similitud es la de coseno", () => {
  const back = decodeVector(encodeVector([0.5, -1, 2]));
  assert.deepEqual([...back], [0.5, -1, 2]);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

/** Each word maps to a dimension: enough to rank by shared meaning words in tests. */
function bagEmbedder() {
  const words = ["viaje", "tokio", "vuelo", "receta", "pan", "harina", "dinero"];
  const synonyms = { japon: "tokio", avion: "vuelo", hornear: "pan", vacaciones: "viaje" };
  const calls = [];
  return {
    calls,
    async detect() {
      return "es";
    },
    async embed(texts, language) {
      calls.push({ count: texts.length, language });
      return texts.map((text) => {
        const tokens = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\W+/).map((t) => synonyms[t] ?? t);
        const vector = words.map((word) => tokens.filter((t) => t === word).length);
        return vector.some(Boolean) ? vector : null;
      });
    },
  };
}

test("la búsqueda semántica ordena por significado y solo vuelve a indexar lo que cambió", async () => {
  const vault = join(dir, "boveda");
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(join(vault, "Viaje a Tokio.md"), "Reservar el vuelo y el hotel.");
  await writeFile(join(vault, "Pan casero.md"), "Receta: harina, agua y sal.");
  await writeFile(join(vault, ".obsidian", "oculto.md"), "viaje viaje viaje");
  const embedder = bagEmbedder();
  const vaults = () => [{ name: "boveda", path: vault }];
  const search = createSemanticSearch({ vaults, embedder, path: join(dir, "index.json") });

  const first = await search.search({ query: "vacaciones en Japón en avión" });
  assert.equal(first.language, "es");
  assert.equal(first.notes[0].path, "Viaje a Tokio.md");
  assert.ok(!first.notes.some((note) => note.path.includes("oculto")));
  const indexed = embedder.calls.length;

  const second = await search.search({ query: "hornear" });
  assert.equal(second.notes[0].path, "Pan casero.md");
  assert.equal(embedder.calls.length, indexed + 1, "nothing changed, so only the query is embedded");

  await writeFile(join(vault, "Pan casero.md"), "Ahora habla de dinero.");
  await utimes(join(vault, "Pan casero.md"), new Date(), new Date(Date.now() + 5000));
  await search.search({ query: "dinero" });
  assert.equal(embedder.calls.at(-2).count, 1, "only the changed note is embedded again");

  const off = createSemanticSearch({ vaults: () => [], embedder, path: join(dir, "index.json") });
  await assert.rejects(off.search({ query: "x" }), /No vaults/);
});

test("una búsqueda con poco tiempo indexa por partes y lo dice", async () => {
  const vault = join(dir, "grande");
  await mkdir(vault, { recursive: true });
  for (let i = 0; i < 5; i++) await writeFile(join(vault, `viaje ${i}.md`), "vuelo");
  let clock = 0;
  const search = createSemanticSearch({
    vaults: () => [{ name: "grande", path: vault }],
    embedder: bagEmbedder(),
    path: join(dir, "index-grande.json"),
    budgetMs: 2,
    now: () => clock++,
  });
  const result = await search.search({ query: "viaje", language: "es" });
  assert.ok(result.still_indexing > 0);
  assert.ok(result.notes.length < 5);
});

// Remote

test("desde el teléfono hay lecturas nuevas, pero ninguna escritura nueva", () => {
  for (const name of ["daily_brief", "calendar_list_events", "calendar_free_slots", "reminders_list", "applenotes_read", "notes_semantic_search", "gmail_read_attachment", "whatsapp_chat_digest"]) {
    assert.ok(REMOTE_TOOLS.has(name), name);
  }
  for (const name of ["calendar_create_event", "reminders_create", "reminders_complete", "gmail_draft", "gmail_reply", "whatsapp_send_file", "clipboard_read", "clipboard_write", "screen_read_text"]) {
    assert.ok(!REMOTE_TOOLS.has(name), name);
  }
});
