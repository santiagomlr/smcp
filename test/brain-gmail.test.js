import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAccountStore, createGmail } from "../app/core/gmail.js";
import {
  dayFileHeader,
  defaultLabel,
  exportGmailAccount,
  formatMailBlock,
  gmailIdToHex,
  mergeDayFile,
  skipSubject,
  stripHtml,
} from "../src/brain/gmail-export.js";

// Monterrey is six hours behind UTC all year, which keeps the expected times easy to read.
const ZONE = "America/Monterrey";
const at = (day, time) => Date.parse(`${day}T${time}:00-06:00`);
const mail = (values = {}) => ({
  id: "18c2f0a1b2c3d4e5",
  date: at("2026-11-05", "08:17"),
  sent: false,
  draft: false,
  from: "Ana Ruiz <ana@example.com>",
  to: "luis@example.com",
  subject: "Plan de la semana",
  text: "Hola Luis,\n\nTe mando el plan.",
  attachments: [],
  ...values,
});

let root;
let count = 0;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "smcp-brain-gmail-"));
});
after(() => rm(root, { recursive: true, force: true }));

async function newVault() {
  const vault = join(root, `vault-${count++}`);
  await mkdir(vault);
  return vault;
}

/** Stands in for the Gmail module: hands back the given messages and records what it was asked. */
function fakeGmail(messages, { total } = {}) {
  const calls = [];
  return {
    calls,
    exportSince: async (request) => {
      calls.push(request);
      return { account: "ana@example.com", total: total ?? messages.length, messages };
    },
  };
}

