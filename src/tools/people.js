// People and follow-ups. `people_lookup` finds someone across WhatsApp, Gmail, this Mac's Contacts,
// notes and tasks in one call. `followups_list` finds who is waiting for an answer from the person and who the person is
// waiting on, and `followups_to_tasks` files those as tasks in SMCP's own list, once each.
// Like daily_brief, each part reuses an existing tool and asks for that tool's permission, so an area
// turned off in Settings is left out and says so.
import { z } from "zod";
import { appLanguage } from "../context.js";
import { viaHelper } from "../helper.js";
import { denialFor, readPolicy } from "../policy.js";
import { createNotes } from "../vaults.js";
import { errorResult, externalResult, fold } from "../util.js";
import { unwrap, withTimeout } from "./brief.js";
import { callApp as callTasks } from "./tasks.js";
import { createWhatsApp } from "./whatsapp.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SECTION_TIMEOUT_MS = 60_000;
const CHAT_CONCURRENCY = 4;
const MESSAGES_PER_CHAT = 10;
const PREVIEW_CHARS = 280;
/** Contacts are an extra on top of the other sections, so only the best few matches come back. */
const MAX_CONTACTS = 5;
const READ = { readOnlyHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true };

/** The marker a follow-up task carries in its note, so the same message never becomes two tasks. */
export const FOLLOWUP_MARKER = "smcp-followup:";

/** Short replies that close a conversation: nobody owes an answer to "gracias" or a thumbs up. */
const CLOSER = /^(ok|okay|oki|va|vale|sale|sip|si|listo|perfecto|excelente|gracias|muchas gracias|mil gracias|de nada|thanks|thank you|thx|np|great|cool|bien|genial|👍|🙏|👌|❤️|😊|🤝)[\s!.¡]*$/u;

