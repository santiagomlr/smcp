// A synthetic WhatsApp store and vault for the exporter's parity tests. Every name, number and
// chat here is invented. Times are built from a base date, so the same scenario can be rebuilt
// "as of today" for the live comparison against the reference scripts, whose backfill window
// depends on the real clock.

const OFFSET_HOURS = 6; // America/Monterrey has been UTC-6 all year since 2022

const OWN = "5215550000000@s.whatsapp.net";
const ANA = "5215550000001@s.whatsapp.net";
const BETO = "5215550000002@s.whatsapp.net";
const CARLA = "5215550000003@s.whatsapp.net";
const DULCES = "5215550000004@s.whatsapp.net";
const DANI = "5215550000005@s.whatsapp.net";
const SOLO_TEL = "5215550000006@s.whatsapp.net";
const FORMATO = "5215550000007@s.whatsapp.net";
const CORTO = "5215550000008@s.whatsapp.net";
const LIDIA = "99000000000011@lid";
const BRUNO_TEL = "5215550000021@s.whatsapp.net";
const BRUNO_LID = "99000000000021@lid";
const GEMELO_TEL = "5215550000031@s.whatsapp.net";
const GEMELO_LID_1 = "99000000000031@lid";
const GEMELO_LID_2 = "99000000000032@lid";
const ELENA_TEL = "5215550000041@s.whatsapp.net";
const ELENA_LID = "99000000000041@lid";
const CENA_1 = "120363000000000051@g.us";
const CENA_2 = "120363000000000052@g.us";
const SIN_NOMBRE = "120363000000000053@g.us";
const LARGO = "120363000000000054@g.us";
const JID_NOMBRE = "5215550000061@s.whatsapp.net";
const LID_SIN_NOMBRE = "99000000000062@lid";
const LID_LETRAS = "sinnumero@lid";
const BOLETIN = "120363000000000071@newsletter";
const ESTADOS = "status@broadcast";
const DIFUSION = "5215550000072@broadcast";
const DESCONOCIDO = "5215550000073@s.whatsapp.net";
const ESTATUS = "estatus.avisos@s.whatsapp.net";
const PAR_TEL = "5215550000081@s.whatsapp.net";
const PAR_LID = "99000000000081@lid";
const SOLO_VIEJO = "5215550000091@s.whatsapp.net";
const VIEJO_MIXTO = "5215550000092@s.whatsapp.net";
const SIN_FILAS = "5215550000093@s.whatsapp.net";
const SIN_FECHA = "5215550000094@s.whatsapp.net";
const FECHA_CERO = "5215550000095@s.whatsapp.net";
const MARTA = "5215550000096@s.whatsapp.net";
const JEFE = "5215550000097@s.whatsapp.net";
const PUNTO = "5215550000098@s.whatsapp.net";
const NUEVO = "5215550000100@s.whatsapp.net";
const REPETIDO = "5215550000101@s.whatsapp.net";
const VIEJA_AMISTAD = "99000000000088@lid";
const GRUPO_VACIO = "120363000000000059@g.us";
const SIN_CAMPOS = "99000000000090@lid";

const LARGO_NOMBRE = 'Proyecto: "Súper/Largo" <2026> #1 [beta]* ¿listo? | equipo de pruebas y más pruebas 🎉🎊🎉 con cola que se corta aquí mismo';

/** 32-bit FNV-1a in base 36, kept apart from the code under test: it names the notes that already exist. */
export function hash36(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash.toString(36);
}

const WA = "raw/Personal/whatsapp";

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (/^[^\p{C}\u{2028}\u{2029}]*$/u.test(value)) return `'${value.replaceAll("'", "''")}'`;
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function insert(table, row) {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => sqlValue(row[column])).join(", ")});`;
}

export const SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE chats (jid TEXT PRIMARY KEY, kind TEXT, name TEXT, last_message_ts INTEGER);
CREATE TABLE contacts (jid TEXT PRIMARY KEY, phone TEXT, push_name TEXT, full_name TEXT, business_name TEXT, system_name TEXT);
CREATE TABLE contact_aliases (jid TEXT PRIMARY KEY, alias TEXT);
CREATE TABLE groups (jid TEXT PRIMARY KEY, name TEXT);
CREATE TABLE messages (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  msg_id TEXT,
  sender_jid TEXT,
  sender_name TEXT,
  ts INTEGER,
  from_me INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  media_type TEXT,
  media_caption TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  deleted_for_me INTEGER NOT NULL DEFAULT 0,
  reaction_to_id TEXT
);
CREATE INDEX messages_chat_ts ON messages (chat_jid, ts);`;

