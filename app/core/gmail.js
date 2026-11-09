// Runs only inside SMCP.app, so app passwords never reach the MCP server process that Claude starts.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const APP_PASSWORD = /^[a-zA-Z]{16}$/;
const MAX_ACCOUNTS = 20;
const MAX_LABEL = 40;
const MAX_BODY_CHARS = 2000;
const MAX_READ_CHARS = 50_000;
const MAX_RECIPIENTS = 10;

export function defaultStorePath() {
  return join(homedir(), ".smcp", "gmail.json");
}

export function normalizeCredentials({ label, email, password }) {
  const cleanEmail = String(email ?? "").trim().toLowerCase();
  if (!EMAIL.test(cleanEmail)) throw new Error("Escribe un correo válido.");
  const cleanPassword = String(password ?? "").replace(/\s/g, "");
  if (!APP_PASSWORD.test(cleanPassword)) {
    throw new Error("La contraseña de aplicación son 16 letras. No es la contraseña normal de tu cuenta.");
  }
  const cleanLabel = String(label ?? "").trim().slice(0, MAX_LABEL) || cleanEmail;
  return { label: cleanLabel, email: cleanEmail, password: cleanPassword };
}

/** Passwords are written encrypted and are never returned by list(). */
export function createAccountStore({ path = defaultStorePath(), encrypt, decrypt }) {
  const read = async () => {
    try {
      return JSON.parse(await readFile(path, "utf8")).accounts ?? [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("No se pudieron leer las cuentas de Gmail guardadas.");
    }
  };
  const write = async (accounts) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600);
  };
  return {
    async list() {
      return (await read()).map(({ label, email }) => ({ label, email }));
    },
    async add({ label, email, password }) {
      const accounts = await read();
      const others = accounts.filter((account) => account.email !== email);
      if (others.length >= MAX_ACCOUNTS) throw new Error(`Puedes conectar hasta ${MAX_ACCOUNTS} cuentas.`);
      await write([...others, { label, email, secret: encrypt(password) }]);
    },
    async remove(email) {
      await write((await read()).filter((account) => account.email !== email));
    },
    async credentials(email) {
      const account = (await read()).find((item) => item.email === email);
      if (!account) throw new Error("Esa cuenta ya no está conectada.");
      try {
        return { label: account.label, email: account.email, password: decrypt(account.secret) };
      } catch {
        throw new Error("No se pudo leer la contraseña guardada. Desconecta la cuenta y vuelve a conectarla.");
      }
    },
  };
}

export function friendlyMailError(error) {
  const text = `${error?.responseText ?? ""} ${error?.response ?? ""} ${error?.message ?? ""} ${error?.authenticationFailed ? "AUTHENTICATIONFAILED" : ""}`;
  if (/AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted|\b535\b/i.test(text)) {
    return "Google rechazó el acceso. Revisa el correo y crea una contraseña de aplicación nueva.";
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|Connection not available/i.test(text)) {
    return "No se pudo conectar con Gmail. Revisa tu conexión a internet.";
  }
  return "Gmail no pudo completar la acción. Vuelve a intentar.";
}

export function openImap({ email, password }) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });
  // A dropped connection already rejects the command in progress. Without a listener it would also
  // throw as an uncaught exception in the main process.
  client.on("error", () => {});
  return client;
}

function openSmtp({ email, password }) {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: email, pass: password },
  });
}

function addressText(list) {
  return (list ?? []).map(({ name, address }) => (name ? `${name} <${address}>` : address)).join(", ");
}

