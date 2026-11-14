// Runs only inside SMCP.app, so app passwords never reach the MCP server process that Claude starts.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { gmailIdToHex, stripHtml } from "../../src/brain/gmail-export.js";
import { bufferText } from "../../src/documents.js";
import { notConfirmed } from "../../src/origin.js";
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
const MAX_EXPORT = 500;
// What the vault export leaves out, in Gmail's own search syntax.
const EXPORT_QUERY = "-in:spam -in:trash -in:drafts -category:promotions -category:social -category:forums";

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

/** RFC 2047 words ("=?UTF-8?Q?Jos=C3=A9?=") to text. A word in a charset this computer does not know stays as written. */
function decodeHeaderWords(value) {
  const word = /=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi;
  return value
    .replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bq]\?[^?\s]*\?=)/gi, "$1")
    .replace(/(?:=\?[^?\s]+\?[bq]\?[^?\s]*\?=)+/gi, (run) => {
      // Neighbouring words in one charset are joined before decoding: a character may be split across them.
      const pieces = [];
      for (const [, charset, encoding, text] of run.matchAll(word)) {
        const name = charset.split("*")[0].toLowerCase();
        const bytes =
          encoding.toLowerCase() === "b"
            ? Buffer.from(text, "base64")
            : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
        if (pieces.at(-1)?.name === name) pieces.at(-1).bytes.push(bytes);
        else pieces.push({ name, bytes: [bytes] });
      }
      try {
        return pieces.map(({ name, bytes }) => new TextDecoder(name).decode(Buffer.concat(bytes))).join("");
      } catch {
        return run;
      }
    });
}

/**
 * A header the way the Gmail API shows it: unfolded and decoded, otherwise as the sender wrote it.
 * mailparser's own `from.text` is rebuilt from the parsed addresses and adds quotes that were not there.
 */
function headerText(parsed, key) {
  const line = (parsed.headerLines ?? []).find((item) => item.key === key)?.line ?? "";
  const value = line.replace(/^[^:]*:/, "").replace(/(?:\r?\n|\r)[ \t]*/g, " ").trim();
  // Header lines arrive one byte per character, so UTF-8 written without encoding is restored here.
  return decodeHeaderWords(Buffer.from(value, "latin1").toString()).trim();
}

/** Gmail's own id for a fetched message, in the hex form its API uses. Any other kind of id is a failure, not a guess. */
function exportId(item) {
  if (!/^\d+$/.test(String(item?.emailId ?? ""))) throw new Error("BAD_EXPORT");
  return gmailIdToHex(item.emailId);
}

/** One fetched message as the vault export needs it. */
async function exportedMessage(item) {
  const id = exportId(item);
  if (!item.source || !(item.internalDate instanceof Date)) throw new Error("BAD_EXPORT");
  // The HTML is kept as it came: converting it or inlining its images would only be thrown away.
  const parsed = await simpleParser(item.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, keepCidLinks: true });
  const labels = [...(item.labels ?? []), ...(item.flags ?? [])].map((label) => String(label).toLowerCase());
  return {
    id,
    date: item.internalDate.getTime(),
    sent: labels.includes("\\sent"),
    draft: labels.includes("\\draft"),
    from: headerText(parsed, "from"),
    to: headerText(parsed, "to"),
    subject: String(parsed.subject ?? ""),
    text: String(parsed.text ?? "").trim() || stripHtml(parsed.html),
    // Only named parts count, with the type the sender declared rather than one guessed from the name.
    attachments: (parsed.attachments ?? [])
      .filter((attachment) => attachment.filename)
      .map((attachment) => ({
        filename: attachment.filename,
        contentType: String(attachment.headers?.get("content-type")?.value || attachment.contentType || "").toLowerCase(),
        size: attachment.size ?? 0,
      })),
  };
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
            to: addressText(message.envelope?.to),
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

    /**
     * Mail since a moment, oldest first, for the vault export. `known` is a Set of ids that are already
     * in the notes: those are not downloaded again. Drafts come back flagged rather than hidden, so the
     * caller can drop them even if the search let one through. When more new mail matched than one call
     * takes, the oldest is returned and `total` says how much there was.
     */
    async exportSince({ account, since, limit = MAX_EXPORT, known }) {
      const target = await resolve(account);
      const from = new Date(since ?? NaN).getTime();
      if (!Number.isFinite(from)) throw new Error("Give a valid start date.");
      const max = Math.min(Math.max(Number(limit) || MAX_EXPORT, 1), MAX_EXPORT);
      try {
        return await withMailbox(target.email, async (client) => {
          const found = await client.search({ gmraw: `after:${Math.floor(from / 1000)} ${EXPORT_QUERY}` }, { uid: true });
          // A refused search answers false. Reading that as "no mail" would hide the failure.
          if (!Array.isArray(found)) throw new Error("SEARCH_REFUSED");
          let fresh = [...found].sort((a, b) => a - b);
          if (known?.size && fresh.length) {
            // Ids first: a run every few minutes must not download the whole day again each time.
            const unseen = [];
            for await (const item of client.fetch(fresh, { uid: true }, { uid: true })) {
              if (!known.has(exportId(item))) unseen.push(item.uid);
            }
            fresh = unseen;
          }
          const uids = fresh.slice(0, max);
          const messages = [];
          if (uids.length) {
            const wanted = { uid: true, flags: true, internalDate: true, labels: true, source: true };
            for await (const item of client.fetch(uids, wanted, { uid: true })) messages.push(await exportedMessage(item));
          }
          if (messages.length !== uids.length) throw new Error("BAD_EXPORT");
          messages.sort((a, b) => a.date - b.date);
          return { account: target.email, total: fresh.length, messages };
        });
      } catch (error) {
        if (error.message === "BAD_EXPORT") throw new Error("Gmail did not return every message with its id, date and content. Nothing was exported.");
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
        return { sent: false, reason: notConfirmed() };
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