test("a received email becomes a heading with the local time, an id marker and the text", () => {
  assert.equal(
    formatMailBlock(mail(), { timeZone: ZONE }),
    "## 08:17 · Ana Ruiz <ana@example.com> — Plan de la semana\n<!-- gmail:18c2f0a1b2c3d4e5 -->\n\nHola Luis,\n\nTe mando el plan.\n",
  );
  assert.match(formatMailBlock(mail({ date: at("2026-11-05", "00:05") }), { timeZone: ZONE }), /^## 00:05 · /);
  assert.match(formatMailBlock(mail(), { timeZone: "Europe/Madrid" }), /^## 15:17 · /);
  // Without a zone it is the computer's own, as the older exporter did.
  const local = new Date(mail().date);
  const clock = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  assert.ok(formatMailBlock(mail()).startsWith(`## ${clock} · `));
});

test("sent mail shows who it went to instead of the sender", () => {
  const block = formatMailBlock(mail({ sent: true, to: '"Ruiz, Eva" <eva@example.com>, luis@example.com' }), { timeZone: ZONE });
  assert.equal(block.split("\n")[0], '## 08:17 · yo → "Ruiz, Eva" <eva@example.com>, luis@example.com — Plan de la semana');
});

test("an email without a subject says so", () => {
  assert.equal(formatMailBlock(mail({ subject: "" }), { timeZone: ZONE }).split("\n")[0], "## 08:17 · Ana Ruiz <ana@example.com> — (sin asunto)");
});

test("attachments are listed under the marker with their type and size in whole KB", () => {
  const attachments = [
    { filename: "informe.pdf", contentType: "application/pdf", size: 12 * 1024 + 900 },
    { filename: "logo.png", contentType: "image/png", size: 1023 },
  ];
  assert.equal(
    formatMailBlock(mail({ attachments, text: "Va adjunto." }), { timeZone: ZONE }),
    "## 08:17 · Ana Ruiz <ana@example.com> — Plan de la semana\n<!-- gmail:18c2f0a1b2c3d4e5 -->\n" +
      "Adjuntos: informe.pdf (application/pdf, 12 KB); logo.png (image/png, 0 KB)\n\nVa adjunto.\n",
  );
});

test("an HTML-only email is written as plain text", () => {
  const html =
    "<html><head><title>Aviso</title><style>p { color: red; }</style></head><body>" +
    "<div><p>Hola&nbsp;<b>Luis</b> &amp; equipo</p></div><div>Caf&eacute; a las 5&#8239;pm<br>Nos vemos &#x1F600;</div>" +
    "<script>track('<p>');</script><ul><li>Uno</li><li>Dos &copy 2026</li></ul></body></html>";
  // Tags leave a space behind, so a line can start with one. The older notes look the same.
  assert.equal(stripHtml(html), "Hola\u00a0 Luis & equipo\n\n Café a las 5\u202fpm\nNos vemos 😀\n Uno\n Dos © 2026");
  const block = formatMailBlock(mail({ text: "", html }), { timeZone: ZONE });
  assert.equal(block.split("\n").slice(2, 4).join("\n"), "\nHola\u00a0 Luis & equipo");
  // Real text wins over the HTML version of the same email.
  assert.ok(formatMailBlock(mail({ html }), { timeZone: ZONE }).endsWith("\n\nHola Luis,\n\nTe mando el plan.\n"));
  assert.equal(stripHtml("&bogus; &#150; &notice R&D &#0;"), "&bogus; – ¬ice R&D \ufffd");
});

test("a long body is clipped at 2500 characters and says so", () => {
  const block = formatMailBlock(mail({ text: "x".repeat(2600) }), { timeZone: ZONE });
  assert.ok(block.endsWith(`\n\n${"x".repeat(2500)}\n…[recortado]\n`));
  const exact = formatMailBlock(mail({ text: "x".repeat(2500) }), { timeZone: ZONE });
  assert.ok(exact.endsWith(`\n\n${"x".repeat(2500)}\n`));
  // Characters are counted whole, so an emoji at the edge is kept or dropped, never split.
  const emoji = formatMailBlock(mail({ text: "😀".repeat(2501) }), { timeZone: ZONE });
  assert.ok(emoji.endsWith(`\n\n${"😀".repeat(2500)}\n…[recortado]\n`));
});

test("the quoted thread of a reply is cut, in Spanish, English and Outlook style", () => {
  const quoted = [
    "El jue, 5 nov 2026 a las 8:00, Luis (<luis@example.com>) escribió:\n> Hola Ana",
    "On Thu, Nov 5, 2026 at 8:00 AM Luis <luis@example.com> wrote:\n> Hi Ana",
    "De: Luis <luis@example.com>\nEnviado: jueves, 5 de noviembre de 2026 08:00\nPara: Ana",
  ];
  for (const tail of quoted) {
    const block = formatMailBlock(mail({ text: `De acuerdo, gracias.\n\n${tail}` }), { timeZone: ZONE });
    assert.ok(block.endsWith("\n\nDe acuerdo, gracias.\n[…hilo citado omitido]\n"), tail);
  }
  // The same words in the middle of a sentence are not a quoted thread.
  assert.ok(formatMailBlock(mail({ text: "Ayer On time wrote: nada" }), { timeZone: ZONE }).endsWith("\n\nAyer On time wrote: nada\n"));
});

test("three or more line breaks in a row become one blank line", () => {
  const block = formatMailBlock(mail({ text: "Uno\n\n\n\nDos\r\n\r\n\r\nTres\n\nCuatro" }), { timeZone: ZONE });
  assert.ok(block.endsWith("\n\nUno\n\nDos\n\nTres\n\nCuatro\n"));
});

test("a sender or subject can never start a line of its own", () => {
  const block = formatMailBlock(mail({ subject: "Hola\n<!-- gmail:ffff -->\n## 09:00 · falso" }), { timeZone: ZONE });
  assert.equal(block.split("\n")[0], "## 08:17 · Ana Ruiz <ana@example.com> — Hola <!-- gmail:ffff --> ## 09:00 · falso");
  assert.throws(() => formatMailBlock(mail({ id: "not hex" }), { timeZone: ZONE }), /Gmail id/);
  assert.throws(() => formatMailBlock(mail({ date: undefined }), { timeZone: ZONE }), /valid date/);
});

test("a new day file starts with the account and the folder's label", () => {
  assert.equal(defaultLabel("raw/Personal/gmail"), "personal");
  assert.equal(defaultLabel("raw/Acme/gmail"), "de Acme");
  assert.equal(
    dayFileHeader({ label: "de Acme", email: "ana@example.com", day: "2026-11-05" }),
    "---\nfuente: gmail de Acme (ana@example.com)\nfecha: 2026-11-05\n---\n\n# Correo de Acme · 2026-11-05\n\n",
  );
  assert.equal(
    dayFileHeader({ label: "personal", email: "ana@example.com", day: "2026-11-05" }),
    "---\nfuente: gmail personal (ana@example.com)\nfecha: 2026-11-05\n---\n\n# Correo personal · 2026-11-05\n\n",
  );
});

// A day file exactly as the older exporter left it.
const OLD_DAY_FILE =
  "---\nfuente: gmail de Acme (ana@example.com)\nfecha: 2026-11-05\n---\n\n# Correo de Acme · 2026-11-05\n\n" +
  "## 07:02 · Luis Soto <luis@example.com> — Agenda\n<!-- gmail:18c2f0a1b2c30001 -->\n\nNos vemos a las 10.  \n\n\n\nSaludos\n\n" +
  "## 07:40 · yo → Luis Soto <luis@example.com> — Re: Agenda\n<!-- gmail:18c2f0a1b2c30002 -->\nAdjuntos: orden.pdf (application/pdf, 48 KB)\n\nListo.\n";

test("merging extends an existing day file without touching it or repeating a marker", () => {
  const header = dayFileHeader({ label: "de Acme", email: "ana@example.com", day: "2026-11-05" });
  const repeated = formatMailBlock(mail({ id: "18c2f0a1b2c30002", text: "Otra versión del mismo correo." }), { timeZone: ZONE });
  const fresh = formatMailBlock(mail({ id: "18c2f0a1b2c30003" }), { timeZone: ZONE });
  const later = formatMailBlock(mail({ id: "18c2f0a1b2c30004", date: at("2026-11-05", "09:30"), text: "Dos." }), { timeZone: ZONE });
  const merged = mergeDayFile(OLD_DAY_FILE, header, [repeated, fresh, later, fresh]);
  assert.equal(merged.added, 2);
  assert.equal(merged.text, `${OLD_DAY_FILE}\n${fresh}\n${later}`);
  assert.deepEqual(mergeDayFile(merged.text, header, [repeated, fresh, later]), { text: merged.text, added: 0 });
});

test("merging into nothing starts the file from the header", () => {
  const header = dayFileHeader({ label: "personal", email: "ana@example.com", day: "2026-11-05" });
  const block = formatMailBlock(mail(), { timeZone: ZONE });
  assert.deepEqual(mergeDayFile(null, header, [block]), { text: `${header}${block}`, added: 1 });
  assert.equal(mergeDayFile("", header, [block]).text, `${header}${block}`);
  assert.throws(() => mergeDayFile(null, header, ["## 08:00 · sin marcador\n\ntexto\n"]), /marker/);
});

test("the IMAP message id becomes the hex id the markers use", () => {
  assert.equal(gmailIdToHex("1784252979671717093"), "18c2f0a1b2c3d4e5");
  assert.equal(gmailIdToHex(BigInt("0x19a2b3c4d5e6f708").toString()), "19a2b3c4d5e6f708");
  assert.equal(gmailIdToHex("255"), "ff");
  for (const bad of ["", "18c2f0a1b2c3d4e5", "-5", "12.5", undefined]) assert.throws(() => gmailIdToHex(bad), /Gmail message id/);
});

test("subjects about codes, passwords and security alerts are recognised in both languages", () => {
  const secret = [
    "Tu código de verificación",
    "CODIGO DE ACCESO",
    "Your code: 482913",
    "Restablece tu contraseña",
    "Password reset",
    "Tu OTP para entrar",
    "Cambio de NIP",
    "API token created",
    "Nuevo inicio de sesión en tu cuenta",
    "New sign-in on Mac",
    "Security alert",
    "Alerta de seguridad",
    "Activa 2FA",
    "Autenticación en dos pasos",
    "Tus credenciales de acceso",
  ];
  for (const subject of secret) assert.equal(skipSubject(subject), true, subject);
  for (const subject of ["Plan de la semana", "Codes of conduct", "Snippet de la reunión", "Lista de precios", "", undefined]) {
    assert.equal(skipSubject(subject), false, String(subject));
  }
});

test("mail is written into one file per local day and a second run adds nothing", async () => {
  const vault = await newVault();
  const messages = [
    mail({ id: "18c2f0a1b2c30011", date: at("2026-11-04", "23:50"), subject: "Antes de medianoche", text: "Uno." }),
    // 05:30 UTC on the 6th is still the evening of the 5th in Monterrey.
    mail({ id: "18c2f0a1b2c30012", date: Date.parse("2026-11-06T05:30:00Z"), subject: "Noche del 5", text: "Dos." }),
    mail({ id: "18c2f0a1b2c30013", date: at("2026-11-06", "00:10"), sent: true, subject: "Ya es 6", text: "Tres." }),
    mail({ id: "18c2f0a1b2c30014", date: at("2026-11-06", "09:00"), subject: "Tu código de acceso", text: "482913" }),
    mail({ id: "18c2f0a1b2c30015", date: at("2026-11-06", "09:05"), draft: true, subject: "Borrador", text: "Sin terminar." }),
  ];
  const gmail = fakeGmail(messages);
  const options = { gmail, account: "Trabajo", vault, folder: "raw/Acme/gmail", timeZone: ZONE, now: () => new Date("2026-11-06T18:00:00Z") };
  const result = await exportGmailAccount(options);
  assert.deepEqual(result, {
    account: "ana@example.com",
    folder: "raw/Acme/gmail",
    written: 3,
    days: 3,
    skipped: 1,
    files: ["raw/Acme/gmail/2026-11-04.md", "raw/Acme/gmail/2026-11-05.md", "raw/Acme/gmail/2026-11-06.md"],
    startedAt: "2026-11-06T18:00:00.000Z",
    since: "2026-11-04T18:00:00.000Z",
    truncated: false,
  });
  const dir = join(vault, "raw", "Acme", "gmail");
  // Only day files: the temporary file each write goes through is gone.
  assert.deepEqual((await readdir(dir)).sort(), ["2026-11-04.md", "2026-11-05.md", "2026-11-06.md"]);
  assert.equal(
    await readFile(join(dir, "2026-11-05.md"), "utf8"),
    "---\nfuente: gmail de Acme (ana@example.com)\nfecha: 2026-11-05\n---\n\n# Correo de Acme · 2026-11-05\n\n" +
      "## 23:30 · Ana Ruiz <ana@example.com> — Noche del 5\n<!-- gmail:18c2f0a1b2c30012 -->\n\nDos.\n",
  );
  const sixth = await readFile(join(dir, "2026-11-06.md"), "utf8");
  assert.ok(sixth.endsWith("# Correo de Acme · 2026-11-06\n\n## 00:10 · yo → luis@example.com — Ya es 6\n<!-- gmail:18c2f0a1b2c30013 -->\n\nTres.\n"));
  assert.ok(!sixth.includes("482913") && !sixth.includes("Borrador"));

  const again = await exportGmailAccount(options);
  assert.deepEqual({ written: again.written, days: again.days, skipped: again.skipped, files: again.files }, { written: 0, days: 3, skipped: 1, files: [] });
  assert.equal(await readFile(join(dir, "2026-11-06.md"), "utf8"), sixth);
});

test("an existing day file from the older exporter is extended, not duplicated", async () => {
  const vault = await newVault();
  const dir = join(vault, "raw", "Acme", "gmail");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "2026-11-05.md"), OLD_DAY_FILE);
  const gmail = fakeGmail([
    mail({ id: "18c2f0a1b2c30002", date: at("2026-11-05", "07:40"), sent: true, subject: "Re: Agenda", text: "Listo." }),
    mail({ id: "18c2f0a1b2c30003", date: at("2026-11-05", "11:15"), subject: "Minuta", text: "Va la minuta." }),
  ]);
  const now = () => new Date("2026-11-05T20:00:00Z");
  const result = await exportGmailAccount({ gmail, account: "ana@example.com", vault, folder: "raw/Acme/gmail/", label: "de Acme", timeZone: ZONE, now });
  assert.equal(result.written, 1);
  assert.deepEqual(result.files, ["raw/Acme/gmail/2026-11-05.md"]);
  assert.equal(
    await readFile(join(dir, "2026-11-05.md"), "utf8"),
    `${OLD_DAY_FILE}\n## 11:15 · Ana Ruiz <ana@example.com> — Minuta\n<!-- gmail:18c2f0a1b2c30003 -->\n\nVa la minuta.\n`,
  );
});

