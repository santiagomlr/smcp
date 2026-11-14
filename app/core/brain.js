// Runs the raw exports to the vault on their schedule: WhatsApp from SMCP's own store, and each
// connected Gmail account. SMCP pulls and writes; interpreting what it wrote is the AI's job.
//
// Every run leaves a heartbeat, whether or not it found anything, and a failure is kept as a failure,
// so a silent source never looks like a source with no news.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCheckpoints, recordRun } from "../../src/brain/checkpoint.js";
import { brainStateDir, enabledSources, readBrainConfig } from "../../src/brain/config.js";
import { describeSources } from "../../src/brain/inbox.js";
import { readPolicy as readSavedPolicy } from "../../src/policy.js";

const CHECK_EVERY_MS = 60_000;

async function defaultExporters() {
  const [{ exportWhatsApp }, { exportGmailAccount }] = await Promise.all([import("../../src/brain/whatsapp-export.js"), import("../../src/brain/gmail-export.js")]);
  return { whatsapp: exportWhatsApp, gmail: exportGmailAccount };
}

/**
 * `gmail` is the app's Gmail (it holds the passwords). `storePath` is wacli's database.
 * `onFailure(source, message)` is called the first time a source fails after working, so the person hears once.
 */
export function createBrainExports({
  gmail,
  storePath,
  readConfig = readBrainConfig,
  readPolicy = readSavedPolicy,
  stateDir = brainStateDir,
  exporters = null,
  now = Date.now,
  onChange = () => {},
  onFailure = () => {},
}) {
  const running = new Set();
  let timer = null;

  /**
   * The exports follow the same switches as the tools that read those sources: pausing SMCP, or
   * turning off WhatsApp reading or Gmail, stops them too. It is recorded as a run that did not
   * export, with the reason, so the gap is explained instead of looking like a quiet day.
   */
  const blockedBy = (source) => {
    const policy = readPolicy();
    if (policy.paused) return "SMCP is paused, so nothing was exported.";
    if (source.kind === "whatsapp" && (policy.disabled?.whatsapp || !policy.whatsapp?.read)) return "Reading WhatsApp is turned off in SMCP, so nothing was exported.";
    if (source.kind === "gmail" && policy.disabled?.gmail) return "Gmail is turned off in SMCP, so nothing was exported.";
    return null;
  };

  const runWhatsApp = async (config, run) => {
    const dir = stateDir();
    const scripts = join(config.vault, "scripts");
    const optional = (path) => (existsSync(path) ? path : undefined);
    const result = await run({
      storePath: storePath(),
      vault: config.vault,
      folder: config.whatsapp.folder,
      statePath: join(dir, "whatsapp-state.json"),
      aliasesPath: join(dir, "whatsapp-jid-aliases.json"),
      // Read once so the notes continue where the older scripts left them. SMCP never writes there.
      seedStatePath: optional(join(scripts, ".whatsapp-mcp-state.json")),
      seedAliasesPath: optional(join(scripts, "whatsapp-jid-aliases.json")),
      senderAliasesPath: optional(join(scripts, "whatsapp-alias-map.json")),
      ownName: config.whatsapp.ownName,
      ...(config.timeZone ? { timeZone: config.timeZone } : { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      now: () => new Date(now()),
    });
    const perFile = new Map((result.report?.detail ?? []).map((item) => [item.note, item.new]));
    return {
      summary: {
        new_messages: result.report?.messagesWritten ?? 0,
        chats: result.report?.chatsTouched ?? 0,
        new_notes: result.report?.notesCreated ?? 0,
        newest_message_in_store: result.stats?.storeLastMessage ?? null,
        ...(result.ambiguous?.length ? { chats_with_an_ambiguous_name: result.ambiguous.length } : {}),
      },
      files: (result.files ?? []).map((path) => ({ path, added: perFile.get(path) ?? 0 })),
    };
  };

  const runGmail = async (config, source, run) => {
    const result = await run({
      gmail,
      account: source.account,
      vault: config.vault,
      folder: source.folder,
      label: source.label,
      ...(config.timeZone ? { timeZone: config.timeZone } : {}),
      now: () => new Date(now()),
    });
    return {
      summary: {
        new_emails: result.written ?? 0,
        days: result.days ?? 0,
        skipped_for_safety: result.skipped ?? 0,
        // A long gap is caught up over several runs, oldest first, so say when more is still waiting.
        ...(result.truncated ? { more_waiting: true } : {}),
      },
      files: (result.files ?? []).map((path) => ({ path })),
    };
  };

  /** Runs one source and records how it went. Never throws: the outcome is the answer. */
  const runSource = async (source, config = readConfig()) => {
    if (running.has(source.id)) return { source: source.id, ok: false, skipped: true, reason: "It is already running." };
    running.add(source.id);
    const startedAt = now();
    const before = readCheckpoints(stateDir())[source.id];
    try {
      const blocked = blockedBy(source);
      if (blocked) throw new Error(blocked);
      if (!existsSync(join(config.vault, "raw"))) throw new Error(`The vault has no raw/ folder at ${config.vault}. Check the vault chosen in Settings > Brain.`);
      const tools = exporters ?? (await defaultExporters());
      const { summary, files } = source.kind === "whatsapp" ? await runWhatsApp(config, tools.whatsapp) : await runGmail(config, source, tools.gmail);
      recordRun(source.id, { ok: true, startedAt, finishedAt: now(), summary, files }, stateDir());
      return { source: source.id, ok: true, ...summary, files: files.map((file) => file.path) };
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 500);
      recordRun(source.id, { ok: false, startedAt, finishedAt: now(), error: message }, stateDir());
      if (!before || before.ok) onFailure(source.id, message);
      return { source: source.id, ok: false, error: message };
    } finally {
      running.delete(source.id);
      onChange();
    }
  };

  const api = {
    /** Runs every source whose turn has come. Called once a minute. */
    async runDue() {
      const config = readConfig();
      const checkpoints = readCheckpoints(stateDir());
      for (const source of enabledSources(config)) {
        const last = Date.parse(checkpoints[source.id]?.lastRunAt ?? "");
        if (Number.isNaN(last) || now() - last >= source.everyMinutes * 60_000) await runSource(source, config);
      }
    },

    /** Runs now, for the button in Settings and for brain_export_now. */
    async runNow({ source } = {}) {
      const config = readConfig();
      if (!config.vault) throw new Error("No vault is chosen for the raw exports yet. Choose it in SMCP, under Settings > Brain.");
      const sources = enabledSources(config);
      const wanted = source ? sources.filter((item) => item.id === source) : sources;
      if (!wanted.length) throw new Error(source ? `No export named "${source}" is turned on. Use brain_inbox to see the sources.` : "No export is turned on. Turn one on in SMCP, under Settings > Brain.");
      const results = [];
      for (const item of wanted) results.push(await runSource(item, config));
      return { ran: results };
    },

    status() {
      const config = readConfig();
      return { vault: config.vault, config, sources: describeSources(config, readCheckpoints(stateDir()), now()) };
    },

    start() {
      if (timer) return;
      timer = setInterval(() => api.runDue().catch(() => {}), CHECK_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
  return api;
}
