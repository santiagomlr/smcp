// Runs only inside SMCP.app, so app passwords never reach the MCP server process that Claude starts.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { bufferText } from "../../src/documents.js";
import { riskyLinks, scanAttachment, securityOn } from "../../src/security/inline.js";

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const APP_PASSWORD = /^[a-zA-Z]{16}$/;
const MAX_ACCOUNTS = 20;
const MAX_LABEL = 40;
const MAX_BODY_CHARS = 2000;
const MAX_READ_CHARS = 50_000;
const MAX_RECIPIENTS = 10;
const MAX_DRAFT_CHARS = 50_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Draft bytes for IMAP APPEND. Replaceable in tests. */
export function composeMessage(mail) {
  return new MailComposer(mail).compile().build();
}

/** "Re: " once, never "Re: Re: ". */
export function replySubject(subject) {
  const clean = String(subject ?? "").replace(/[\r\n]+/g, " ").trim();
  return /^(re|aw|rv|sv)\s*:/i.test(clean) ? clean.slice(0, 200) : `Re: ${clean}`.slice(0, 200);
}

/** Who a reply goes to: the Reply-To or sender, and with reply all, everyone else except this account. */
export function replyRecipients(envelope, self, replyAll = false) {
  const addresses = (list) => (list ?? []).map((item) => String(item.address ?? "").trim().toLowerCase()).filter(Boolean);
  const primary = addresses(envelope?.replyTo).length ? addresses(envelope.replyTo) : addresses(envelope?.from);
  const others = replyAll ? [...addresses(envelope?.to), ...addresses(envelope?.cc)] : [];
  const seen = new Set([String(self).toLowerCase()]);
  const out = [];
  for (const address of [...primary, ...others]) {
    if (seen.has(address) || !EMAIL.test(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

export function defaultStorePath() {
  return join(homedir(), ".smcp", "gmail.json");
}

export function normalizeCredentials({ label, email, password }) {
  const cleanEmail = String(email ?? "").trim().toLowerCase();
  if (!EMAIL.test(cleanEmail)) throw new Error("Enter a valid email address.");
  const cleanPassword = String(password ?? "").replace(/\s/g, "");
  if (!APP_PASSWORD.test(cleanPassword)) {
    throw new Error("An app password is 16 letters. It is not your normal account password.");
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
      throw new Error("Could not read the saved Gmail accounts.");
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
      if (others.length >= MAX_ACCOUNTS) throw new Error(`You can connect up to ${MAX_ACCOUNTS} accounts.`);
      await write([...others, { label, email, secret: encrypt(password) }]);
    },
    async remove(email) {
      await write((await read()).filter((account) => account.email !== email));
    },
    async credentials(email) {
      const account = (await read()).find((item) => item.email === email);
      if (!account) throw new Error("That account is no longer connected.");
      try {
        return { label: account.label, email: account.email, password: decrypt(account.secret) };
      } catch {
        throw new Error("Could not read the saved password. Disconnect the account and connect it again.");
      }
    },
  };
}

export function friendlyMailError(error) {
  const text = `${error?.responseText ?? ""} ${error?.response ?? ""} ${error?.message ?? ""} ${error?.authenticationFailed ? "AUTHENTICATIONFAILED" : ""}`;
  if (/AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted|\b535\b/i.test(text)) {
    return "Google refused access. Check the email address and create a new app password.";
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|Connection not available/i.test(text)) {
    return "Could not connect to Gmail. Check your internet connection.";
  }
  return "Gmail could not complete the action. Try again.";
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
export function createGmail({ store, confirm, imap = openImap, smtp = openSmtp, protect = securityOn }) {
  const resolve = async (reference) => {
    const accounts = await store.list();
    const wanted = String(reference ?? "").trim().toLowerCase();
    const matches = accounts.filter((account) => account.email === wanted || account.label.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error("Several accounts have that name. Use the email address.");
    throw new Error("No connected account has that name. Use gmail_list_accounts.");
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

  /** The original's headers, so a reply or a draft stays in its conversation. */
  const replyContext = (target, uid, replyAll) =>
    withMailbox(target.email, async (client) => {
      if (!Number.isInteger(uid) || uid < 1) throw new Error("Invalid message identifier.");
      const original = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
      const envelope = original?.envelope;
      if (!envelope?.messageId) throw new Error("The message to reply to was not found.");
      return {
        to: replyRecipients(envelope, target.email, replyAll),
        subject: replySubject(envelope.subject),
        inReplyTo: envelope.messageId,
        references: envelope.messageId,
      };
    });

  const cleanRecipients = (to, { allowEmpty = false } = {}) => {
    const recipients = (Array.isArray(to) ? to : to === undefined ? [] : [to]).map((item) => String(item ?? "").trim());
    if ((!allowEmpty && !recipients.length) || recipients.length > MAX_RECIPIENTS || !recipients.every((item) => EMAIL.test(item))) {
      throw new Error(`Give from ${allowEmpty ? 0 : 1} to ${MAX_RECIPIENTS} valid email addresses.`);
    }
    return recipients;
  };

  const api = {
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
      if (!targets.length) throw new Error("No Gmail accounts are connected. Add one from the SMCP app.");
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
      if (!Number.isInteger(uid) || uid < 1) throw new Error("Invalid message identifier.");
      const target = await resolve(account);
      try {
        return await withMailbox(target.email, async (client) => {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message?.source) throw new Error("NOT_FOUND");
          const parsed = await simpleParser(message.source);
          const text = plainText(parsed);
          // The antivirus runs on every email it reads: attachments by their bytes, links by their address.
          const guard = protect();
          const attachments = (parsed.attachments ?? []).map(({ filename, size, content }) => ({
            filename: filename ?? "unnamed",
            size,
            ...(guard ? { security: scanAttachment(content, filename ?? "") } : {}),
          }));
          const links = guard ? riskyLinks(`${text}\n${parsed.html || ""}`) : [];
          const dangerous = attachments.filter((item) => item.security && item.security.verdict !== "clean").length;
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
            attachments,
            ...(guard
              ? {
                  security: {
                    checked: true,
                    flaggedAttachments: dangerous,
                    riskyLinks: links,
                    ...(dangerous || links.length ? { warning: "This email has flagged attachments or links. Warn the person before they open anything." } : {}),
                  },
                }
              : {}),
          };
        });
      } catch (error) {
        if (error.message === "NOT_FOUND") throw new Error("That message was not found.");
        throw new Error(friendlyMailError(error));
      }
    },

    /** The dialog lives here, inside the app, so nothing that reaches the socket can skip it. */
    async send({ account, to, subject, body, reply_to_uid: replyToUid }) {
      const target = await resolve(account);
      const recipients = (Array.isArray(to) ? to : [to]).map((item) => String(item ?? "").trim());
      if (!recipients.length || recipients.length > MAX_RECIPIENTS || !recipients.every((item) => EMAIL.test(item))) {
        throw new Error(`Give from 1 to ${MAX_RECIPIENTS} valid email addresses.`);
      }
      const cleanSubject = String(subject ?? "");
      if (/[\r\n]/.test(cleanSubject) || cleanSubject.length > 200) throw new Error("The subject is not valid.");
      const text = String(body ?? "");
      if (!text.trim()) throw new Error("The message is empty.");
      if (text.length > MAX_BODY_CHARS) {
        throw new Error(`The message is longer than ${MAX_BODY_CHARS} characters and would not be fully visible in the confirmation window.`);
      }

      let thread = {};
      if (replyToUid !== undefined) {
        if (!Number.isInteger(replyToUid) || replyToUid < 1) throw new Error("Invalid message identifier.");
        thread = await withMailbox(target.email, async (client) => {
          const original = await client.fetchOne(String(replyToUid), { envelope: true }, { uid: true });
          const messageId = original?.envelope?.messageId;
          if (!messageId) throw new Error("The message to reply to was not found.");
          return { inReplyTo: messageId, references: messageId };
        });
      }

      const summary = `From: ${target.label} (${target.email})\nTo: ${recipients.join(", ")}\nSubject: ${cleanSubject || "(no subject)"}\n\nMessage:\n${text}`;
      if (!(await confirm(summary, "SMCP: send email"))) {
        return { sent: false, reason: "Not confirmed in the macOS window. Nothing was sent." };
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
        throw new Error(`${friendlyMailError(error)} The outcome may be uncertain: check Sent before retrying.`);
      } finally {
        transport.close?.();
      }
    },

    /** Fills in the recipients and subject from the original, then asks like any other send. */
    async reply({ account, uid, body, reply_all: replyAll = false }) {
      const target = await resolve(account);
      let context;
      try {
        context = await replyContext(target, uid, replyAll);
      } catch (error) {
        throw new Error(/not found|identifier/.test(error.message) ? error.message : friendlyMailError(error));
      }
      if (!context.to.length) throw new Error("That message has no one to reply to.");
      return api.send({ account, to: context.to.slice(0, MAX_RECIPIENTS), subject: context.subject, body, reply_to_uid: uid });
    },

    /**
     * Saves a draft in the account's Drafts folder. Nothing is sent, so no window opens: the person
     * reviews and sends it from Gmail.
     */
    async draft({ account, to, subject, body, reply_to_uid: replyToUid, reply_all: replyAll = false }) {
      const target = await resolve(account);
      const text = String(body ?? "");
      if (!text.trim()) throw new Error("The message is empty.");
      if (text.length > MAX_DRAFT_CHARS) throw new Error(`A draft can have up to ${MAX_DRAFT_CHARS} characters.`);
      let recipients = cleanRecipients(to, { allowEmpty: true });
      let cleanSubject = String(subject ?? "");
      if (/[\r\n]/.test(cleanSubject) || cleanSubject.length > 200) throw new Error("The subject is not valid.");
      let thread = {};
      if (replyToUid !== undefined) {
        const context = await replyContext(target, replyToUid, replyAll).catch((error) => {
          throw new Error(/not found|identifier/.test(error.message) ? error.message : friendlyMailError(error));
        });
        if (!recipients.length) recipients = context.to.slice(0, MAX_RECIPIENTS);
        if (!cleanSubject) cleanSubject = context.subject;
        thread = { inReplyTo: context.inReplyTo, references: context.references };
      }
      const raw = await composeMessage({
        from: { name: target.label === target.email ? "" : target.label, address: target.email },
        to: recipients,
        subject: cleanSubject,
        text,
        ...thread,
      });
      const client = imap(await store.credentials(target.email));
      try {
        await client.connect();
        const folders = await client.list();
        const drafts = folders.find((folder) => folder.specialUse === "\\Drafts")?.path;
        if (!drafts) throw new Error("NO_DRAFTS");
        const saved = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
        return { drafted: true, account: target.email, to: recipients, subject: cleanSubject, folder: drafts, uid: saved?.uid ?? null };
      } catch (error) {
        if (error.message === "NO_DRAFTS") throw new Error("This account has no Drafts folder that SMCP can find.");
        throw new Error(friendlyMailError(error));
      } finally {
        await client.logout().catch(() => {});
      }
    },

    /** An attachment as text: PDFs, Word, RTF, HTML and plain text. Never the raw bytes. */
    async attachment({ account, uid, index }) {
      if (!Number.isInteger(uid) || uid < 1) throw new Error("Invalid message identifier.");
      if (!Number.isInteger(index) || index < 0) throw new Error("Invalid attachment number.");
      const target = await resolve(account);
      let file;
      try {
        file = await withMailbox(target.email, async (client) => {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message?.source) throw new Error("NOT_FOUND");
          const parsed = await simpleParser(message.source);
          const attachment = (parsed.attachments ?? [])[index];
          if (!attachment) throw new Error("NO_ATTACHMENT");
          return { filename: attachment.filename ?? "unnamed", size: attachment.size, content: attachment.content };
        });
      } catch (error) {
        if (error.message === "NOT_FOUND") throw new Error("That message was not found.");
        if (error.message === "NO_ATTACHMENT") throw new Error("That message has no attachment with that number. Count from 0, in the order gmail_read lists them.");
        throw new Error(friendlyMailError(error));
      }
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("That attachment is too large to read.");
      const security = protect() ? scanAttachment(file.content, file.filename) : null;
      // A malicious file is not even converted to text: document readers are a way in for exploits.
      if (security?.verdict === "malicious") {
        return { account: target.email, uid, index, filename: file.filename, blocked: true, security };
      }
      const { text, pages } = await bufferText(file.filename, file.content);
      return {
        account: target.email,
        uid,
        index,
        filename: file.filename,
        ...(pages === undefined ? {} : { pages }),
        text: text.slice(0, MAX_READ_CHARS),
        truncated: text.length > MAX_READ_CHARS,
        ...(security ? { security } : {}),
      };
    },
  };
  return api;
}