test("mail that is already in the day files is not asked for again", async () => {
  const vault = await newVault();
  const dir = join(vault, "raw", "Acme", "gmail");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "2026-11-03.md"), "## 09:00 · a@example.com — Viejo\n<!-- gmail:18c2f0a1b2c3aaa1 -->\n\nx\n");
  await writeFile(join(dir, "2026-11-04.md"), "## 09:00 · a@example.com — Ayer\n<!-- gmail:18c2f0a1b2c3aaa2 -->\n\nx\n");
  await writeFile(join(dir, "2026-11-05.md"), OLD_DAY_FILE);
  const gmail = fakeGmail([]);
  // The day the search starts on, and the one before it in case the time zone changed in between.
  await exportGmailAccount({ gmail, account: "a", vault, folder: "raw/Acme/gmail", timeZone: ZONE, since: "2026-11-05T12:00:00Z" });
  assert.deepEqual([...gmail.calls[0].known].sort(), ["18c2f0a1b2c30001", "18c2f0a1b2c30002", "18c2f0a1b2c3aaa2"]);
  const empty = fakeGmail([]);
  await exportGmailAccount({ gmail: empty, account: "a", vault: await newVault(), folder: "raw/Acme/gmail", timeZone: ZONE });
  assert.equal(empty.calls[0].known.size, 0);
});

