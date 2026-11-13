import { accessSync, constants } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { confirmGate } from "../confirm-gate.js";
import { annotateLinks, MALICIOUS_WARNING, securityOn, SUSPICIOUS_WARNING } from "../security/inline.js";
import { scanPath } from "../security/scanner.js";
import { viaHelper } from "../helper.js";
import { createRelay, MEDIA_ELSEWHERE, SEND_ELSEWHERE } from "../whatsapp-relay.js";
import { errorResult, externalResult, run, textResult } from "../util.js";
import { modelPath, modelReady, whisperBin } from "../whisper.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_MESSAGE_CHARS = 2000;
const JID = /^[0-9A-Za-z.:_-]+@(s\.whatsapp\.net|g\.us|lid|newsletter)$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,24}$/;
const MESSAGE_ID = /^[0-9A-Za-z_-]{6,128}$/;
const LANGUAGE = /^(auto|[a-z]{2})$/;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CAPTION_CHARS = 1000;
const DIGEST_PAGE = 200;
const DIGEST_TEXT_CHARS = 1000;

export function storeDir() {
  return process.env.WACLI_STORE_DIR || join(homedir(), ".smcp", "wacli");
}

/** Transcripts of voice notes, kept so they can be searched later. Deleted with the WhatsApp session. */
export function transcriptsPath() {
  return process.env.SMCP_TRANSCRIPTS || join(homedir(), ".smcp", "transcripts.jsonl");
}

export async function saveTranscript(entry, path = transcriptsPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** The newest transcript of each message wins, so transcribing again replaces the old text. */
export async function readTranscripts(path = transcriptsPath()) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const byMessage = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.chat && entry?.id && typeof entry.transcript === "string") byMessage.set(`${entry.chat}/${entry.id}`, entry);
    } catch {
      // A damaged line is skipped.
    }
  }
  return [...byMessage.values()];
}

const fold = (text) => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Every word must appear, ignoring accents. Newest first. */
export function searchTranscripts(entries, { query, chat, limit = 20 }) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => (!chat || entry.chat === chat) && terms.every((term) => fold(entry.transcript).includes(term)))
    .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")))
    .slice(0, limit);
}

/** One short line per message, oldest first, so a whole stretch of a chat fits in little space. */
export function compactMessage(message) {
  const text = message.Text || message.DisplayText || message.MediaCaption || "";
  return {
    id: message.MsgID,
    at: message.Timestamp,
    from: message.FromMe ? "me" : message.SenderName || message.SenderJID || "",
    ...(text ? { text: text.length > DIGEST_TEXT_CHARS ? `${text.slice(0, DIGEST_TEXT_CHARS)}…` : text } : {}),
    ...(message.MediaType ? { media: message.MediaType } : {}),
    ...(message.Filename ? { file: message.Filename } : {}),
    ...(message.ReactionEmoji ? { reaction: message.ReactionEmoji } : {}),
    ...(message.QuotedMsgID ? { reply_to: message.QuotedMsgID } : {}),
  };
}

export function wacliBin() {
  if (process.env.WACLI_BIN) return process.env.WACLI_BIN;
  const vendored = join(PROJECT_ROOT, "vendor", "bin", "wacli");
  try {
    accessSync(vendored, constants.X_OK);
    return vendored;
  } catch {
    return "wacli";
  }
}

/** Only exact JIDs and phone numbers: names can be ambiguous and wacli resolves them on its own. */
export function isValidRecipient(recipient) {
  return JID.test(recipient) || PHONE.test(recipient);
}

/** Shows the dialog from SMCP.app when possible. Any failure counts as not confirmed. */
export async function confirmWithDialog(body) {
  try {
    const confirmed = await viaHelper("confirm", { body }, () => localConfirm(body));
    return confirmed === true;
  } catch {
    return false;
  }
}

/** Native macOS dialog. Returns true only if a person pressed the send button; Cancel is the default. */
export async function localConfirm(body, title = "SMCP: send WhatsApp", { cancel = "Cancel", send = "Send" } = {}) {
  const script = `on run argv
  set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {item 3 of argv, item 4 of argv} default button 1 cancel button 1 giving up after 120 with icon caution
  if gave up of r then return "TIMEOUT"
  return button returned of r
end run`;
  const result = await confirmGate.confirm(() => run("/usr/bin/osascript", ["-e", script, body, title, cancel, send], { timeoutMs: 130_000 }));
  return result.code === 0 && result.stdout.trim() === send;
}