/** A message of the person's that expects an answer: a question, or a request for news. Text is folded first. */
const ASK =
  /\?|\b(me avisas|avisame|me confirmas|confirmame|me dices|me compartes|me mandas|quedo atent[oa]|quedo pendiente|let me know|any updates?|could you|can you|please confirm|podrias|puedes|me ayudas|me apoyas|aguardo|fico no aguardo|j'attends|fammi sapere|gib mir bescheid)\b/;

/** Senders no one answers. */
const AUTOMATED = /(no-?reply|do-?not-?reply|notifica|notification|mailer-daemon|postmaster|newsletter|bounce|alerts?@|news@|marketing@|info@)/i;

const TEXTS = {
  en: { reply: "Reply to", follow: "Follow up with", last: "Last message", since: "Since" },
  es: { reply: "Contestar a", follow: "Dar seguimiento a", last: "Último mensaje", since: "Desde" },
  pt: { reply: "Responder a", follow: "Cobrar retorno de", last: "Última mensagem", since: "Desde" },
  fr: { reply: "Répondre à", follow: "Relancer", last: "Dernier message", since: "Depuis" },
  de: { reply: "Antworten an", follow: "Nachfassen bei", last: "Letzte Nachricht", since: "Seit" },
  it: { reply: "Rispondere a", follow: "Sollecitare", last: "Ultimo messaggio", since: "Dal" },
};

export function defaultSources() {
  const whatsapp = createWhatsApp();
  const notes = createNotes();
  const app = (op, params) =>
    viaHelper(op, params, () => {
      throw new Error("Open the SMCP app to include this section.");
    });
  return {
    whatsapp: async (args, action) => unwrap(await whatsapp.read(args, action)),
    gmailSearch: (params) => app("gmailSearch", params),
    // macOS gives the Contacts permission to SMCP.app, so the lookup runs there.
    contacts: (params) =>
      viaHelper("contacts", params, () => {
        throw new Error("Open the SMCP app to use Contacts.");
      }),
    notesSearch: (params) => notes.search(params),
    tasks: async (op, args) => (await callTasks(op, args)).value,
  };
}

/** Runs one part under the permission of the tool it reuses; a part that is off or fails never hides the rest. */
async function section(tool, policy, load, timeoutMs) {
  const denial = denialFor(tool, READ, policy);
  if (denial) return { skipped: denial };
  try {
    return await withTimeout(Promise.resolve().then(load), timeoutMs);
  } catch (error) {
    return { error: error.message };
  }
}

async function mapLimit(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const time = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};

const messageText = (message) => message.Text || message.DisplayText || message.MediaCaption || "";

function preview(message) {
  const text = messageText(message).trim();
  if (!text) return message.MediaType ? `[${message.MediaType}]` : "";
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** One person, not a group, a channel or the status feed. */
export function isDirectChat(chat) {
  const jid = String(chat?.jid ?? "");
  if (!jid || /@(g\.us|newsletter|broadcast)$/.test(jid)) return false;
  return chat.kind ? chat.kind === "dm" : /@(s\.whatsapp\.net|lid)$/.test(jid);
}

function isQuiet(chat, now) {
  const muted = Number(chat.muted_until) || 0;
  return chat.archived === true || muted === -1 || muted * 1000 > now;
}

/**
 * Who owes whom in one chat, from its latest messages. Their last message, older than `answerAfterMs`
 * and not just a "thanks", means the person owes an answer. The person's own last message, older than
 * `waitMs` and asking something, means they are waiting.
 */
export function classifyChat(chat, messages, { now, answerAfterMs, waitMs }) {
  const real = (messages ?? [])
    .filter((message) => !message.ReactionToID && !message.Revoked && !message.DeletedForMe && message.MediaType !== "sticker" && time(message.Timestamp) !== null)
    .sort((a, b) => time(b.Timestamp) - time(a.Timestamp));
  const last = real[0];
  if (!last) return null;
  const at = time(last.Timestamp);
  const age = now - at;
  const base = {
    source: "whatsapp",
    key: `fu:wa:${last.MsgID}`,
    chat: chat.jid,
    name: chat.name && chat.name !== chat.jid ? chat.name : (!last.FromMe && last.SenderName) || chat.jid,
    last_at: new Date(at).toISOString(),
    hours: Math.floor(age / HOUR),
    message_id: last.MsgID,
  };
  if (!last.FromMe) {
    if (age < answerAfterMs) return null;
    const theirs = [];
    for (const message of real) {
      if (message.FromMe || theirs.length === 3) break;
      theirs.push(message);
    }
    if (theirs.every((message) => CLOSER.test(fold(messageText(message)).trim()))) return null;
    return { kind: "to_answer", ...base, unread: chat.unread === true, preview: theirs.reverse().map(preview).filter(Boolean) };
  }
  if (age < waitMs || !ASK.test(fold(messageText(last)))) return null;
  return { kind: "waiting_on", ...base, preview: [preview(last)].filter(Boolean) };
}

export async function scanWhatsApp({ whatsapp, now, days, answerAfterMs, waitMs, chats = 60 }) {
  const listed = await whatsapp(["chats", "list", `--limit=${chats}`], "List chats");
  const recent = (Array.isArray(listed) ? listed : []).filter((chat) => {
    const at = time(chat.last_message_ts);
    return isDirectChat(chat) && !isQuiet(chat, now) && at !== null && now - at <= days * DAY;
  });
  let failed = 0;
  const found = await mapLimit(recent, CHAT_CONCURRENCY, async (chat) => {
    try {
      const page = await whatsapp(["messages", "list", `--chat=${chat.jid}`, `--limit=${MESSAGES_PER_CHAT}`], "Read messages");
      return classifyChat(chat, page?.messages, { now, answerAfterMs, waitMs });
    } catch {
      failed += 1;
      return null;
    }
  });
  return { checked: recent.length, ...(failed ? { failed } : {}), items: found.filter(Boolean) };
}

/** The subject a whole conversation shares: without Re:, Fwd: and similar prefixes, accents or case. */
export function threadSubject(subject) {
  let text = fold(subject).replace(/\s+/g, " ").trim();
  let before;
  do {
    before = text;
    text = text.replace(/^(re|rv|res|fw|fwd|aw|wg|sv|tr|enc)\s*(\[\d+\])?\s*:\s*/, "");
  } while (text !== before);
  return text;
}

/** "Ana Pérez <ana@x.com>, beto@y.com" into its parts. Names may contain commas, never an @. */
export function parseAddresses(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(/(?:"?([^<>"@]*?)"?\s*<([^<>\s]+@[^<>\s]+)>|([^\s,;<>"]+@[^\s,;<>"]+))/g)) {
    const name = (match[1] ?? "").replace(/^[\s,;"]+|[\s"]+$/g, "");
    found.push({ name, address: (match[2] ?? match[3]).toLowerCase() });
  }
  return found;
}

const shownName = (text) => {
  const [first] = parseAddresses(text);
  return first ? first.name || first.address : String(text ?? "");
};

/**
 * Groups email by account and conversation subject and looks at the newest message of each. If it was
 * received, and not from a robot, the person owes an answer; if they sent it, they are waiting.
 */
export function classifyEmail(received, sent, { now, answerAfterMs, waitMs }) {
  const threads = new Map();
  const add = (message, direction) => {
    const at = time(message.date);
    if (at === null) return;
    const subject = threadSubject(message.subject);
    const key = `${message.account}\n${subject || `#${direction}${message.uid}`}`;
    const current = threads.get(key);
    if (!current || at > current.at) threads.set(key, { message, direction, at });
  };
  for (const message of received ?? []) if (!AUTOMATED.test(message.from ?? "")) add(message, "in");
  for (const message of sent ?? []) add(message, "out");

  const items = [];
  for (const { message, direction, at } of threads.values()) {
    const age = now - at;
    const base = {
      source: "gmail",
      key: `fu:gm:${message.account}:${message.uid}`,
      account: message.account,
      uid: message.uid,
      subject: message.subject ?? "",
      last_at: new Date(at).toISOString(),
      hours: Math.floor(age / HOUR),
    };
    if (direction === "in" && age >= answerAfterMs) items.push({ kind: "to_answer", ...base, name: shownName(message.from), from: message.from, unread: message.unread === true });
    if (direction === "out" && age >= waitMs) items.push({ kind: "waiting_on", ...base, name: shownName(message.to), to: message.to ?? "" });
  }
  return items;
}

export async function scanGmail({ gmailSearch, days, now, answerAfterMs, waitMs }) {
  const window = `newer_than:${days}d`;
  const [received, sent] = await Promise.all([
    gmailSearch({ query: `in:inbox ${window} -from:me -category:promotions -category:social -category:updates -category:forums`, limit: 50 }),
    gmailSearch({ query: `in:sent ${window}`, limit: 50 }),
  ]);
  const errors = [...(received.errors ?? []), ...(sent.errors ?? [])];
  return {
    checked: (received.messages?.length ?? 0) + (sent.messages?.length ?? 0),
    ...(errors.length ? { errors } : {}),
    items: classifyEmail(received.messages, sent.messages, { now, answerAfterMs, waitMs }),
  };
}

/** Both directions from WhatsApp and Gmail, the longest wait first. */
export async function findFollowups({
  sources = defaultSources(),
  policy = readPolicy,
  now = Date.now(),
  days = 14,
  answer_after_hours: answerAfterHours = 3,
  wait_days: waitDays = 2,
  limit = 30,
  timeoutMs = SECTION_TIMEOUT_MS,
} = {}) {
  const current = policy();
  const options = { now, days, answerAfterMs: answerAfterHours * HOUR, waitMs: waitDays * DAY };
  const [whatsapp, gmail] = await Promise.all([
    section("whatsapp_read_messages", current, () => scanWhatsApp({ whatsapp: sources.whatsapp, ...options }), timeoutMs),
    section("gmail_search", current, () => scanGmail({ gmailSearch: sources.gmailSearch, ...options }), timeoutMs),
  ]);
  const all = [...(whatsapp.items ?? []), ...(gmail.items ?? [])].sort((a, b) => b.hours - a.hours);
  const pick = (kind) => all.filter((item) => item.kind === kind).slice(0, limit).map(({ kind: _kind, ...item }) => item);
  const summary = ({ items, ...rest }) => rest;
  return {
    to_answer: pick("to_answer"),
    waiting_on: pick("waiting_on"),
    whatsapp: summary(whatsapp),
    gmail: summary(gmail),
  };
}

const localDay = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** The task a follow-up becomes, written in the app's language. */
export function followupTask(item, kind, { language = "en", now = Date.now(), project } = {}) {
  const t = TEXTS[language] ?? TEXTS.en;
  const who = String(item.name || item.chat || item.account).slice(0, 120);
  const about = item.source === "gmail" && item.subject ? `: ${item.subject}` : "";
  const name = `${kind === "to_answer" ? t.reply : t.follow} ${who}${about}`.slice(0, 300);
  const where = item.source === "whatsapp" ? `WhatsApp ${item.chat}` : `Gmail ${item.account} uid ${item.uid}`;
  const lines = [
    ...(item.preview?.length ? [`${t.last}:`, ...item.preview.map((text) => `> ${text.replace(/\n+/g, " ")}`), ""] : []),
    `${t.since}: ${item.last_at}`,
    `${FOLLOWUP_MARKER} ${item.key}`,
    `Fuente: ${where}`,
  ];
  return {
    name,
    note: lines.join("\n"),
    for_claude: false,
    estimated_minutes: 5,
    ...(project ? { project } : {}),
    ...(kind === "to_answer" ? { planned: localDay(now) } : { waiting_for: who.slice(0, 80) }),
  };
}

const twinId = (message) => message.match(/\(id ([^,\s)]+)/)?.[1] ?? null;

/**
 * Files each follow-up as a task, once. A follow-up already in the list (open or done) is left alone;
 * a newer message from someone who already has an open task with the same name is added to that task's note.
 */
export async function followupsToTasks({ sources = defaultSources(), policy = readPolicy, keys, project, language = appLanguage(), now = Date.now(), ...scan } = {}) {
  const denial = denialFor("tasks_create", WRITE, policy());
  if (denial) throw new Error(denial);
  const found = await findFollowups({ sources, policy, now, ...scan });
  const wanted = keys?.length ? new Set(keys) : null;
  const items = [
    ...found.to_answer.map((item) => ["to_answer", item]),
    ...found.waiting_on.map((item) => ["waiting_on", item]),
  ].filter(([, item]) => !wanted || wanted.has(item.key));

  const created = [];
  const added = [];
  const already = [];
  const errors = [];
  for (const [kind, item] of items) {
    try {
      const existing = await sources.tasks("search", { query: item.key, include_done: true, limit: 1 });
      if (existing?.total) {
        already.push({ key: item.key, id: existing.tareas?.[0]?.id ?? null });
        continue;
      }
      const task = followupTask(item, kind, { language, now, project });
      try {
        const row = await sources.tasks("create", { ...task, allow_duplicate: false });
        created.push({ key: item.key, id: row?.id ?? null, name: task.name });
      } catch (error) {
        const id = twinId(error.message);
        if (!id) throw error;
        await sources.tasks("appendNote", { id, text: task.note });
        added.push({ key: item.key, id, name: task.name });
      }
    } catch (error) {
      errors.push({ key: item.key, error: error.message });
    }
  }
  return {
    created,
    added_to_existing: added,
    already_tasks: already,
    ...(errors.length ? { errors } : {}),
    ...(wanted ? { not_found: [...wanted].filter((key) => !items.some(([, item]) => item.key === key)) } : {}),
    whatsapp: found.whatsapp,
    gmail: found.gmail,
  };
}

/** Everything known about someone, with the exact JID and addresses to use. */
export async function lookupPerson({
  query,
  limit = 5,
  contacts: withContacts = true,
  sources = defaultSources(),
  policy = readPolicy,
  timeoutMs = SECTION_TIMEOUT_MS,
  platform = process.platform,
}) {
  const clean = String(query ?? "").replace(/["(){}\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Type a name, phone number or email address.");
  const terms = fold(clean).split(" ");
  const matches = (value) => terms.every((term) => fold(value).includes(term));
  const current = policy();

  // Contacts have no switch of their own: they follow people_lookup itself, which only a pause stops.
  // The caller can leave them out, and they only exist on a Mac.
  const contactsSection = () => {
    if (!withContacts) return { skipped: "Left out of this lookup." };
    if (platform !== "darwin") return { skipped: "Contacts are only available on a Mac." };
    return section(
      "people_lookup",
      current,
      async () => ({ matches: (await sources.contacts({ query: clean, limit: Math.min(limit, MAX_CONTACTS) })).slice(0, MAX_CONTACTS) }),
      timeoutMs,
    );
  };

  const [whatsapp, email, contacts, notes, tasks] = await Promise.all([
    section(
      "whatsapp_search_contacts",
      current,
      async () => {
        const [contacts, chats] = await Promise.all([
          sources.whatsapp(["contacts", "search", `--limit=${limit}`, "--", clean], "Search contacts"),
          sources.whatsapp(["chats", "list", `--limit=${limit}`, `--query=${clean}`], "List chats").catch(() => []),
        ]);
        const byJid = new Map();
        for (const contact of Array.isArray(contacts) ? contacts : []) {
          byJid.set(contact.jid, { jid: contact.jid, name: contact.alias || contact.system_name || contact.name || "", phone: contact.phone || "" });
        }
        for (const chat of Array.isArray(chats) ? chats : []) {
          const entry = byJid.get(chat.jid) ?? { jid: chat.jid, name: chat.name || "" };
          byJid.set(chat.jid, {
            ...entry,
            name: entry.name || chat.name || "",
            kind: chat.kind === "group" || String(chat.jid).endsWith("@g.us") ? "group" : "person",
            last_message_at: chat.last_message_ts ?? null,
            unread: chat.unread_count || (chat.unread ? 1 : 0),
          });
        }
        return {
          matches: [...byJid.values()]
            .map((entry) => ({ kind: String(entry.jid).endsWith("@g.us") ? "group" : "person", ...entry }))
            .sort((a, b) => (time(b.last_message_at) ?? 0) - (time(a.last_message_at) ?? 0)),
        };
      },
      timeoutMs,
    ),
    section(
      "gmail_search",
      current,
      async () => {
        const found = await sources.gmailSearch({ query: `{from:"${clean}" to:"${clean}" cc:"${clean}"}`, limit: 20 });
        const addresses = new Map();
        for (const message of found.messages ?? []) {
          for (const person of [...parseAddresses(message.from), ...parseAddresses(message.to)]) {
            if (!matches(`${person.name} ${person.address}`)) continue;
            const entry = addresses.get(person.address) ?? { address: person.address, name: "", messages: 0, last_at: null, accounts: [] };
            entry.name ||= person.name;
            entry.messages += 1;
            if ((time(message.date) ?? 0) > (time(entry.last_at) ?? 0)) entry.last_at = message.date;
            if (!entry.accounts.includes(message.account)) entry.accounts.push(message.account);
            addresses.set(person.address, entry);
          }
        }
        return {
          addresses: [...addresses.values()].sort((a, b) => b.messages - a.messages),
          recent: (found.messages ?? []).slice(0, limit).map(({ account, uid, from, to, subject, date }) => ({ account, uid, from, to, subject, date })),
          ...(found.errors?.length ? { errors: found.errors } : {}),
        };
      },
      timeoutMs,
    ),
    contactsSection(),
    section("notes_search", current, () => sources.notesSearch({ query: clean, limit }), timeoutMs),
    section("tasks_search", current, () => sources.tasks("search", { query: clean, limit }), timeoutMs),
  ]);
  return { query: clean, whatsapp, email, contacts, notes, tasks };
}

export function registerPeople(server, options = {}) {
  const sources = options.sources ?? defaultSources();
  const run = (fn, wrap = externalResult) => async (args = {}) => {
    try {
      return wrap(await fn({ ...args, ...options, sources }));
    } catch (error) {
      return errorResult(error.message);
    }
  };
  const scan = {
    days: z.number().int().min(1).max(60).default(14).describe("How many days back to look."),
    answer_after_hours: z.number().min(0).max(240).default(3).describe("A message counts as waiting for an answer after this many hours."),
    wait_days: z.number().min(0).max(60).default(2).describe("Something the person asked counts as unanswered after this many days."),
  };

  server.registerTool(
    "people_lookup",
    {
      description:
        "Finds a person across WhatsApp (contacts and chats, with the exact JID), Gmail (their addresses and recent emails), this Mac's Contacts " +
        "(phones, emails, birthday), notes and tasks in one call. " +
        "Use it before writing to someone or preparing a meeting. If several people match, ask which one; never guess a recipient.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Name, phone number or email address."),
        limit: z.number().int().min(1).max(20).default(5),
        contacts: z.boolean().default(true).describe("Also look in this Mac's Contacts."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(lookupPerson),
  );

  server.registerTool(
    "followups_list",
    {
      description:
        "Follow-ups across WhatsApp and Gmail: `to_answer` lists people who wrote last and are waiting for the person's reply; `waiting_on` lists " +
        "questions the person asked that nobody has answered. Groups, muted and archived chats, robots and closing messages like 'thanks' are left out. " +
        "Longest wait first. To file them as tasks, use followups_to_tasks.",
      inputSchema: { ...scan, limit: z.number().int().min(1).max(100).default(30) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(findFollowups),
  );

  server.registerTool(
    "followups_to_tasks",
    {
      description:
        "Files follow-ups as tasks in SMCP: 'Reply to <name>' planned for today, and 'Follow up with <name>' under Waiting for. Each message becomes a " +
        "task only once, even if run every day; a newer message from someone with an open task is added to its note. Pass `keys` from followups_list " +
        "to file only some of them.",
      inputSchema: {
        ...scan,
        keys: z.array(z.string().max(300)).max(100).optional().describe("Only these follow-ups, by the `key` followups_list returned."),
        project: z.string().max(300).optional().describe("Exact project name, from tasks_list_projects. By default, the inbox."),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    run(followupsToTasks),
  );
}