test("the folder must be relative, inside raw/ and without a way out", async () => {
  const vault = await newVault();
  const gmail = fakeGmail([mail()]);
  for (const folder of ["/tmp/gmail", "raw/../outside", "../raw/gmail", "notes/gmail", "raw", "raw/Acme/../../x", "raw\\Acme\\gmail", "", undefined]) {
    await assert.rejects(exportGmailAccount({ gmail, account: "a", vault, folder, timeZone: ZONE }), /raw\/ folder/, String(folder));
  }
  await assert.rejects(exportGmailAccount({ gmail, account: "a", vault: join(vault, "missing"), folder: "raw/Acme/gmail" }), /vault folder was not found/);
  await assert.rejects(exportGmailAccount({ gmail, account: "a", vault: "relative/vault", folder: "raw/Acme/gmail" }), /full folder path/);
  assert.equal(gmail.calls.length, 0);
  assert.deepEqual(await readdir(vault), []);
});

test("without a start date the export resumes from the newest day file, never more than 30 days back", async () => {
  const now = () => new Date("2026-11-13T15:00:00Z");
  const since = async (vault, extra = {}) => {
    const gmail = fakeGmail([]);
    await exportGmailAccount({ gmail, account: "a", vault, folder: "raw/Acme/gmail", timeZone: ZONE, now, ...extra });
    return gmail.calls[0].since.toISOString();
  };
  const withFiles = async (...names) => {
    const vault = await newVault();
    await mkdir(join(vault, "raw", "Acme", "gmail"), { recursive: true });
    for (const name of names) await writeFile(join(vault, "raw", "Acme", "gmail", name), "x");
    return vault;
  };

  // An empty or missing folder looks two days back.
  assert.equal(await since(await newVault()), "2026-11-11T15:00:00.000Z");
  // The newest day file is redone from its first local minute; other files and later dates do not count.
  const recent = await withFiles("2026-11-03.md", "2026-11-05.md", "notas.md", "2026-11-05 copia.md", "2027-01-01.md");
  assert.equal(await since(recent), "2026-11-05T06:00:00.000Z");
  // A folder left alone for months does not pull months of mail.
  assert.equal(await since(await withFiles("2026-06-01.md")), "2026-10-14T15:00:00.000Z");
  // A start date that is given is used as it is.
  assert.equal(await since(recent, { since: "2026-09-01T00:00:00Z" }), "2026-09-01T00:00:00.000Z");
  assert.equal(await since(recent, { since: new Date("2026-11-12T00:00:00Z") }), "2026-11-12T00:00:00.000Z");
  await assert.rejects(since(recent, { since: "yesterday-ish" }), /start date is not valid/);
  // The day starts at local midnight even on the night the clocks change (Auckland, 27 Sep 2026).
  const clocks = await withFiles("2026-09-27.md");
  assert.equal(await since(clocks, { timeZone: "Pacific/Auckland", now: () => new Date("2026-09-28T00:00:00Z") }), "2026-09-26T12:00:00.000Z");
});