function wacliFailure(result, action) {
  if (result.spawnError?.code === "ENOENT") {
    return "wacli is not installed. Run `npm run whatsapp:install` in the project folder.";
  }
  if (result.timedOut) return `${action}: timed out.`;
  // wacli writes its JSON error envelope to stderr or stdout depending on the command.
  const parsed = parseJson(result.stderr) ?? parseJson(result.stdout);
  const detail = String(parsed?.error || result.stderr || result.stdout).trim().slice(0, 2000);
  if (/wacli\.db: no such file|not authenticated/.test(detail)) {
    return `WhatsApp is not linked. Run \`npm run whatsapp:login\` in the project folder and scan the QR code.\nDetail: ${detail}`;
  }
  return `${action} failed: ${detail}`;
}

/** The store lock is held, which in SMCP means the app's continuous sync is running. */
export function isLiveSyncRunning(result) {
  return !succeeded(result) && /store is locked/.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

/** wacli's JSON envelope can report failure, so the exit code alone is not enough. */
function succeeded(result) {
  return result.code === 0 && !result.timedOut && parseJson(result.stdout)?.success !== false;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Dependencies are injectable so tests never touch a real account or open a dialog. */
export function createWhatsApp({
  exec = run,
  confirm = confirmWithDialog,
  transcripts = transcriptsPath(),
  resolvePath,
  protect = securityOn,
  scan = scanPath,
  relay = createRelay({ localDoctor: () => exec(wacliBin(), [`--store=${storeDir()}`, "--read-only", "--json", "doctor"], { timeoutMs: 10_000 }) }),
} = {}) {
  const local = (args, timeoutMs) => exec(wacliBin(), [`--store=${storeDir()}`, ...args], { timeoutMs });
  // Without a session here, the computer where WhatsApp is linked answers instead of this one's old copy.
  const wacli = async (args, timeoutMs = 30_000) => (relay ? await relay.run(args, timeoutMs) : null) ?? local(args, timeoutMs);
  /** Says so before any window opens when WhatsApp lives on another computer. */
  const elsewhere = async () => Boolean(relay) && !(await relay.linkedHere());

  const read = async (args, action) => {
    const result = await wacli(["--read-only", "--json", ...args]);
    if (!succeeded(result)) return errorResult(wacliFailure(result, action));
    const parsed = parseJson(result.stdout);
    return externalResult(parsed ? guardLinks(parsed.data) : result.stdout);
  };

  /** Marks messages with phishing links, unless the person turned the antivirus off. */
  const guardLinks = (data) => (protect() ? annotateLinks(data).value : data);

  const lookup = async (args) => {
    const result = await wacli(["--read-only", "--json", ...args]);
    return succeeded(result) ? parseJson(result.stdout)?.data : null;
  };

  /** Best effort, so the person sees a name in the dialog. Falls back to the raw recipient. */
  const displayName = async (recipient) => {
    if (JID.test(recipient)) {
      const chat = await lookup(["chats", "show", `--jid=${recipient}`]);
      if (chat?.name && chat.name !== recipient) return chat.name;
    }
    const digits = recipient.split("@")[0].replace(/\D/g, "");
    if (!digits || recipient.endsWith("@g.us")) return null;
    const contacts = await lookup(["contacts", "search", "--limit=2", "--", digits]);
    if (!Array.isArray(contacts) || contacts.length !== 1) return null;
    const [contact] = contacts;
    return contact.alias || contact.system_name || contact.name || null;
  };

  const send = async ({ to, message }) => {
    if (await elsewhere()) return errorResult(SEND_ELSEWHERE);
    const recipient = to.trim();
    if (!isValidRecipient(recipient)) {
      return errorResult(
        "`to` must be a JID or a phone number. Use whatsapp_search_contacts or whatsapp_list_chats to get it.",
      );
    }
    if (!message.trim()) return errorResult("The message is empty.");
    if (message.length > MAX_MESSAGE_CHARS) {
      return errorResult(
        `The message is longer than ${MAX_MESSAGE_CHARS} characters and would not be fully visible in the confirmation window.`,
      );
    }

    const name = await displayName(recipient);
    const header = name ? `To: ${name} (${recipient})` : `To: ${recipient}`;
    if (!(await confirm(`${header}\n\nMessage:\n${message}`))) {
      return textResult({ sent: false, reason: "Not confirmed in the macOS window. Nothing was sent." });
    }

    const result = await wacli(
      ["--json", "send", "text", `--to=${recipient}`, `--message=${message}`],
      60_000,
    );
    if (!succeeded(result)) {
      return errorResult(
        `${wacliFailure(result, "Send")}\nThe outcome may be uncertain: check the chat before retrying.`,
      );
    }
    return textResult(parseJson(result.stdout) ?? result.stdout);
  };

  /** The audio lives only in a temporary folder; the store never records it. */
  const transcribe = async ({ chat, id, language = "auto" }) => {
    const bin = whisperBin();
    if (!bin || !modelReady()) {
      return errorResult("Listening to audio is not ready on this computer yet. Turn it on in SMCP, under Settings.");
    }
    if (await elsewhere()) return errorResult(MEDIA_ELSEWHERE);
    const message = await lookup(["messages", "show", `--chat=${chat}`, `--id=${id}`]);
    if (!message) return errorResult("That message is not among the saved ones. Try whatsapp_sync.");
    if (message.MediaType !== "audio") return errorResult("That message is not audio.");

    const folder = await mkdtemp(join(tmpdir(), "smcp-audio-"));
    try {
      const audio = join(folder, "audio.ogg");
      const wave = join(folder, "audio.wav");
      const download = await wacli(["--read-only", "--json", "media", "download", `--chat=${chat}`, `--id=${id}`, `--output=${audio}`], 120_000);
      if (!succeeded(download)) return errorResult(wacliFailure(download, "Download audio"));

      const decoded = await exec("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", audio, wave], { timeoutMs: 60_000 });
      if (decoded.code !== 0) return errorResult("Could not open the audio on this computer.");

      const heard = await exec(bin, ["-m", modelPath(), "-f", wave, "-l", language, "-nt", "-np"], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
      if (heard.timedOut) return errorResult("The audio took too long to transcribe.");
      if (heard.code !== 0) return errorResult("Could not transcribe the audio.");
      const text = heard.stdout.replace(/\[BLANK_AUDIO\]/g, "").trim();
      const entry = { chat, id, sender: message.SenderName, timestamp: message.Timestamp, transcript: text || "(no speech detected)" };
      if (text) await saveTranscript(entry, transcripts).catch(() => {});
      return externalResult(entry);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  /** Same checks and the same window as a text message, plus the file's name and size. */
  const sendFile = async ({ to, path, caption = "" }) => {
    if (await elsewhere()) return errorResult(SEND_ELSEWHERE);
    const recipient = to.trim();
    if (!isValidRecipient(recipient)) {
      return errorResult("`to` must be a JID or a phone number. Use whatsapp_search_contacts or whatsapp_list_chats to get it.");
    }
    if (caption.length > MAX_CAPTION_CHARS) return errorResult(`The caption can have up to ${MAX_CAPTION_CHARS} characters.`);
    let file;
    try {
      const resolve = resolvePath ?? (await import("./files.js")).resolveSafe;
      file = await resolve(path);
    } catch (error) {
      return errorResult(error.code === "ENOENT" ? "That file does not exist." : error.message);
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return errorResult("That path is not a file.");
    if (info.size > MAX_FILE_BYTES) return errorResult("That file is larger than 100 MB.");

    const name = await displayName(recipient);
    const header = name ? `To: ${name} (${recipient})` : `To: ${recipient}`;
    const size = info.size >= 1024 * 1024 ? `${(info.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(info.size / 1024))} KB`;
    const shown = `${header}\n\nFile: ${basename(file)} (${size})\nFolder: ${dirname(file).replace(homedir(), "~")}${caption ? `\n\nCaption:\n${caption}` : ""}`;
    if (!(await confirm(shown))) {
      return textResult({ sent: false, reason: "Not confirmed in the macOS window. Nothing was sent." });
    }
    const args = ["--json", "send", "file", `--to=${recipient}`, `--file=${file}`, "--max-size-mb=100"];
    if (caption) args.push(`--caption=${caption}`);
    const result = await wacli(args, 300_000);
    if (!succeeded(result)) {
      return errorResult(`${wacliFailure(result, "Send file")}\nThe outcome may be uncertain: check the chat before retrying.`);
    }
    return textResult(parseJson(result.stdout) ?? result.stdout);
  };

  /** Walks the pages of a stretch of a chat and returns it oldest first, in compact lines. */
  const digest = async ({ chat, after, before, limit = 500 }) => {
    const collected = [];
    let cursor;
    while (collected.length < limit) {
      const args = ["--read-only", "--json", "messages", "list", `--chat=${chat}`, `--limit=${Math.min(DIGEST_PAGE, limit - collected.length)}`];
      if (after) args.push(`--after=${after}`);
      if (before) args.push(`--before=${before}`);
      if (cursor) args.push(`--cursor=${cursor}`);
      const result = await wacli(args);
      if (!succeeded(result)) return errorResult(wacliFailure(result, "Read messages"));
      const data = parseJson(result.stdout)?.data ?? {};
      const page = Array.isArray(data.messages) ? data.messages : [];
      collected.push(...page.filter((message) => !message.ReactionToID && !message.Revoked));
      cursor = data.page?.next_cursor;
      if (!cursor || !page.length) break;
    }
    const messages = collected.slice(0, limit).reverse().map(compactMessage);
    return externalResult({
      chat,
      count: messages.length,
      from: messages[0]?.at ?? null,
      to: messages.at(-1)?.at ?? null,
      complete: !cursor || collected.length < limit,
      messages: guardLinks(messages),
    });
  };

  /**
   * Downloads a received file to a private temporary folder, scans it without opening it and deletes
   * it. Nothing is kept and the file never reaches the AI, only the verdict does.
   */
  const scanFile = async ({ chat, id }) => {
    if (!protect()) return errorResult("The antivirus is turned off in SMCP settings.");
    if (await elsewhere()) return errorResult(MEDIA_ELSEWHERE);
    const message = await lookup(["messages", "show", `--chat=${chat}`, `--id=${id}`]);
    if (!message) return errorResult("That message is not among the saved ones. Try whatsapp_sync.");
    if (!message.MediaType) return errorResult("That message has no file.");
    const name = basename(String(message.Filename || `file-${id}`)).replace(/[\/\0]/g, "_") || `file-${id}`;
    const folder = await mkdtemp(join(tmpdir(), "smcp-scan-"));
    try {
      await chmod(folder, 0o700);
      const target = join(folder, name);
      const download = await wacli(["--read-only", "--json", "media", "download", `--chat=${chat}`, `--id=${id}`, `--output=${target}`], 180_000);
      if (!succeeded(download)) return errorResult(wacliFailure(download, "Download file"));
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) return errorResult("The file could not be downloaded.");
      if (info.size > MAX_FILE_BYTES) return errorResult("That file is too large to scan.");
      const result = await scan(target);
      return externalResult({
        chat,
        id,
        file: name,
        media: message.MediaType,
        from: message.SenderName || message.SenderJID || "",
        size: info.size,
        verdict: result.verdict,
        score: result.score,
        type: result.kindLabel,
        sha256: result.sha256,
        findings: result.findings.map((finding) => finding.title),
        ...(result.verdict === "malicious" ? { warning: MALICIOUS_WARNING } : result.verdict === "suspicious" ? { warning: SUSPICIOUS_WARNING } : {}),
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  const findTranscripts = async (args) => externalResult({ transcripts: searchTranscripts(await readTranscripts(transcripts), args) });

  return { read, send, sendFile, digest, findTranscripts, transcribe, scanFile, wacli };
}

export function registerWhatsApp(server) {
  const { read, send, sendFile, digest, findTranscripts, transcribe, scanFile, wacli } = createWhatsApp();
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const limit = (fallback) => z.number().int().min(1).max(200).default(fallback);

  server.registerTool(
    "whatsapp_status",
    {
      description:
        "WhatsApp status: whether it is linked, counts and the last full sync. A held lock means the SMCP app is saving new messages continuously. " +
        "If WhatsApp is linked on another of the person's computers, this computer reads from that one and the answer describes it.",
      annotations: readOnly,
    },
    () => read(["doctor"], "Diagnostics"),
  );

  server.registerTool(
    "whatsapp_list_chats",
    {
      description: "Lists locally saved chats, most recent first. Useful for getting the JID.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Filters by name or JID."),
        unread_only: z.boolean().default(false),
        limit: limit(20),
      },
      annotations: readOnly,
    },
    ({ query, unread_only, limit }) => {
      const args = ["chats", "list", `--limit=${limit}`];
      if (query) args.push(`--query=${query}`);
      if (unread_only) args.push("--unread");
      return read(args, "List chats");
    },
  );

  server.registerTool(
    "whatsapp_read_messages",
    {
      description:
        "Reads saved messages from a chat, most recent first. Messages with links that look like phishing are marked under security; " +
        "scan received files with whatsapp_scan_file before the person opens them.",
      inputSchema: {
        chat: z.string().regex(JID).describe("Chat JID."),
        limit: limit(50),
        after: z.string().max(40).optional().describe("Earliest date, for example 2026-11-01."),
        before: z.string().max(40).optional().describe("Latest date."),
        cursor: z.string().max(500).optional().describe("next_cursor from the previous page."),
      },
      annotations: readOnly,
    },
    ({ chat, limit, after, before, cursor }) => {
      const args = ["messages", "list", `--chat=${chat}`, `--limit=${limit}`];
      if (after) args.push(`--after=${after}`);
      if (before) args.push(`--before=${before}`);
      if (cursor) args.push(`--cursor=${cursor}`);
      return read(args, "Read messages");
    },
  );

  server.registerTool(
    "whatsapp_search_messages",
    {
      description: "Searches text in locally saved messages.",
      inputSchema: {
        query: z.string().min(1).max(200),
        chat: z.string().regex(JID).optional().describe("Limits the search to one chat."),
        limit: limit(20),
      },
      annotations: readOnly,
    },
    ({ query, chat, limit }) => {
      const args = ["messages", "search", `--limit=${limit}`];
      if (chat) args.push(`--chat=${chat}`);
      args.push("--", query);
      return read(args, "Search messages");
    },
  );

  server.registerTool(
    "whatsapp_transcribe_audio",
    {
      description:
        "Turns a voice note into text, on this computer and at no cost. Use it with messages whose MediaType is audio in whatsapp_read_messages.",
      inputSchema: {
        chat: z.string().regex(JID).describe("Chat JID."),
        id: z.string().regex(MESSAGE_ID).describe("Message MsgID."),
        language: z.string().regex(LANGUAGE).default("auto").describe("Language code, for example es, or auto to detect it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    transcribe,
  );

  server.registerTool(
    "whatsapp_search_contacts",
    {
      description: "Searches contacts by name or phone number. Useful for getting the JID.",
      inputSchema: { query: z.string().min(1).max(200), limit: limit(20) },
      annotations: readOnly,
    },
    ({ query, limit }) => read(["contacts", "search", `--limit=${limit}`, "--", query], "Search contacts"),
  );

  server.registerTool(
    "whatsapp_sync",
    {
      description:
        "Brings new WhatsApp messages into the local database. Usually not needed: while the SMCP app is open, messages are saved continuously as they arrive. " +
        "While that runs, whatsapp_status shows the lock held and this tool returns at once. Otherwise it can take a couple of minutes.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const result = await wacli(["--json", "sync", "--once", "--idle-exit=30s"], 240_000);
      if (isLiveSyncRunning(result)) {
        return textResult({ synced: true, continuous: true, note: "The SMCP app is already saving messages as they arrive, so the local database is current." });
      }
      if (!succeeded(result)) return errorResult(wacliFailure(result, "Sync"));
      return textResult({ synced: true, truncated_output: result.truncated });
    },
  );

  server.registerTool(
    "whatsapp_chat_digest",
    {
      description:
        "Returns a stretch of a chat between two dates, oldest first, as one short line per message, ready to summarize. Walks every page on its own, up to `limit` messages.",
      inputSchema: {
        chat: z.string().regex(JID).describe("Chat JID."),
        after: z.string().max(40).describe("Earliest date, for example 2026-11-01."),
        before: z.string().max(40).optional().describe("Latest date. By default, now."),
        limit: z.number().int().min(1).max(2000).default(500),
      },
      annotations: readOnly,
    },
    digest,
  );

  server.registerTool(
    "whatsapp_search_transcripts",
    {
      description: "Searches the text of voice notes already transcribed with whatsapp_transcribe_audio. Every word must appear; accents are ignored.",
      inputSchema: {
        query: z.string().min(1).max(200),
        chat: z.string().regex(JID).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: readOnly,
    },
    findTranscripts,
  );

  server.registerTool(
    "whatsapp_scan_file",
    {
      description:
        "Antivirus scan of a file someone sent on WhatsApp (document, photo, video), without opening it. Use it on messages with media or a file " +
        "before the person opens them, especially from unknown senders. The file is deleted after the scan; only the verdict comes back.",
      inputSchema: {
        chat: z.string().regex(JID).describe("Chat JID."),
        id: z.string().regex(MESSAGE_ID).describe("Message MsgID."),
      },
      annotations: readOnly,
    },
    scanFile,
  );

  server.registerTool(
    "whatsapp_send_file",
    {
      description:
        "Sends a file from this computer (photo, video, PDF, document) with an optional caption. Opens a macOS window with the recipient, the file name and size, and sends only if the person presses Send.",
      inputSchema: {
        to: z.string().max(100).describe("JID or phone number with country code."),
        path: z.string().min(1).max(1000).describe("Absolute path or one that starts with ~/."),
        caption: z.string().max(MAX_CAPTION_CHARS).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    sendFile,
  );

  server.registerTool(
    "whatsapp_send",
    {
      description:
        "Sends a text message. Opens a macOS window and sends only if the person presses Send; if they cancel or do not answer, nothing is sent.",
      inputSchema: {
        to: z.string().max(100).describe("JID or phone number with country code."),
        message: z.string().min(1).max(MAX_MESSAGE_CHARS),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    send,
  );
}