function plainText(parsed) {
  const text = parsed.text ?? String(parsed.html || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Dependencies are injectable so tests never reach Google or open a dialog. */
export function createGmail({ store, confirm, imap = openImap, smtp = openSmtp }) {
  const resolve = async (reference) => {
    const accounts = await store.list();
    const wanted = String(reference ?? "").trim().toLowerCase();
    const matches = accounts.filter((account) => account.email === wanted || account.label.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error("Hay varias cuentas con ese nombre. Usa el correo.");
    throw new Error("No hay una cuenta conectada con ese nombre. Usa gmail_list_accounts.");
  };

  /** Searches run in All Mail, whose localized name is found through its special-use flag. */
  const withMailbox = async (email, fn) => {
    const client = imap(await store.credentials(email));
    await client.connect();
    try {
      const folders = await client.list();
      const allMail = folders.find((folder) => folder.specialUse === "\\All")?.path ?? "INBOX";
      const lock = await client.getMailboxLock(allMail, { readOnly: true });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  };

  const searchAccount = (account, query, limit) =>
    withMailbox(account.email, async (client) => {
      const found = (await client.search({ gmraw: query }, { uid: true })) || [];
      const uids = found.slice(-limit);
      const messages = [];
      if (uids.length) {
        for await (const message of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
          messages.push({
            account: account.email,
            uid: message.uid,
            from: addressText(message.envelope?.from),
            subject: message.envelope?.subject ?? "",
            date: message.envelope?.date ?? null,
            unread: !message.flags?.has("\\Seen"),
          });
        }
      }
      messages.sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0));
      return { total: found.length, messages };
    });

  return {
    async verifyAndAdd(values) {
      const credentials = normalizeCredentials(values);
      const client = imap(credentials);
      try {
        await client.connect();
      } catch (error) {
        throw new Error(friendlyMailError(error));
      }
      await client.logout().catch(() => {});
      await store.add(credentials);
      return { label: credentials.label, email: credentials.email };
    },

    listAccounts: () => store.list(),
    remove: (email) => store.remove(email),

    /** Without an account, searches them all and reports per-account failures. */
    async search({ account, query, limit = 20 }) {
      const max = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const gmailQuery = String(query || "in:inbox").slice(0, 500);
      const targets = account ? [await resolve(account)] : await store.list();
      if (!targets.length) throw new Error("No hay cuentas de Gmail conectadas. Agrega una desde la app SMCP.");
      const results = await Promise.all(
        targets.map(async (target) => {
          try {
            return await searchAccount(target, gmailQuery, max);
          } catch (error) {
            return { error: { account: target.email, message: friendlyMailError(error) } };
          }
        }),
      );
      return {
        messages: results.flatMap((result) => result.messages ?? []).sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0)),
        totals: Object.fromEntries(targets.map((target, index) => [target.email, results[index].total ?? null])),
        errors: results.flatMap((result) => (result.error ? [result.error] : [])),
      };
    },

    async read({ account, uid }) {
      if (!Number.isInteger(uid) || uid < 1) throw new Error("Identificador de mensaje inválido.");
      const target = await resolve(account);
      try {
        return await withMailbox(target.email, async (client) => {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message?.source) throw new Error("NOT_FOUND");
          const parsed = await simpleParser(message.source);
          const text = plainText(parsed);
          return {
            account: target.email,
            uid,
            from: parsed.from?.text ?? "",
            to: parsed.to?.text ?? "",
            cc: parsed.cc?.text ?? "",
            subject: parsed.subject ?? "",
            date: parsed.date ?? null,
            text: text.slice(0, MAX_READ_CHARS),
            truncated: text.length > MAX_READ_CHARS,
            attachments: (parsed.attachments ?? []).map(({ filename, size }) => ({ filename: filename ?? "sin nombre", size })),
          };
        });
      } catch (error) {
        if (error.message === "NOT_FOUND") throw new Error("No se encontró ese mensaje.");
        throw new Error(friendlyMailError(error));
      }
    },

    /** The dialog lives here, inside the app, so nothing that reaches the socket can skip it. */
    async send({ account, to, subject, body, reply_to_uid: replyToUid }) {
      const target = await resolve(account);
      const recipients = (Array.isArray(to) ? to : [to]).map((item) => String(item ?? "").trim());
      if (!recipients.length || recipients.length > MAX_RECIPIENTS || !recipients.every((item) => EMAIL.test(item))) {
        throw new Error(`Indica de 1 a ${MAX_RECIPIENTS} correos válidos.`);
      }
      const cleanSubject = String(subject ?? "");
      if (/[\r\n]/.test(cleanSubject) || cleanSubject.length > 200) throw new Error("El asunto no es válido.");
      const text = String(body ?? "");
      if (!text.trim()) throw new Error("El mensaje está vacío.");
      if (text.length > MAX_BODY_CHARS) {
        throw new Error(`El mensaje pasa de ${MAX_BODY_CHARS} caracteres y no se vería completo en la ventana de confirmación.`);
      }

      let thread = {};
      if (replyToUid !== undefined) {
        if (!Number.isInteger(replyToUid) || replyToUid < 1) throw new Error("Identificador de mensaje inválido.");
        thread = await withMailbox(target.email, async (client) => {
          const original = await client.fetchOne(String(replyToUid), { envelope: true }, { uid: true });
          const messageId = original?.envelope?.messageId;
          if (!messageId) throw new Error("No se encontró el mensaje a responder.");
          return { inReplyTo: messageId, references: messageId };
        });
      }

      const summary = `De: ${target.label} (${target.email})\nPara: ${recipients.join(", ")}\nAsunto: ${cleanSubject || "(sin asunto)"}\n\nMensaje:\n${text}`;
      if (!(await confirm(summary, "SMCP: enviar correo"))) {
        return { sent: false, reason: "No se confirmó en la ventana de macOS. No se envió nada." };
      }

      const credentials = await store.credentials(target.email);
      const transport = smtp(credentials);
      try {
        const info = await transport.sendMail({
          from: { name: target.label === target.email ? "" : target.label, address: target.email },
          to: recipients,
          subject: cleanSubject,
          text,
          ...thread,
        });
        return { sent: true, id: info.messageId, accepted: info.accepted };
      } catch (error) {
        throw new Error(`${friendlyMailError(error)} El resultado puede ser incierto: revisa Enviados antes de reintentar.`);
      } finally {
        transport.close?.();
      }
    },
  };
}