test("a run that fails says so and writes nothing", async () => {
  const vault = await newVault();
  const broken = { exportSince: async () => Promise.reject(new Error("Could not connect to Gmail. Check your internet connection.")) };
  await assert.rejects(
    exportGmailAccount({ gmail: broken, account: "ana@example.com", vault, folder: "raw/Acme/gmail", timeZone: ZONE }),
    /Could not export the mail of ana@example\.com: Could not connect to Gmail/,
  );
  const empty = { exportSince: async () => ({ account: "ana@example.com" }) };
  await assert.rejects(exportGmailAccount({ gmail: empty, account: "ana@example.com", vault, folder: "raw/Acme/gmail", timeZone: ZONE }), /no message list/);
  const undated = fakeGmail([mail({ date: null })]);
  await assert.rejects(exportGmailAccount({ gmail: undated, account: "a", vault, folder: "raw/Acme/gmail", timeZone: ZONE }), /valid date/);
  assert.deepEqual(await readdir(vault), []);
});

test("when more mail matched than one run takes, the result says it is not complete", async () => {
  const vault = await newVault();
  const gmail = fakeGmail([mail()], { total: 3 });
  const result = await exportGmailAccount({ gmail, account: "a", vault, folder: "raw/Personal/gmail", timeZone: ZONE, limit: 1 });
  assert.equal(result.truncated, true);
  assert.equal(gmail.calls[0].limit, 1);
  assert.match(await readFile(join(vault, "raw", "Personal", "gmail", "2026-11-05.md"), "utf8"), /^---\nfuente: gmail personal \(ana@example\.com\)\n/);
});