/**
 * Builds the scenario as of `base`: the SQL of the store for the first run, the SQL that adds a
 * second day of activity, and the files a vault holds before the first run (notes written long
 * ago plus the reference scripts' state, identities and sender names).
 */
export function buildScenario(base) {
  const local = new Date(base.getTime() - OFFSET_HOURS * 3_600_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  /** Seconds since 1970 for a wall-clock time, `daysAgo` days before the base date. */
  const at = (daysAgo, clock) => {
    const [hour, minute, second] = clock.split(":").map(Number);
    return (midnight - daysAgo * 86_400_000) / 1000 + (hour + OFFSET_HOURS) * 3600 + minute * 60 + second;
  };
  const day = (daysAgo) => new Date(midnight - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 19) + "Z";

  const contacts = [
    { jid: OWN, phone: "5215550000000", push_name: "yo", full_name: null, business_name: null, system_name: null },
    { jid: ANA, phone: "5215550000001", push_name: "anita", full_name: "  Ana Prueba  ", business_name: null, system_name: "Ana Sistema" },
    { jid: BETO, phone: "5215550000002", push_name: "beto", full_name: "Beto Completo", business_name: null, system_name: null },
    { jid: CARLA, phone: "5215550000003", push_name: "carlita", full_name: "   ", business_name: "Carla Negocio", system_name: "Carla Sistema" },
    { jid: DULCES, phone: "5215550000004", push_name: "dulces", full_name: null, business_name: "Dulces Ejemplo SA", system_name: "" },
    { jid: DANI, phone: "5215550000005", push_name: "dani 🌮", full_name: "", business_name: "", system_name: null },
    { jid: SOLO_TEL, phone: "5215550000006", push_name: null, full_name: null, business_name: null, system_name: null },
    { jid: FORMATO, phone: "+52 1 (555) 000-0007", push_name: " ", full_name: null, business_name: null, system_name: null },
    { jid: CORTO, phone: "12345", push_name: null, full_name: null, business_name: null, system_name: null },
    { jid: LIDIA, phone: null, push_name: null, full_name: "Lidia Opaca", business_name: null, system_name: null },
    { jid: BRUNO_TEL, phone: "5215550000021", push_name: "bru", full_name: "BRUNO Ejémplo!", business_name: null, system_name: null },
    { jid: CENA_1, phone: "5215550000000-1600000000", push_name: null, full_name: null, business_name: null, system_name: null },
    { jid: CENA_2, phone: "5215550000", push_name: null, full_name: null, business_name: null, system_name: null },
  ];
  const contactAliases = [
    { jid: BETO, alias: "  Beto Alias " },
    { jid: DULCES, alias: "   " },
  ];
  const groups = [
    { jid: CENA_1, name: "Cena hoy" },
    { jid: LARGO, name: LARGO_NOMBRE },
    { jid: SIN_NOMBRE, name: null },
  ];
  const chats = [
    { jid: ANA, kind: "dm", name: "Ana P." },
    { jid: BETO, kind: "dm", name: "Beto" },
    { jid: CARLA, kind: "DM", name: null },
    { jid: DULCES, kind: "dm", name: "Dulces" },
    { jid: DANI, kind: "dm", name: "Dani" },
    { jid: SOLO_TEL, kind: "dm", name: "Solo Tel" },
    { jid: FORMATO, kind: "dm", name: "  " },
    { jid: BRUNO_TEL, kind: "dm", name: "Bruno E." },
    { jid: GEMELO_TEL, kind: "dm", name: "Gemelo Ejemplo" },
    { jid: ELENA_TEL, kind: "dm", name: "Elena Doble" },
    { jid: ELENA_LID, kind: "dm", name: "Elena Doble" },
    { jid: CENA_1, kind: "group", name: "cena vieja" },
    { jid: CENA_2, kind: "group", name: "Cena hoy" },
    { jid: SIN_NOMBRE, kind: "GROUP", name: null },
    { jid: LARGO, kind: "group", name: "largo" },
    { jid: JID_NOMBRE, kind: "dm", name: JID_NOMBRE },
    { jid: LID_SIN_NOMBRE, kind: "dm", name: null },
    { jid: LID_LETRAS, kind: "dm", name: null },
    { jid: BOLETIN, kind: "newsletter", name: "Boletín de prueba" },
    { jid: ESTADOS, kind: "broadcast", name: "Estados" },
    { jid: DIFUSION, kind: "dm", name: "Difusión" },
    { jid: DESCONOCIDO, kind: "unknown", name: "Sin clase" },
    { jid: ESTATUS, kind: "dm", name: "Avisos de estatus" },
    { jid: PAR_TEL, kind: "dm", name: "Paula por teléfono" },
    { jid: PAR_LID, kind: "dm", name: "Paula por lid" },
    { jid: SOLO_VIEJO, kind: "dm", name: "Solo Viejo" },
    { jid: VIEJO_MIXTO, kind: "dm", name: "Viejo Mixto" },
    { jid: SIN_FILAS, kind: "dm", name: "Sin Filas" },
    { jid: SIN_FECHA, kind: "dm", name: "Sin Fecha", last_message_ts: null },
    { jid: FECHA_CERO, kind: "dm", name: "Fecha Cero", last_message_ts: 0 },
    { jid: MARTA, kind: "dm", name: "notas.md de Marta" },
    { jid: JEFE, kind: "dm", name: 'El "Jefe" \\ Oficina' },
    { jid: PUNTO, kind: "dm", name: ".punto inicial" },
    { jid: REPETIDO, kind: "dm", name: "Repe Tido" },
  ];

  let counter = 0;
  const message = (chat, when, fields = {}) => ({
    chat_jid: chat,
    msg_id: `M${String(++counter).padStart(4, "0")}`,
    sender_jid: chat.endsWith("@g.us") ? null : chat,
    sender_name: null,
    ts: when,
    from_me: 0,
    text: null,
    media_type: null,
    media_caption: null,
    revoked: 0,
    deleted_for_me: 0,
    reaction_to_id: null,
    ...fields,
  });
  const mine = (chat, when, text, fields = {}) =>
    message(chat, when, { from_me: 1, sender_jid: chat.endsWith("@g.us") ? chat : OWN, sender_name: "me", text, ...fields });

  const betoMark = at(12, "14:24:15");
  const messages = [
    // --- a new 1-to-1 with every kind of text and media -------------------------------------
    message(ANA, at(20, "09:15:00"), { sender_name: "anita", text: "Hola, ¿cómo estás?" }),
    mine(ANA, at(20, "09:16:10"), "Todo bien, gracias"),
    message(ANA, at(20, "09:17:00"), { text: "línea uno\nlínea dos\r\nlínea tres" }),
    message(ANA, at(20, "09:18:00"), { text: "sep\x1carchivo\x1dgrupo\x1eregistro\x85nel\u{2028}línea\u{2029}párrafo\x0bvertical\x0cfin" }),
    message(ANA, at(20, "09:19:00"), { text: "unidad\x1fintacta y \u{200b}ancho cero" }),
    message(ANA, at(20, "09:20:00"), { text: "\u{a0}\u{2003} espacios raros al borde \u{3000}\x1f" }),
    message(ANA, at(20, "09:21:00"), { text: "\u{feff}marca de orden que se queda" }),
    message(ANA, at(20, "09:22:00"), { text: "emoji 🎉👩‍👩‍👧 y árabe \u{200f}مرحبا\u{200e} juntos" }),
    message(ANA, at(20, "09:23:00"), { text: "col1\tcol2\tcol3" }),
    message(ANA, at(20, "09:24:00"), { text: "antes\rdespués" }),
    message(ANA, at(20, "09:25:00"), { text: "## 2026-01-01" }),
    message(ANA, at(20, "09:26:00"), { text: "**12:34** — Falso: parece una línea" }),
    message(ANA, at(20, "09:27:00"), { text: "Jose\u{301} en forma descompuesta" }),
    message(ANA, at(20, "10:00:00"), { media_type: "image", media_caption: "Foto de la cena" }),
    message(ANA, at(20, "10:01:00"), { media_type: "audio", text: "[Audio]", media_caption: "[Audio]" }),
    message(ANA, at(20, "10:02:00"), { media_type: "ptt", text: "[Audio]" }),
    message(ANA, at(20, "10:03:00"), { media_type: "document", text: "Sent document" }),
    message(ANA, at(20, "10:04:00"), { media_type: "image", text: "texto real junto a la foto", media_caption: "[Image]" }),
    message(ANA, at(20, "10:05:00"), { media_type: "poll", text: "[Poll]" }),
    message(ANA, at(20, "10:06:00"), { media_type: " Video ", text: "[Video]" }),
    message(ANA, at(20, "10:07:00"), { text: "[Audio]" }),
    message(ANA, at(20, "10:08:00"), { text: "Sent document" }),
    message(ANA, at(20, "10:09:00"), { media_type: "image", media_caption: "Sent image" }),
    message(ANA, at(20, "10:10:00"), { media_type: "image" }),
    message(ANA, at(20, "10:11:00"), { text: "   " }),
    message(ANA, at(20, "10:12:00"), { text: "\t\n" }),
    message(ANA, at(20, "10:13:00"), { text: "👍", reaction_to_id: "M0001" }),
    message(ANA, at(20, "10:14:00"), { text: "esto se borró para todos", revoked: 1 }),
    message(ANA, at(20, "10:15:00"), { text: "esto lo borré para mí", deleted_for_me: 1 }),
    message(ANA, at(20, "10:16:00"), { media_type: "sticker", text: "[Sticker]" }),
    message(ANA, at(20, "10:17:00"), { media_type: "gif", text: "Sent gif" }),
    message(ANA, at(20, "10:18:00"), { media_type: "location", text: "[Location]" }),
    message(ANA, at(20, "10:19:00"), { media_type: "vcard", text: "[Contact]" }),
    message(ANA, at(20, "10:20:00"), { media_type: "image", text: "SENT IMAGE" }),
    message(ANA, at(20, "10:21:00"), { media_type: "image", text: "Sent \u{131}mage" }),
    message(ANA, at(20, "10:22:00"), { media_type: "video", text: "[Este texto es demasiado largo ya]" }),
    message(ANA, at(20, "10:23:00"), { media_type: "audio", text: "[a]" }),
    message(ANA, at(20, "10:24:00"), { media_type: "audio", text: "[Audio 2]" }),
    message(ANA, at(20, "10:25:00"), { media_type: "video", media_caption: "pie de\nvideo en dos líneas" }),
    message(ANA, at(20, "10:26:00"), { media_type: "document", text: "[Document]", media_caption: "contrato.pdf" }),
    message(ANA, at(20, "10:27:00"), { text: "con reacción vacía", reaction_to_id: "" }),
    // twice the same line in one minute: the second one is taken for a repeat
    message(ANA, at(20, "11:00:05"), { text: "ok" }),
    message(ANA, at(20, "11:00:40"), { text: "ok" }),
    // same second: ordered by id, not by arrival
    message(ANA, at(20, "11:05:00"), { msg_id: "z-llegó-primero", text: "segundo por id" }),
    message(ANA, at(20, "11:05:00"), { msg_id: "a-llegó-después", text: "primero por id" }),
    message(ANA, at(20, "11:06:00"), { msg_id: "", text: "sin id" }),
    message(ANA, at(20, "11:06:30"), { msg_id: "  id con espacios  ", text: "id con espacios" }),
    message(ANA, at(20, "11:07:00"), { msg_id: null, text: "id nulo" }),
    // midnight in local time
    mine(ANA, at(20, "23:59:30"), "último del día"),
    message(ANA, at(19, "00:00:10"), { text: "primero del día siguiente" }),
    // the same words at the same minute on another day also count as a repeat
    message(ANA, at(19, "11:00:20"), { text: "ok" }),
    message(ANA, at(18, "08:30:00"), { sender_name: "ME", text: "nombre de remitente raro" }),
    mine(ANA, at(18, "08:31:00"), "cierre de la primera corrida"),

    // --- an old note under another file name, larger than the tail that is read ---------------
    message(BETO, at(12, "14:20:00"), { text: "ya casi llego" }),
    message(BETO, betoMark, { text: "en el mismo segundo que la marca" }),
    message(BETO, betoMark + 1, { text: "mensaje repetido por milisegundos" }),
    message(BETO, betoMark + 25, { msg_id: "B-VISTO-1", text: "este id ya se vio" }),
    message(BETO, at(12, "15:00:00"), { text: "nuevo el mismo día" }),
    message(BETO, at(11, "09:00:05"), { text: "te mando el plan de ayer" }),
    mine(BETO, at(11, "10:00:00"), "recibido"),

    // --- a note in the discard folder -------------------------------------------------------
    message(CARLA, at(8, "18:00:00"), { text: "sigo aquí, en cuarentena" }),

    // --- chats named by business name, push name and phone ----------------------------------
    message(DULCES, at(6, "12:00:00"), { sender_name: "dulces", text: "Su pedido está listo" }),
    message(DANI, at(6, "12:05:00"), { text: "tacos?" }),
    message(SOLO_TEL, at(6, "12:10:00"), { text: "número sin nombre" }),
    message(FORMATO, at(6, "12:15:00"), { text: "nota con fin de línea de Windows" }),

    // --- one person, two ids -----------------------------------------------------------------
    message(BRUNO_TEL, at(15, "11:00:01"), { sender_name: "bru", text: "ya con el teléfono como id" }),
    mine(BRUNO_TEL, at(14, "08:00:00"), "enterado"),
    message(GEMELO_TEL, at(5, "09:00:00"), { text: "¿cuál de los dos soy?" }),
    message(ELENA_TEL, at(5, "10:00:00"), { text: "por teléfono" }),
    message(ELENA_LID, at(5, "10:30:00"), { text: "por lid" }),
    message(PAR_LID, at(4, "09:00:00"), { msg_id: "", text: "uno, por lid" }),
    message(PAR_TEL, at(4, "09:00:00"), { msg_id: "", text: "dos, por teléfono, mismo segundo" }),
    message(PAR_TEL, at(4, "08:59:00"), { text: "cero, por teléfono" }),
    message(PAR_LID, at(4, "09:01:00"), { text: "tres, por lid" }),
    message(PAR_TEL, at(4, "09:02:00"), { text: "cuatro, por teléfono" }),

    // --- groups ------------------------------------------------------------------------------
    message(CENA_1, at(3, "20:00:00"), { sender_jid: ANA, sender_name: "anita", text: "en el grupo viejo" }),
    mine(CENA_2, at(3, "20:01:00"), "yo, en el grupo nuevo"),
    message(CENA_2, at(3, "20:02:00"), { sender_jid: "5215550000001:12@s.whatsapp.net", sender_name: "anita", text: "desde otro dispositivo" }),
    message(CENA_2, at(3, "20:03:00"), { sender_jid: "99000000000011:3@lid", sender_name: "", text: "id opaco con dispositivo" }),
    message(CENA_2, at(3, "20:04:00"), { sender_jid: "5215550000005@lid", text: "lid que en la libreta es teléfono" }),
    message(CENA_2, at(3, "20:05:00"), { sender_jid: "5215550000099@s.whatsapp.net", text: "teléfono desconocido" }),
    message(CENA_2, at(3, "20:06:00"), { sender_jid: "99000000000099@lid", text: "lid desconocido" }),
    message(CENA_2, at(3, "20:07:00"), { sender_jid: "5215550000199@s.whatsapp.net", sender_name: "Pushy  ", text: "solo nombre público" }),
    message(CENA_2, at(3, "20:08:00"), { text: "sin remitente" }),
    message(CENA_2, at(3, "20:09:00"), { sender_jid: CENA_2, sender_name: "me", text: "grupo como remitente, pero no mío" }),
    message(CENA_2, at(3, "20:10:00"), { sender_jid: "5215550000077@s.whatsapp.net", sender_name: "Otro", text: "nombre puesto a mano" }),
    message(CENA_2, at(3, "20:11:00"), { sender_jid: "99000000000078@lid", sender_name: "Tiene", text: "nombre a mano vacío" }),
    message(CENA_2, at(3, "20:12:00"), { sender_jid: `  ${BETO}  `, text: "id con espacios alrededor" }),
    message(CENA_2, at(3, "20:13:00"), { sender_jid: "5215550000197@s.whatsapp.net", sender_name: "ME", text: "se hace llamar me" }),
    message(CENA_2, at(3, "20:14:00"), { sender_jid: SOLO_TEL, text: "contacto que solo tiene teléfono" }),
    message(CENA_2, at(3, "20:15:00"), { sender_jid: CORTO, text: "contacto con teléfono corto" }),
    message(CENA_2, at(3, "20:16:00"), { sender_jid: CARLA, media_type: "ptt", text: "[Audio]" }),
    mine(SIN_NOMBRE, at(3, "21:00:00"), "grupo sin nombre"),
    message(LARGO, at(3, "21:30:00"), { sender_jid: DANI, text: "nombre largo y con símbolos" }),

    // --- names that are not names -------------------------------------------------------------
    message(JID_NOMBRE, at(2, "09:00:00"), { text: "mi nombre es mi id" }),
    message(LID_SIN_NOMBRE, at(2, "09:01:00"), { text: "lid sin nombre" }),
    message(LID_LETRAS, at(2, "09:02:00"), { text: "lid sin dígitos" }),
    message(MARTA, at(2, "09:10:00"), { text: "mi nombre tiene punto md" }),
    message(JEFE, at(2, "09:10:00"), { text: "mi nombre tiene comillas" }),
    message(PUNTO, at(2, "09:11:00"), { text: "mi nombre empieza con punto" }),

    // --- chats that are skipped ----------------------------------------------------------------
    message(BOLETIN, at(1, "08:00:00"), { text: "boletín" }),
    message(ESTADOS, at(1, "08:01:00"), { sender_jid: ANA, text: "estado" }),
    message(DIFUSION, at(1, "08:02:00"), { text: "difusión" }),
    message(DESCONOCIDO, at(1, "08:03:00"), { text: "clase desconocida" }),
    message(ESTATUS, at(1, "08:04:00"), { text: "tengo status en el id" }),

    // --- the backfill window -------------------------------------------------------------------
    message(SOLO_VIEJO, at(200, "10:00:00"), { text: "demasiado viejo" }),
    message(VIEJO_MIXTO, at(120, "10:00:00"), { text: "fuera de la ventana" }),
    message(VIEJO_MIXTO, at(95, "10:00:00"), { text: "también fuera" }),
    message(VIEJO_MIXTO, at(80, "10:00:00"), { text: "dentro de la ventana" }),
    message(VIEJO_MIXTO, at(10, "10:00:00"), { text: "reciente" }),

    // --- nothing that counts -------------------------------------------------------------------
    message(SIN_FILAS, at(1, "09:00:00"), { text: "❤️", reaction_to_id: "M0002" }),
    message(SIN_FILAS, at(1, "09:01:00"), { media_type: "image" }),
    message(SIN_FECHA, at(1, "09:02:00"), { text: "el chat no tiene fecha" }),
    message(FECHA_CERO, at(1, "09:03:00"), { text: "el chat tiene fecha cero" }),

    // --- every line is already in the note -----------------------------------------------------
    message(REPETIDO, at(9, "07:00:00"), { text: "esto ya estaba escrito" }),
    mine(REPETIDO, at(9, "07:01:00"), "y esto también"),
  ];

  const lastOf = (rows, jid) => Math.max(...rows.filter((row) => row.chat_jid === jid).map((row) => row.ts));
  for (const chat of chats) {
    if (!("last_message_ts" in chat)) chat.last_message_ts = lastOf(messages, chat.jid);
  }

  const run1 = [
    SCHEMA,
    "BEGIN;",
    ...contacts.map((row) => insert("contacts", row)),
    ...contactAliases.map((row) => insert("contact_aliases", row)),
    ...groups.map((row) => insert("groups", row)),
    ...chats.map((row) => insert("chats", row)),
    ...messages.map((row) => insert("messages", row)),
    "COMMIT;",
    "",
  ].join("\n");

  // ---- second run: a later day of activity ------------------------------------------------------
  const anaLast = at(18, "08:31:00");
  const later = [
    message(ANA, anaLast, { text: "llegué en el mismo segundo que la marca" }),
    mine(ANA, at(18, "08:31:20"), "cierre de la primera corrida"),
    message(ANA, at(18, "08:40:00"), { text: "mismo día, sin encabezado nuevo" }),
    message(ANA, at(19, "07:00:00"), { text: "llegué tarde y soy más viejo que la marca" }),
    message(ANA, at(17, "09:00:00"), { text: "día nuevo, encabezado nuevo" }),
    message(ANA, at(17, "09:00:00"), { text: "👍", reaction_to_id: "M0001" }),
    message(BETO, at(10, "09:00:00"), { text: "otra vez a la nota grande" }),
    message(NUEVO, at(1, "10:00:00"), { text: "soy nuevo en la segunda corrida" }),
    mine(CENA_2, at(1, "10:05:00"), "seguimos en el grupo nuevo"),
    message(PUNTO, at(1, "10:10:00"), { text: "otra vez al archivo con punto" }),
    message(BRUNO_TEL, at(1, "10:15:00"), { text: "sigo con el teléfono" }),
    message(GEMELO_TEL, at(1, "10:20:00"), { text: "ya no soy ambiguo" }),
    message(CARLA, at(1, "10:25:00"), { text: "otra más en cuarentena" }),
    message(REPETIDO, at(1, "10:30:00"), { text: "ahora sí algo nuevo" }),
    message(MARTA, at(1, "10:35:00"), { text: "otro para Marta" }),
  ];
  const touched = [...new Set(later.map((row) => row.chat_jid))];
  const run2 = [
    "BEGIN;",
    insert("chats", { jid: NUEVO, kind: "dm", name: "Nuevo Contacto", last_message_ts: lastOf(later, NUEVO) }),
    ...later.map((row) => insert("messages", row)),
    ...touched.filter((jid) => jid !== NUEVO).map((jid) => `UPDATE chats SET last_message_ts = ${Math.max(lastOf(later, jid), lastOf(messages, jid))} WHERE jid = ${sqlValue(jid)};`),
    // a contact that is renamed keeps its note
    `UPDATE contacts SET full_name = 'Ana Prueba Renombrada' WHERE jid = ${sqlValue(ANA)};`,
    "COMMIT;",
    "",
  ].join("\n");

  // ---- the vault before the first run -----------------------------------------------------------
  const head = (name, jid, kind) => `---\nsource: whatsapp\nchat_id: "${jid}"\nchat_name: "${name}"\nkind: ${kind}\n---\n\n# ${name}\n`;
  const seed = {};

  // Beto's note: renamed by hand, and long enough that only its tail is read back. The line the
  // tail starts in is cut inside a character.
  const betoNote = `${WA}/Personales/Beto de antes zz9.md`;
  const betoBody = (padding) => {
    let text = head("Beto Alias", BETO, "personal");
    text += `\n## ${day(40)}\n\n**09:00** — Beto Alias: te mando el plan de ayer\n\n`;
    for (let i = 0; i < 760; i += 1) {
      if (i % 120 === 0) text += `\n## ${day(39 - i / 120)}\n\n`;
      text += `**10:${String(i % 60).padStart(2, "0")}** — Santiago: relleno 🎉🎊 número ${i} con eñe y acentos áéíóú\n\n`;
    }
    text += `\n## ${day(12)}\n\n**14:20** — Beto Alias: ya casi llego${".".repeat(padding)}\n\n`;
    text += "**14:24** — Beto Alias: mensaje repetido por milisegundos\n\n";
    return text;
  };
  let padding = 0;
  for (; padding < 16; padding += 1) {
    const bytes = Buffer.from(betoBody(padding), "utf8");
    const cut = bytes[bytes.length - 60000];
    if (cut >= 0x80 && cut <= 0xbf) break;
  }
  seed[betoNote] = betoBody(padding);
  seed[`${WA}/_descartados/Beto duplicado.md`] = `${head("Beto Alias", BETO, "personal")}\n## ${day(60)}\n\n**08:00** — Beto Alias: copia que nadie debe tocar\n\n`;

  // Carla: two notes in the discard folder; the one at the top is found first.
  const carlaTop = `${WA}/_descartados/Carla Sistema arriba.md`;
  const carlaNested = `${WA}/_descartados/2025/Carla Sistema anidada.md`;
  seed[carlaTop] = `${head("Carla Sistema", CARLA, "personal")}\n## ${day(30)}\n\n**10:00** — Carla Sistema: me mandaron a cuarentena\n\n`;
  seed[carlaNested] = `${head("Carla Sistema", CARLA, "personal")}\n## ${day(31)}\n\n**10:00** — Carla Sistema: copia anidada\n\n`;

  // Notes the search must not see: hidden files and folders, another extension case, a folder
  // called like a note, and a chat id that comes after the part of the file that is read.
  seed[`${WA}/_descartados/.papelera/oculta.md`] = head("dani", DANI, "personal");
  seed[`${WA}/Personales/.oculta.md`] = head("Dulces", DULCES, "personal");
  seed[`${WA}/Personales/Dulces MAYUS.MD`] = head("Dulces", DULCES, "personal");
  seed[`${WA}/Personales/carpeta.md/dentro.txt`] = "una carpeta con nombre de nota\n";
  seed[`${WA}/Personales/Preambulo largo.md`] = `---\nsource: whatsapp\nnotas: "${"x".repeat(700)}"\nchat_id: "${SOLO_TEL}"\n---\n\n# Solo Tel\n`;

  // A note saved with Windows line ends and the chat id without quotes.
  const formatoNote = `${WA}/Personales/Sin comillas.md`;
  seed[formatoNote] = `---\r\nsource: whatsapp\r\nchat_id: ${FORMATO}  \r\nchat_name: "Formato"\r\nkind: personal\r\n---\r\n\r\n# Formato\r\n\r\n## ${day(50)}\r\n\r\n**10:00** — Formato: línea vieja\r\n\r\n`;

  const cenaNote = `${WA}/Grupos/Cena hoy ${hash36(CENA_1)}.md`;
  seed[cenaNote] = `${head("Cena hoy", CENA_1, "group")}\n## ${day(7)}\n\n**12:00** — Santiago: ¿cenamos?\n\n`;
  const brunoNote = `${WA}/Personales/Bruno Ejemplo ${hash36(BRUNO_LID)}.md`;
  seed[brunoNote] = `${head("Bruno Ejemplo", BRUNO_LID, "personal")}\n## ${day(15)}\n\n**11:00** — Bruno Ejemplo: escrito cuando era un lid\n\n`;
  const parNote = `${WA}/Personales/Paula Par ${hash36(PAR_LID)}.md`;
  seed[parNote] = `${head("Paula Par", PAR_LID, "personal")}\n## ${day(9)}\n\n**09:00** — Paula Par: antes de todo\n\n`;
  const repetidoNote = `${WA}/Personales/Repe Tido ${hash36(REPETIDO)}.md`;
  seed[repetidoNote] = `${head("Repe Tido", REPETIDO, "personal")}\n## ${day(9)}\n\n**07:00** — Repe Tido: esto ya estaba escrito\n\n**07:01** — Santiago: y esto también\n\n`;
  seed[`${WA}/_Conversation Index.md`] = "# WhatsApp — Conversation Index\n\níndice viejo que se reemplaza\n";

  const entry = (name, kind, notePath, lastTs, header, count, extra = {}) => ({
    name, kind, note_path: notePath, last_ts: lastTs, last_date_header: header, message_count: count, seen_ids: [], ...extra,
  });
  const state = {
    version: 1,
    source: "lmcp",
    last_run: `${day(1)}T03:00:00.123456-06:00`,
    seeded_at: `${day(88)}T10:00:00-06:00`,
    seeded_chats: 4,
    chats: {
      [BETO]: entry("Beto Alias", "personal", betoNote, `${iso(betoMark).slice(0, 19)}.459Z`, day(12), 763, { seen_ids: ["B-VISTO-0", "B-VISTO-1"], seeded_from_plugin: true }),
      [CARLA]: entry("Carla Sistema", "personal", carlaNested, iso(at(30, "10:00:00")), day(30), 1),
      [BRUNO_LID]: entry("Bruno Ejemplo", "personal", brunoNote, iso(at(15, "11:00:00")), day(15), 1, { seeded_from_plugin: true }),
      [GEMELO_LID_1]: entry("Gemelo Ejemplo", "personal", "", iso(at(70, "10:00:00")), day(70), 3),
      [GEMELO_LID_2]: entry("gemelo  EJEMPLO", "personal", `${WA}/Personales/Gemelo Ejemplo ${hash36(GEMELO_LID_2)}.md`, iso(at(70, "10:00:00")), day(70), 5),
      [ELENA_LID]: entry("Elena Doble", "personal", `${WA}/Personales/Elena Doble ${hash36(ELENA_LID)}.md`, iso(at(25, "10:00:00")), day(25), 2),
      [CENA_1]: entry("Cena hoy", "group", cenaNote, iso(at(7, "12:00:00")), day(7), 1),
      [PAR_LID]: entry("Paula Par", "personal", parNote, iso(at(9, "09:00:00")), day(9), 1),
      [VIEJA_AMISTAD]: entry("Vieja Amistad", "personal", `${WA}/Personales/Vieja Amistad ${hash36(VIEJA_AMISTAD)}.md`, iso(at(300, "10:00:00")).replace("Z", "+00:00"), day(300), 41),
      [GRUPO_VACIO]: { name: "Grupo Vacío", kind: "group", note_path: "", last_ts: "", last_date_header: "", message_count: 0, seen_ids: [] },
      [FORMATO]: entry("Formato", "personal", formatoNote, iso(at(50, "10:00:00")), day(50), 1),
      [SIN_CAMPOS]: { name: "Sin Campos" },
    },
  };
  seed["scripts/.whatsapp-mcp-state.json"] = `${JSON.stringify(state, null, 2)}\n`;
  seed["scripts/whatsapp-jid-aliases.json"] = `${JSON.stringify({ comentario: "sintético", aliases: { [PAR_TEL]: PAR_LID } }, null, 2)}\n`;
  seed["scripts/whatsapp-alias-map.json"] = `${JSON.stringify({ "5215550000077@s.whatsapp.net": "Tía Alias", "99000000000078@lid": "" }, null, 2)}\n`;

  return { run1, run2, seed };
}
