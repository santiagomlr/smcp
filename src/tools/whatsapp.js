import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { confirmGate } from "../confirm-gate.js";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, run, textResult } from "../util.js";
import { modelPath, modelReady, whisperBin } from "../whisper.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_MESSAGE_CHARS = 2000;
const JID = /^[0-9A-Za-z.:_-]+@(s\.whatsapp\.net|g\.us|lid|newsletter)$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,24}$/;
const MESSAGE_ID = /^[0-9A-Za-z_-]{6,128}$/;
const LANGUAGE = /^(auto|[a-z]{2})$/;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;

export function storeDir() {
  return process.env.WACLI_STORE_DIR || join(homedir(), ".smcp", "wacli");
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

/** Native macOS dialog. Returns true only if a person pressed "Enviar". */
export async function localConfirm(body, title = "SMCP: enviar WhatsApp") {
  const script = `on run argv
  set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Cancelar", "Enviar"} default button "Cancelar" cancel button "Cancelar" giving up after 120 with icon caution
  if gave up of r then return "TIMEOUT"
  return button returned of r
end run`;
  const result = await confirmGate.confirm(() => run("/usr/bin/osascript", ["-e", script, body, title], { timeoutMs: 130_000 }));
  return result.code === 0 && result.stdout.trim() === "Enviar";
}

function wacliFailure(result, action) {
  if (result.spawnError?.code === "ENOENT") {
    return "wacli no está instalado. Corre `npm run whatsapp:install` en la carpeta del proyecto.";
  }
  if (result.timedOut) return `${action}: se agotó el tiempo de espera.`;
  // wacli writes its JSON error envelope to stderr or stdout depending on the command.
  const parsed = parseJson(result.stderr) ?? parseJson(result.stdout);
  const detail = String(parsed?.error || result.stderr || result.stdout).trim().slice(0, 2000);
  if (/wacli\.db: no such file|not authenticated/.test(detail)) {
    return `WhatsApp no está vinculado. Corre \`npm run whatsapp:login\` en la carpeta del proyecto y escanea el QR.\nDetalle: ${detail}`;
  }
  return `${action} falló: ${detail}`;
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
export function createWhatsApp({ exec = run, confirm = confirmWithDialog } = {}) {
  const wacli = (args, timeoutMs = 30_000) =>
    exec(wacliBin(), [`--store=${storeDir()}`, ...args], { timeoutMs });

  const read = async (args, action) => {
    const result = await wacli(["--read-only", "--json", ...args]);
    if (!succeeded(result)) return errorResult(wacliFailure(result, action));
    const parsed = parseJson(result.stdout);
    return externalResult(parsed ? parsed.data : result.stdout);
  };

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
    const recipient = to.trim();
    if (!isValidRecipient(recipient)) {
      return errorResult(
        "`to` debe ser un JID o un teléfono. Usa whatsapp_search_contacts o whatsapp_list_chats para obtenerlo.",
      );
    }
    if (!message.trim()) return errorResult("El mensaje está vacío.");
    if (message.length > MAX_MESSAGE_CHARS) {
      return errorResult(
        `El mensaje pasa de ${MAX_MESSAGE_CHARS} caracteres y no se vería completo en la ventana de confirmación.`,
      );
    }

    const name = await displayName(recipient);
    const header = name ? `Para: ${name} (${recipient})` : `Para: ${recipient}`;
    if (!(await confirm(`${header}\n\nMensaje:\n${message}`))) {
      return textResult({ sent: false, reason: "No se confirmó en la ventana de macOS. No se envió nada." });
    }

    const result = await wacli(
      ["--json", "send", "text", `--to=${recipient}`, `--message=${message}`],
      60_000,
    );
    if (!succeeded(result)) {
      return errorResult(
        `${wacliFailure(result, "El envío")}\nEl resultado puede ser incierto: revisa el chat antes de reintentar.`,
      );
    }
    return textResult(parseJson(result.stdout) ?? result.stdout);
  };

  /** The audio lives only in a temporary folder; the store never records it. */
  const transcribe = async ({ chat, id, language = "auto" }) => {
    const bin = whisperBin();
    if (!bin || !modelReady()) {
      return errorResult("Escuchar audios aún no está listo en esta computadora. Enciéndelo en SMCP, en Ajustes.");
    }
    const message = await lookup(["messages", "show", `--chat=${chat}`, `--id=${id}`]);
    if (!message) return errorResult("No encontré ese mensaje entre los guardados. Prueba con whatsapp_sync.");
    if (message.MediaType !== "audio") return errorResult("Ese mensaje no es un audio.");

    const folder = await mkdtemp(join(tmpdir(), "smcp-audio-"));
    try {
      const audio = join(folder, "audio.ogg");
      const wave = join(folder, "audio.wav");
      const download = await wacli(["--read-only", "--json", "media", "download", `--chat=${chat}`, `--id=${id}`, `--output=${audio}`], 120_000);
      if (!succeeded(download)) return errorResult(wacliFailure(download, "Descargar el audio"));

      const decoded = await exec("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", audio, wave], { timeoutMs: 60_000 });
      if (decoded.code !== 0) return errorResult("No se pudo abrir el audio en esta computadora.");

      const heard = await exec(bin, ["-m", modelPath(), "-f", wave, "-l", language, "-nt", "-np"], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
      if (heard.timedOut) return errorResult("El audio tardó demasiado en transcribirse.");
      if (heard.code !== 0) return errorResult("No se pudo transcribir el audio.");
      const text = heard.stdout.replace(/\[BLANK_AUDIO\]/g, "").trim();
      return externalResult({ chat, id, sender: message.SenderName, timestamp: message.Timestamp, transcript: text || "(no se detectó voz)" });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  return { read, send, transcribe, wacli };
}

export function registerWhatsApp(server) {
  const { read, send, transcribe, wacli } = createWhatsApp();
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const limit = (fallback) => z.number().int().min(1).max(200).default(fallback);

  server.registerTool(
    "whatsapp_status",
    {
      description: "Estado de WhatsApp: si está vinculado, última sincronización y conteos locales.",
      annotations: readOnly,
    },
    () => read(["doctor"], "El diagnóstico"),
  );

  server.registerTool(
    "whatsapp_list_chats",
    {
      description: "Lista chats guardados localmente, los más recientes primero. Sirve para obtener el JID.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Filtra por nombre o JID."),
        unread_only: z.boolean().default(false),
        limit: limit(20),
      },
      annotations: readOnly,
    },
    ({ query, unread_only, limit }) => {
      const args = ["chats", "list", `--limit=${limit}`];
      if (query) args.push(`--query=${query}`);
      if (unread_only) args.push("--unread");
      return read(args, "Listar chats");
    },
  );

  server.registerTool(
    "whatsapp_read_messages",
    {
      description: "Lee mensajes guardados de un chat, los más recientes primero.",
      inputSchema: {
        chat: z.string().regex(JID).describe("JID del chat."),
        limit: limit(50),
        after: z.string().max(40).optional().describe("Fecha mínima, por ejemplo 2026-11-01."),
        before: z.string().max(40).optional().describe("Fecha máxima."),
        cursor: z.string().max(500).optional().describe("next_cursor de la página anterior."),
      },
      annotations: readOnly,
    },
    ({ chat, limit, after, before, cursor }) => {
      const args = ["messages", "list", `--chat=${chat}`, `--limit=${limit}`];
      if (after) args.push(`--after=${after}`);
      if (before) args.push(`--before=${before}`);
      if (cursor) args.push(`--cursor=${cursor}`);
      return read(args, "Leer mensajes");
    },
  );

  server.registerTool(
    "whatsapp_search_messages",
    {
      description: "Busca texto en los mensajes guardados localmente.",
      inputSchema: {
        query: z.string().min(1).max(200),
        chat: z.string().regex(JID).optional().describe("Limita la búsqueda a un chat."),
        limit: limit(20),
      },
      annotations: readOnly,
    },
    ({ query, chat, limit }) => {
      const args = ["messages", "search", `--limit=${limit}`];
      if (chat) args.push(`--chat=${chat}`);
      args.push("--", query);
      return read(args, "Buscar mensajes");
    },
  );

  server.registerTool(
    "whatsapp_transcribe_audio",
    {
      description:
        "Convierte en texto una nota de voz, en esta computadora y sin costo. Úsala con mensajes cuyo MediaType sea audio en whatsapp_read_messages.",
      inputSchema: {
        chat: z.string().regex(JID).describe("JID del chat."),
        id: z.string().regex(MESSAGE_ID).describe("MsgID del mensaje."),
        language: z.string().regex(LANGUAGE).default("auto").describe("Código de idioma, por ejemplo es, o auto para detectarlo."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    transcribe,
  );

  server.registerTool(
    "whatsapp_search_contacts",
    {
      description: "Busca contactos por nombre o teléfono. Sirve para obtener el JID.",
      inputSchema: { query: z.string().min(1).max(200), limit: limit(20) },
      annotations: readOnly,
    },
    ({ query, limit }) => read(["contacts", "search", `--limit=${limit}`, "--", query], "Buscar contactos"),
  );

  server.registerTool(
    "whatsapp_sync",
    {
      description: "Trae los mensajes nuevos de WhatsApp a la base local y termina. Puede tardar un par de minutos.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const result = await wacli(["--json", "sync", "--once", "--idle-exit=30s"], 240_000);
      if (!succeeded(result)) return errorResult(wacliFailure(result, "La sincronización"));
      return textResult({ synced: true, truncated_output: result.truncated });
    },
  );

  server.registerTool(
    "whatsapp_send",
    {
      description:
        "Envía un mensaje de texto. Abre una ventana de macOS y solo envía si la persona presiona Enviar; si cancela o no responde, no se envía nada.",
      inputSchema: {
        to: z.string().max(100).describe("JID o teléfono con código de país."),
        message: z.string().min(1).max(MAX_MESSAGE_CHARS),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    send,
  );
}