// ---- exportSince over a fake IMAP connection ----

const PASSWORD = "abcdefghijklmnop";
const lines = (...rows) => rows.join("\r\n");

const RAW = {
  alternative: lines(
    "From: =?UTF-8?Q?Jos=C3=A9_Nu=C3=B1ez?= <jose@example.com>",
    "To: Ana Ruiz <ana@example.com>,",
    '\t"Soto, Luis" <luis@example.com>',
    "Subject: =?UTF-8?B?UmV1bmnDs24gZGUgbWHDsWFuYQ==?=",
    " =?UTF-8?Q?_a_las_10?=",
    "Date: Thu, 05 Nov 2026 08:17:00 -0600",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hola Ana,",
    "",
    "Nos vemos ma=C3=B1ana.",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hola Ana,</p><p>Nos vemos <b>ma&ntilde;ana</b>.</p>",
    "--alt--",
    "",
  ),
  attachment: lines(
    'From: "Soto, Luis" <luis@example.com>',
    "To: ana@example.com",
    "Subject: Informe",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix"',
    "",
    "--mix",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Va el informe.",
    "--mix",
    'Content-Type: application/octet-stream; name="informe.pdf"',
    'Content-Disposition: attachment; filename="informe.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.alloc(3000, 65).toString("base64"),
    "--mix",
    "Content-Type: image/png",
    "Content-ID: <firma>",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.alloc(10, 65).toString("base64"),
    "--mix--",
    "",
  ),
  html: lines(
    "From: =?ISO-8859-1?Q?Mar=EDa_L=F3pez?= <maria@example.com>",
    "To: ana@example.com",
    "Subject: Aviso",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><div>Cambi&oacute; la fecha.</div><div>Gracias</div></body></html>",
    "",
  ),
  sent: lines("From: Ana Ruiz <ana@example.com>", "To: Luis Soto <luis@example.com>", "Subject: Re: Informe", "", "Recibido, gracias.", ""),
  draft: lines("From: Ana Ruiz <ana@example.com>", "To: luis@example.com", "Subject: Pendiente", "", "Sin terminar", ""),
};

const decimal = (hex) => BigInt(`0x${hex}`).toString();
// Listed newest first on purpose: the result has to come back oldest first.
const MAILBOX = [
  { uid: 15, emailId: decimal("18c2f0a1b2c30025"), internalDate: new Date(at("2026-11-05", "12:00")), labels: ["\\Draft"], raw: RAW.draft },
  { uid: 14, emailId: decimal("18c2f0a1b2c30024"), internalDate: new Date(at("2026-11-05", "11:00")), labels: ["\\Sent", "Clientes"], raw: RAW.sent },
  { uid: 13, emailId: decimal("18c2f0a1b2c30023"), internalDate: new Date(at("2026-11-05", "10:00")), labels: ["\\Inbox"], raw: RAW.html },
  { uid: 12, emailId: decimal("18c2f0a1b2c30022"), internalDate: new Date(at("2026-11-05", "09:00")), labels: ["\\Inbox", "\\Important"], raw: RAW.attachment },
  { uid: 11, emailId: decimal("18c2f0a1b2c30021"), internalDate: new Date(at("2026-11-05", "08:17")), labels: ["\\Inbox"], raw: RAW.alternative },
];

function fakeImap(mailbox, { found, connectError } = {}) {
  const log = { locks: [], searches: [], fetches: [] };
  const factory = () => ({
    connect: async () => {
      if (connectError) throw connectError;
    },
    logout: async () => {},
    list: async () => [{ path: "INBOX" }, { path: "[Gmail]/Todos", specialUse: "\\All" }],
    getMailboxLock: async (name, options) => {
      log.locks.push({ name, options });
      return { release() {} };
    },
    search: async (query, options) => {
      log.searches.push({ query, options });
      return found === undefined ? mailbox.map((item) => item.uid) : found;
    },
    async *fetch(uids, query, options) {
      log.fetches.push({ uids, query, options });
      for (const uid of uids) {
        const item = mailbox.find((entry) => entry.uid === uid);
        if (item) yield { uid, emailId: item.emailId, internalDate: item.internalDate, labels: new Set(item.labels), flags: new Set(), source: Buffer.from(item.raw) };
      }
    },
  });
  return { factory, log };
}

async function connectedGmail(imap) {
  const store = createAccountStore({
    path: join(root, `accounts-${count++}.json`),
    encrypt: (text) => Buffer.from(text).toString("base64"),
    decrypt: (secret) => Buffer.from(secret, "base64").toString(),
  });
  await store.add({ label: "Trabajo", email: "ana@example.com", password: PASSWORD });
  return createGmail({ store, confirm: async () => false, imap: imap.factory });
}

test("exportSince reads All Mail with Gmail's own search and returns the messages oldest first", async () => {
  const imap = fakeImap(MAILBOX);
  const gmail = await connectedGmail(imap);
  const result = await gmail.exportSince({ account: "trabajo", since: new Date("2026-11-05T06:00:00.500Z") });

  assert.deepEqual(imap.log.locks, [{ name: "[Gmail]/Todos", options: { readOnly: true } }]);
  assert.deepEqual(imap.log.searches, [
    { query: { gmraw: "after:1793858400 -in:spam -in:trash -in:drafts -category:promotions -category:social -category:forums" }, options: { uid: true } },
  ]);
  assert.deepEqual(imap.log.fetches, [
    { uids: [11, 12, 13, 14, 15], query: { uid: true, flags: true, internalDate: true, labels: true, source: true }, options: { uid: true } },
  ]);
  assert.equal(result.account, "ana@example.com");
  assert.equal(result.total, 5);
  assert.ok(!JSON.stringify(result).includes(PASSWORD));
  assert.deepEqual(result.messages, [
    {
      id: "18c2f0a1b2c30021",
      date: at("2026-11-05", "08:17"),
      sent: false,
      draft: false,
      from: "José Nuñez <jose@example.com>",
      to: 'Ana Ruiz <ana@example.com>, "Soto, Luis" <luis@example.com>',
      subject: "Reunión de mañana a las 10",
      text: "Hola Ana,\n\nNos vemos mañana.",
      attachments: [],
    },
    {
      id: "18c2f0a1b2c30022",
      date: at("2026-11-05", "09:00"),
      sent: false,
      draft: false,
      from: '"Soto, Luis" <luis@example.com>',
      to: "ana@example.com",
      subject: "Informe",
      text: "Va el informe.",
      // The unnamed inline image is not an attachment, and the type is the one the sender declared.
      attachments: [{ filename: "informe.pdf", contentType: "application/octet-stream", size: 3000 }],
    },
    {
      id: "18c2f0a1b2c30023",
      date: at("2026-11-05", "10:00"),
      sent: false,
      draft: false,
      from: "María López <maria@example.com>",
      to: "ana@example.com",
      subject: "Aviso",
      text: "Cambió la fecha.\n Gracias",
      attachments: [],
    },
    {
      id: "18c2f0a1b2c30024",
      date: at("2026-11-05", "11:00"),
      sent: true,
      draft: false,
      from: "Ana Ruiz <ana@example.com>",
      to: "Luis Soto <luis@example.com>",
      subject: "Re: Informe",
      text: "Recibido, gracias.",
      attachments: [],
    },
    {
      id: "18c2f0a1b2c30025",
      date: at("2026-11-05", "12:00"),
      sent: false,
      draft: true,
      from: "Ana Ruiz <ana@example.com>",
      to: "luis@example.com",
      subject: "Pendiente",
      text: "Sin terminar",
      attachments: [],
    },
  ]);
});

test("exportSince takes the oldest messages when there are more than the limit", async () => {
  const imap = fakeImap(MAILBOX);
  const gmail = await connectedGmail(imap);
  const result = await gmail.exportSince({ account: "ana@example.com", since: 0, limit: 2 });
  assert.deepEqual(imap.log.fetches[0].uids, [11, 12]);
  assert.deepEqual(result.messages.map((message) => message.id), ["18c2f0a1b2c30021", "18c2f0a1b2c30022"]);
  assert.equal(result.total, 5);
});

test("exportSince does not download again the mail whose id is already known", async () => {
  const imap = fakeImap(MAILBOX);
  const gmail = await connectedGmail(imap);
  const known = new Set(["18c2f0a1b2c30022", "18c2f0a1b2c30023"]);
  const result = await gmail.exportSince({ account: "ana@example.com", since: 0, known, limit: 2 });
  // First only the ids of everything that matched, then the content of what is new.
  assert.deepEqual(imap.log.fetches.map(({ uids, query }) => ({ uids, query })), [
    { uids: [11, 12, 13, 14, 15], query: { uid: true } },
    { uids: [11, 14], query: { uid: true, flags: true, internalDate: true, labels: true, source: true } },
  ]);
  assert.deepEqual(result.messages.map((message) => message.id), ["18c2f0a1b2c30021", "18c2f0a1b2c30024"]);
  assert.equal(result.total, 3);
});

test("exportSince never passes a failure off as an empty mailbox", async () => {
  const start = { account: "ana@example.com", since: new Date("2026-11-05T00:00:00Z") };
  // imapflow answers false when the server refuses a search.
  const refused = await connectedGmail(fakeImap(MAILBOX, { found: false }));
  await assert.rejects(refused.exportSince(start), /Gmail could not complete the action/);
  const offline = await connectedGmail(fakeImap(MAILBOX, { connectError: Object.assign(new Error("getaddrinfo ENOTFOUND imap.gmail.com"), { code: "ENOTFOUND" }) }));
  await assert.rejects(offline.exportSince(start), /Could not connect to Gmail/);
  // A message the server lists but does not hand over, or one without Gmail's id.
  const missing = await connectedGmail(fakeImap(MAILBOX.slice(0, 4), { found: [11, 12] }));
  await assert.rejects(missing.exportSince(start), /did not return every message/);
  const noId = await connectedGmail(fakeImap([{ ...MAILBOX[4], emailId: undefined }]));
  await assert.rejects(noId.exportSince(start), /did not return every message/);

  const gmail = await connectedGmail(fakeImap([]));
  assert.deepEqual(await gmail.exportSince(start), { account: "ana@example.com", total: 0, messages: [] });
  await assert.rejects(gmail.exportSince({ account: "ana@example.com" }), /valid start date/);
  await assert.rejects(gmail.exportSince({ account: "nadie", since: 0 }), /No connected account/);
});

test("from the IMAP connection to the day file, in the vault's format", async () => {
  const vault = await newVault();
  const gmail = await connectedGmail(fakeImap(MAILBOX));
  const result = await exportGmailAccount({ gmail, account: "trabajo", vault, folder: "raw/Acme/gmail", timeZone: ZONE, since: "2026-11-05T06:00:00Z" });
  assert.deepEqual({ written: result.written, days: result.days, skipped: result.skipped }, { written: 4, days: 1, skipped: 0 });
  assert.equal(
    await readFile(join(vault, "raw", "Acme", "gmail", "2026-11-05.md"), "utf8"),
    "---\nfuente: gmail de Acme (ana@example.com)\nfecha: 2026-11-05\n---\n\n# Correo de Acme · 2026-11-05\n\n" +
      "## 08:17 · José Nuñez <jose@example.com> — Reunión de mañana a las 10\n<!-- gmail:18c2f0a1b2c30021 -->\n\nHola Ana,\n\nNos vemos mañana.\n\n" +
      '## 09:00 · "Soto, Luis" <luis@example.com> — Informe\n<!-- gmail:18c2f0a1b2c30022 -->\n' +
      "Adjuntos: informe.pdf (application/octet-stream, 2 KB)\n\nVa el informe.\n\n" +
      "## 10:00 · María López <maria@example.com> — Aviso\n<!-- gmail:18c2f0a1b2c30023 -->\n\nCambió la fecha.\n Gracias\n\n" +
      "## 11:00 · yo → Luis Soto <luis@example.com> — Re: Informe\n<!-- gmail:18c2f0a1b2c30024 -->\n\nRecibido, gracias.\n",
  );
});
