import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import QRCode from "qrcode";
import "./ui/i18n.js";
import "./ui/i18n/es-settings.js";
import "./ui/i18n/es-tasks.js";
import "./ui/i18n/es-main.js";
import {
  addToClaudeCode,
  addToDesktop,
  clientCatalog,
  isRegistered,
  removeFromClaudeCode,
  removeFromDesktop,
  serverEntry,
} from "./core/clients.js";
import { calendarEvents, calendarStatus, eventKit, requestCalendar } from "./core/calendar.js";
import { disableFunnel, enableFunnel, isFunnelOn, readBaseUrl } from "./core/funnel.js";
import { createAccountStore, createGmail } from "./core/gmail.js";
import { magicPacket, readPcConfig, readTailscale, sendWake, sshCommandFile, sshTarget } from "./core/machines.js";
import { callPeer, createPeerHub, PEER_LOCAL_PORT, PEER_PORT, peerInfo } from "./core/peers.js";
import { createRemote, REMOTE_PORT } from "./core/remote.js";
import { createRemoteTasks, createTasksHub, disableServe, enableServe, tailscaleLogin } from "./core/tasks-hub.js";
import { createTaskStore, TASK_OPERATIONS } from "./core/tasks.js";
import { coalesce, retry, whenChanged } from "./core/throttle.js";
import { createUpdater, isNewer, RELEASES_PAGE } from "./core/updater.js";
import { logoutWhatsApp, readWhatsApp, startLogin, syncWhatsApp } from "./core/whatsapp.js";
import { audioSupported, downloadModel } from "./core/whisper.js";
import { buildRemoteServer } from "../src/remote-tools.js";
import { clearAudit, readAudit } from "../src/audit.js";
import { EVENTS, REMINDERS } from "../src/eventkit.js";
import { startHelper } from "../src/helper.js";
import { denialFor, GROUPS, readPolicy, WHATSAPP_ABILITIES, writePolicy } from "../src/policy.js";
import { modelReady } from "../src/whisper.js";
import { listVaultChoices, setVault, vaultLocation } from "../src/vaults.js";
import { localAppleNotes } from "../src/tools/applenotes.js";
import { localJxa, localScreenshot, localScreenText } from "../src/tools/apps.js";
import { formatDay, formatLocal } from "../src/tools/calendar.js";
import { localConfirm } from "../src/tools/whatsapp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const IS_MAC = process.platform === "darwin";
const REFRESH_MS = 30_000;

if (app.isPackaged && IS_MAC) process.env.WACLI_BIN = join(process.resourcesPath, "bin", "wacli");

let win = null;
let tasksWin = null;
let panel = null;
let panelHiddenAt = 0;
let remote = null;
let remoteBaseUrl = null;
let tray = null;
let quitting = false;
let cancelLogin = null;
let lastState = null;
const startedInBackground = process.argv.includes("--background") || app.getLoginItemSettings().wasOpenedAtLogin;

/** The same dialog as ever, worded in the app's language. The AI supplies only the body. */
function confirmInApp(body, title = "SMCP: send WhatsApp", button = "Send") {
  return localConfirm(body, tr(title), { cancel: tr("Cancel"), send: tr(button) });
}

const gmail = createGmail({
  store: createAccountStore({
    encrypt: (text) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(tr("This computer cannot store encrypted passwords."));
      return safeStorage.encryptString(text).toString("base64");
    },
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, "base64")),
  }),
  confirm: confirmInApp,
});

let localTasks = null;
let tasksHub = null;
let peerHub = null;
/** What each of the user's other computers running SMCP last said about itself, by machine name. */
const peers = new Map();

const settingsPath = () => join(app.getPath("userData"), "settings.json");

/** Read synchronously: the preload asks for the language before any window can wait on a promise. */
function readSavedLanguage() {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")).language === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

SMCP_I18N.setLanguage(readSavedLanguage());

/** A damaged file is an error, not empty settings: empty would send tasks to a second, local list. */
async function readSettings() {
  let text;
  try {
    text = await readFile(settingsPath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(tr("Could not read the SMCP settings."));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(tr("The SMCP settings are damaged. Check {path}.", { path: settingsPath() }));
  }
}

/** Replaces the file in one step, so a read can never see it half written. */
async function writeSettings(settings) {
  await mkdir(dirname(settingsPath()), { recursive: true });
  const temp = `${settingsPath()}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temp, settingsPath());
}

const collectState = coalesce(readState);

async function readState() {
  const [tailscale, whatsapp, settings, pcConfig, gmailAccounts, tasks] = await Promise.all([
    readTailscale(),
    readWhatsApp(),
    // The status screens still work with damaged settings; tasks report the error on their own.
    readSettings().catch(() => ({})),
    readPcConfig(),
    IS_MAC ? gmail.listAccounts().catch(() => []) : [],
    readTasksSummary(),
  ]);
  if (IS_MAC) await repairClients(settings);
  const clients = IS_MAC
    ? (
        await Promise.all(
          clientCatalog().map(async ({ id, name, app: appPath, path, key }) => {
            const connected = await isRegistered(path, key);
            const installed = appPath ? existsSync(appPath) : existsSync(path);
            return { id, name, connected, installed };
          }),
        )
      ).filter((client) => client.installed || client.connected)
    : [];
  const update = updateSummary();
  const machines = tailscale.machines.map((machine) => {
    const smcp = machine.self || !machine.online ? null : (peers.get(machine.name) ?? null);
    const newest = [update.latest, smcp?.update.latest].filter(Boolean).sort((a, b) => (isNewer(a, b) ? -1 : 1))[0];
    const outdated = Boolean(smcp && newest && isNewer(newest, smcp.version));
    return {
      ...machine,
      alias: settings.machines?.[machine.name]?.alias ?? "",
      user: settings.machines?.[machine.name]?.user ?? "",
      canWake: machine.os === "windows" && !machine.online && Boolean(pcConfig.mac),
      smcp: smcp ? { version: smcp.version, latest: outdated ? newest : null } : null,
      outdated,
      // Only the Mac build installs itself; a PC with an old version gets the notice but no button.
      canUpdate: outdated && smcp.platform === "darwin",
    };
  });
  lastState = {
    platform: process.platform,
    tailscale: { ...tailscale, machines },
    whatsapp,
    audio: { supported: await audioSupported(), ...audioProgress() },
    tasks: { ...tasks, host: settings.tasksHost ?? null, hub: Boolean(tasksHub) },
    gmail: { supported: IS_MAC, accounts: gmailAccounts },
    notes: { supported: IS_MAC, vaults: IS_MAC ? listVaultChoices().map(({ name, path, enabled }) => ({ name, path, display: vaultLocation(path), enabled })) : [] },
    clients: { supported: IS_MAC, items: clients },
    remote: {
      supported: IS_MAC && tailscale.installed,
      enabled: Boolean(remote?.running()),
      url: remoteBaseUrl ? `${remoteBaseUrl}/mcp` : null,
      pairing: remote?.activePairing() ?? null,
      clients: (remote?.listClients() ?? []).map((client) => ({ ...client, name: tr(client.name) })),
    },
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    onboarded: settings.onboarded === true,
    permissions: readPermissions(),
    policy: readPolicy(),
    version: app.getVersion(),
    update,
  };
  updateTray();
  refreshPeers().catch((error) => console.error("peers:", error.message));
  return lastState;
}

function findMachine(name) {
  const machine = lastState?.tailscale.machines.find((item) => item.name === name);
  if (!machine) throw new Error(tr("That machine no longer appears in Tailscale."));
  return machine;
}

async function openTerminal(name) {
  const machine = findMachine(name);
  const [settings, pcConfig] = await Promise.all([readSettings(), readPcConfig()]);
  const target = sshTarget(machine, { settings, pcConfig });
  if (IS_MAC) {
    const file = join(app.getPath("userData"), "ssh-sesion.command");
    await writeFile(file, sshCommandFile(target));
    await chmod(file, 0o700);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return;
  }
  // Values were validated by sshTarget. Each one stays a separate argument.
  spawn("cmd.exe", ["/c", "start", "", "ssh", `${target.user}@${target.ip}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

/* Other computers running SMCP */

const PEER_VERSION = /^\d+\.\d+\.\d+$/;
const peersChanged = whenChanged(() => collectState());

/** Asks every online computer what SMCP it runs. Ones without SMCP simply do not answer. */
const refreshPeers = coalesce(async () => {
  const others = lastState?.tailscale.machines.filter((machine) => !machine.self && machine.online && machine.dns) ?? [];
  const answers = await Promise.all(
    others.map(async (machine) => [machine.name, await callPeer(machine.dns, "info", {}, { timeoutMs: 3_000 }).catch(() => null)]),
  );
  peers.clear();
  for (const [name, info] of answers) {
    if (PEER_VERSION.test(info?.version ?? "") && info.update) peers.set(name, info);
  }
  peersChanged(Object.fromEntries(peers));
});

/** What a remote "update" does here: the same signed download as Settings, then a quiet restart. */
async function updateAtPeerRequest() {
  if (!app.isPackaged) throw new Error("This copy of SMCP cannot update itself.");
  const snapshot = await updater.check();
  if (snapshot.status === "installing") return { status: "installing", version: snapshot.latest };
  if (snapshot.status === "latest") return { status: "latest", version: snapshot.current };
  if (snapshot.status !== "available") throw new Error(snapshot.message || "Could not check for updates.");
  if (!snapshot.canInstall) throw new Error("This computer cannot install updates by itself.");
  new Notification({ title: tr("Updating SMCP to {version}", { version: snapshot.latest }), body: tr("Another of your computers asked for it. SMCP will restart by itself.") }).show();
  // Answer first: the install quits this app once it has the new version ready.
  setTimeout(() => updater.install({ background: true }).catch((error) => console.error("updates:", error.message)), 300);
  return { status: "installing", version: snapshot.latest };
}

async function startPeerHub() {
  if (peerHub) return;
  if (!(await readTailscale()).installed) return;
  const owner = await tailscaleLogin();
  if (!owner) throw new Error(tr("Sign in to Tailscale to share your tasks."));
  const hub = createPeerHub({
    owner,
    handlers: {
      info: () => peerInfo({ version: app.getVersion(), platform: process.platform, update: updater.state() }),
      update: updateAtPeerRequest,
      wake: async ({ mac }) => ({ sent: (await sendWake({ mac })).sent }),
    },
  });
  await hub.start();
  try {
    await enableServe(PEER_PORT, PEER_LOCAL_PORT);
  } catch (error) {
    await hub.stop();
    throw error;
  }
  peerHub = hub;
}

/**
 * The magic packet only travels inside the PC's local network. This computer sends it on every network it is on,
 * and every other computer with SMCP sends it too, so it works from anywhere as long as one of them is home.
 */
async function wakeMachine(name) {
  if (findMachine(name).os !== "windows") throw new Error(tr("Only the PC can be turned on from here."));
  const pcConfig = await readPcConfig();
  magicPacket(pcConfig.mac);
  const relays = lastState.tailscale.machines.filter((machine) => !machine.self && machine.online && machine.dns && peers.has(machine.name));
  const [local, ...remote] = await Promise.allSettled([
    sendWake(pcConfig),
    ...relays.map((machine) => callPeer(machine.dns, "wake", { mac: pcConfig.mac }, { timeoutMs: 6_000 })),
  ]);
  const helpers = remote.filter((result) => result.status === "fulfilled").length;
  if (local.status === "rejected" && !helpers) throw local.reason;
  return { local: local.status === "fulfilled", helpers };
}

async function updateMachine(name) {
  const machine = findMachine(name);
  if (machine.self) throw new Error(tr("Update this computer from Settings."));
  if (!machine.online || !machine.dns) throw new Error(tr("That computer is offline."));
  const result = await callPeer(machine.dns, "update", {}, { timeoutMs: 30_000 });
  peers.delete(machine.name);
  return result;
}

function mcpEntry() {
  return serverEntry({
    execPath: process.execPath,
    script: join(ROOT, "src", "index.js"),
    wacliBin: process.env.WACLI_BIN || (app.isPackaged ? null : join(ROOT, "vendor", "bin", "wacli")),
  });
}

async function setClient(client, enabled) {
  if (!IS_MAC) throw new Error(tr("The local server only works on Mac for now."));
  const item = clientCatalog().find(({ id }) => id === client);
  if (!item) throw new Error(tr("Unknown client."));
  if (item.cli) {
    await (enabled ? addToClaudeCode(mcpEntry()) : removeFromClaudeCode());
  } else if (enabled) {
    await addToDesktop(item.path, { ...item.extra, ...mcpEntry() }, item.key);
  } else {
    await removeFromDesktop(item.path, item.key);
  }
  // Remember the choice so a config file another app rewrites can be repaired (see repairClients).
  const settings = await readSettings();
  await writeSettings({ ...settings, clients: { ...settings.clients, [client]: enabled } });
}

/**
 * Claude Desktop saves its config file from the copy it holds in memory, which drops the SMCP entry
 * written while it was open. Put back every entry the user switched on that has gone missing.
 */
async function repairClients(settings) {
  const wanted = settings.clients ?? {};
  await Promise.all(
    clientCatalog()
      .filter((item) => !item.cli && wanted[item.id] === true)
      .map(async (item) => {
        if (await isRegistered(item.path, item.key)) return;
        await addToDesktop(item.path, { ...item.extra, ...mcpEntry() }, item.key).catch((error) =>
          console.error(`repair ${item.id}:`, error.message),
        );
      }),
  );
}

/* Tasks */

function localStore() {
  localTasks ??= createTaskStore();
  return localTasks;
}

/** One list only: if another computer holds it, an outage is an error, never a second list. */
async function runTask(op, args) {
  if (!TASK_OPERATIONS.includes(op)) throw new Error(tr("Unknown operation."));
  const { tasksHost } = await readSettings();
  const store = tasksHost ? createRemoteTasks({ host: tasksHost }) : localStore();
  return store[op](args ?? {});
}

async function readTasksSummary() {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(tr("The computer with your tasks is not responding."))), 3_000));
  try {
    return { summary: await Promise.race([runTask("summary"), timeout]), error: null };
  } catch (error) {
    return { summary: null, error: tr(error.message) };
  }
}

async function startTasksHub() {
  if (tasksHub) return;
  const owner = await tailscaleLogin();
  if (!owner) throw new Error(tr("Sign in to Tailscale to share your tasks."));
  const hub = createTasksHub({ store: localStore(), owner });
  await hub.start();
  try {
    await enableServe();
  } catch (error) {
    await hub.stop();
    throw error;
  }
  tasksHub = hub;
}

async function setTasksHub(enabled) {
  const settings = await readSettings();
  if (enabled) {
    if (settings.tasksHost) throw new Error(tr("This computer uses another computer's tasks. Change where they are stored first."));
    await startTasksHub();
  } else {
    await disableServe();
    await tasksHub?.stop();
    tasksHub = null;
  }
  settings.tasksHub = Boolean(enabled);
  await writeSettings(settings);
}

async function setTasksHost(host) {
  const settings = await readSettings();
  if (host) {
    const machine = lastState?.tailscale.machines.find((item) => item.dns === host && !item.self);
    if (!machine) throw new Error(tr("That computer no longer appears in Tailscale."));
    await createRemoteTasks({ host }).summary();
    if (tasksHub) await disableServe();
    await tasksHub?.stop();
    tasksHub = null;
    settings.tasksHub = false;
  }
  settings.tasksHost = host || null;
  await writeSettings(settings);
}

async function resumeTasksHub() {
  if ((await readSettings()).tasksHub) await startTasksHub();
}

/* Remote access */

async function ensureRemote() {
  remoteBaseUrl ??= await readBaseUrl();
  remote ??= createRemote({ baseUrl: remoteBaseUrl, buildServer: buildRemoteServer });
  return remote;
}

async function setRemote(enabled) {
  const settings = await readSettings();
  if (enabled) {
    const server = await ensureRemote();
    await server.start();
    try {
      await enableFunnel(REMOTE_PORT);
    } catch (error) {
      await server.stop();
      throw error;
    }
    server.newPairingCode();
  } else {
    await disableFunnel();
    await remote?.stop();
  }
  settings.remote = Boolean(enabled);
  await writeSettings(settings);
}

async function resumeRemote() {
  if (!IS_MAC || !(await readSettings()).remote) return;
  const server = await ensureRemote();
  await server.start();
  if (!(await isFunnelOn(REMOTE_PORT))) await enableFunnel(REMOTE_PORT);
  await collectState();
}

function newRemoteCode() {
  if (!remote?.running()) throw new Error(tr("Turn on remote access first."));
  return remote.newPairingCode();
}

function copyRemoteUrl() {
  if (!remoteBaseUrl) throw new Error(tr("Turn on remote access first."));
  clipboard.writeText(`${remoteBaseUrl}/mcp`);
}

async function saveMachine(name, { alias, user }) {
  const settings = await readSettings();
  settings.machines = {
    ...settings.machines,
    [name]: { alias: String(alias ?? "").slice(0, 40), user: String(user ?? "").slice(0, 64) },
  };
  await writeSettings(settings);
}

function updatePolicy(patch) {
  const policy = readPolicy();
  if (typeof patch.paused === "boolean") policy.paused = patch.paused;
  if (typeof patch.readOnly === "boolean") policy.readOnly = patch.readOnly;
  for (const group of GROUPS) {
    if (typeof patch.disabled?.[group] === "boolean") policy.disabled[group] = patch.disabled[group];
  }
  for (const ability of WHATSAPP_ABILITIES) {
    if (typeof patch.whatsapp?.[ability] === "boolean") policy.whatsapp[ability] = patch.whatsapp[ability];
  }
  if (typeof patch.remote?.taskWrites === "boolean") policy.remote.taskWrites = patch.remote.taskWrites;
  writePolicy(policy);
}

let audioDownload = null;
let audioPercent = 0;

function audioProgress() {
  return { ready: modelReady(), downloading: Boolean(audioDownload), percent: audioPercent };
}

function tellAudioProgress(error) {
  win?.webContents.send("whatsapp-audio", { ...audioProgress(), error });
}

/** The switch stays off until the free model is here and verified, so the AI never finds it half ready. */
async function fetchAudioModel() {
  audioDownload = new AbortController();
  audioPercent = 0;
  try {
    await downloadModel({
      signal: audioDownload.signal,
      onProgress: (percent) => {
        audioPercent = percent;
        tellAudioProgress();
      },
    });
    audioDownload = null;
    updatePolicy({ whatsapp: { audio: true } });
    tellAudioProgress();
  } catch (error) {
    const canceled = audioDownload?.signal.aborted;
    audioDownload = null;
    tellAudioProgress(canceled ? undefined : tr(error.message || "Could not download the audio model."));
  }
}

function setWhatsAppAudio(enabled) {
  if (!enabled) {
    audioDownload?.abort();
    updatePolicy({ whatsapp: { audio: false } });
    return;
  }
  if (modelReady()) updatePolicy({ whatsapp: { audio: true } });
  else if (!audioDownload) fetchAudioModel();
}

async function disconnectWhatsApp() {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: tr("Disconnect WhatsApp?"),
    detail: tr("This computer stops being a linked device. Your saved messages are kept, and you can link again with a QR code."),
    buttons: [tr("Cancel"), tr("Disconnect")],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await logoutWhatsApp();
}

async function disconnectGmail(email) {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: tr("Disconnect this Gmail account?"),
    detail: `${String(email)}\n\n${tr("SMCP will delete its saved password. To cancel it completely, also revoke it in your Google account.")}`,
    buttons: [tr("Cancel"), tr("Disconnect")],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await gmail.remove(String(email));
}

async function addVault() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: tr("Choose your notes folder"),
    buttonLabel: tr("Connect"),
    properties: ["openDirectory"],
  });
  if (!canceled && filePaths[0]) setVault(filePaths[0], true);
}

function toggleVault(path, enabled) {
  const known = lastState?.notes.vaults.some((vault) => vault.path === path);
  if (!known) throw new Error(tr("That vault is no longer available."));
  setVault(path, Boolean(enabled));
}

async function setOnboarded(value) {
  const settings = await readSettings();
  settings.onboarded = Boolean(value);
  await writeSettings(settings);
  if (value) askAutoUpdates().catch((error) => console.error("updates:", error.message));
}

const LINKS = {
  tailscale: "https://tailscale.com/download",
  appPasswords: "https://myaccount.google.com/apppasswords",
  twoStep: "https://myaccount.google.com/signinoptions/twosv",
  releases: RELEASES_PAGE,
};

function openLink(name) {
  const url = LINKS[name];
  if (!url) throw new Error(tr("Unknown link."));
  return shell.openExternal(url);
}

async function openTailscale() {
  const error = await shell.openPath(IS_MAC ? "/Applications/Tailscale.app" : "C:\\Program Files\\Tailscale\\tailscale-ipn.exe");
  if (error) throw new Error(tr("Could not open Tailscale."));
}

const PRIVACY_PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
};

function readPermissions() {
  if (!IS_MAC) return { accessibility: false, screen: false };
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screen: systemPreferences.getMediaAccessStatus("screen") === "granted",
  };
}

/** Asking is what adds SMCP, with its name and icon, to the macOS list. */
async function openPrivacy(pane) {
  const url = PRIVACY_PANES[pane];
  if (!url) throw new Error(tr("Unknown setting."));
  if (pane === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
  else if (pane === "screen") await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
  await shell.openExternal(url);
}

const TASK_TOOLS = {
  available: { name: "tasks_available" },
  summary: { name: "tasks_available" },
  search: { name: "tasks_search" },
  listProjects: { name: "tasks_list_projects" },
  claudeQueue: { name: "tasks_claude_queue" },
  hygiene: { name: "tasks_hygiene" },
  forecast: { name: "tasks_forecast" },
  reviewList: { name: "tasks_review_list" },
  markReviewed: { name: "tasks_mark_reviewed", write: true },
  create: { name: "tasks_create", write: true },
  update: { name: "tasks_update", write: true },
  appendNote: { name: "tasks_append_note", write: true },
  complete: { name: "tasks_complete", write: true },
};

const READS = { readOnlyHint: true };
const SENDS = { readOnlyHint: false, destructiveHint: true };

/** Checks the policy again here, because this is where the passwords are actually used. */
function allowed(tool, annotations, fn) {
  return (params) => {
    const denial = denialFor(tool, annotations, readPolicy());
    if (denial) throw new Error(denial);
    return fn(params);
  };
}

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(0, 50) : []);

/** The window is built here from the values themselves, so nothing can word it differently. */
async function createEventConfirmed(args) {
  const title = text(args.title, 200);
  const start = Number(args.start);
  const end = Number(args.end);
  if (!title?.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(tr("The event is not valid."));
  const allDay = args.allDay === true;
  const calendars = await eventKit.calendars(EVENTS);
  const calendar = args.calendar ? calendars.find((item) => item.id === args.calendar) : null;
  if (args.calendar && !calendar) throw new Error("No calendar has that id. Use calendar_list_calendars.");
  if (calendar && !calendar.writable) throw new Error("That calendar cannot be written.");
  const location = text(args.location, 300);
  const notes = text(args.notes, 2000);
  const when = allDay
    ? formatDay(start) === formatDay(end) ? formatDay(start) : `${formatDay(start)} → ${formatDay(end)}`
    : `${formatLocal(start).replace("T", " ").slice(0, 16)} → ${formatLocal(end).replace("T", " ").slice(0, 16)}`;
  const lines = [
    `${tr("Event")}: ${title}`,
    `${tr("When")}: ${when}${allDay ? ` (${tr("all day")})` : ""}`,
    `${tr("Calendar")}: ${calendar ? `${calendar.title} (${calendar.account})` : tr("default")}`,
    ...(location ? [`${tr("Where")}: ${location}`] : []),
    ...(notes ? ["", `${tr("Notes")}:`, notes] : []),
  ];
  if (!(await confirmInApp(lines.join("\n"), "SMCP: add event", "Add"))) {
    return { created: false, reason: "Not confirmed in the macOS window. Nothing was added." };
  }
  return { created: true, ...(await eventKit.createEvent({ title, start, end, allDay, calendar: args.calendar, location, notes })) };
}

const CALENDAR_OPS = {
  calendars: { name: "calendar_list_calendars", run: () => eventKit.calendars(EVENTS) },
  events: { name: "calendar_list_events", run: (a) => eventKit.events({ from: a.from, to: a.to, calendars: ids(a.calendars) }) },
  createEvent: { name: "calendar_create_event", write: true, run: createEventConfirmed },
  reminderLists: { name: "reminders_list_lists", run: () => eventKit.calendars(REMINDERS) },
  reminders: { name: "reminders_list", run: (a) => eventKit.reminders({ lists: ids(a.lists), includeCompleted: a.includeCompleted === true }) },
  createReminder: {
    name: "reminders_create",
    write: true,
    run: (a) => {
      const title = text(a.title, 300);
      if (!title?.trim()) throw new Error("The reminder needs a title.");
      const due = a.due === null || a.due === undefined ? null : Number(a.due);
      if (due !== null && !Number.isFinite(due)) throw new Error("Not a valid date.");
      return eventKit.createReminder({ title, list: text(a.list, 200), notes: text(a.notes, 5000), due, dueHasTime: a.dueHasTime === true });
    },
  },
  completeReminder: { name: "reminders_complete", write: true, run: (a) => eventKit.completeReminder({ id: String(a.id ?? "").slice(0, 300) }) },
};

const APPLE_NOTES_OPS = { search: "applenotes_search", recent: "applenotes_recent", read: "applenotes_read" };

/** The only actions the MCP server can ask this app to perform. */
function startActionHelper() {
  const whenRunning = (fn) => (params) => {
    if (readPolicy().paused) throw new Error("SMCP is paused. You can resume it from the app.");
    return fn(params);
  };
  return startHelper({
    jxa: whenRunning(({ name, params, timeoutMs }) => localJxa(name, params, Math.min(Number(timeoutMs) || 30_000, 60_000))),
    screenshot: whenRunning(localScreenshot),
    confirm: whenRunning(({ body }) => confirmInApp(String(body))),
    tasks: ({ op, args }) => {
      const tool = TASK_TOOLS[op];
      if (!tool) throw new Error("Unknown operation.");
      return allowed(tool.name, tool.write ? SENDS : READS, () => runTask(op, args))();
    },
    gmailAccounts: allowed("gmail_list_accounts", READS, () => gmail.listAccounts()),
    gmailSearch: allowed("gmail_search", READS, (params) => gmail.search(params)),
    gmailRead: allowed("gmail_read", READS, (params) => gmail.read(params)),
    gmailSend: allowed("gmail_send", SENDS, (params) => gmail.send(params)),
    gmailReply: allowed("gmail_reply", SENDS, (params) => gmail.reply(params)),
    gmailDraft: allowed("gmail_draft", { readOnlyHint: false }, (params) => gmail.draft(params)),
    gmailAttachment: allowed("gmail_read_attachment", READS, (params) => gmail.attachment(params)),
    calendar: ({ op, args }) => {
      const entry = CALENDAR_OPS[op];
      if (!entry || !IS_MAC) throw new Error("Unknown operation.");
      return allowed(entry.name, entry.write ? SENDS : READS, () => entry.run(args ?? {}))();
    },
    applenotes: ({ name, params }) => {
      const tool = APPLE_NOTES_OPS[name];
      if (!tool || !IS_MAC) throw new Error("Unknown operation.");
      return allowed(tool, READS, () => localAppleNotes(name, params ?? {}))();
    },
    screenText: allowed("screen_read_text", READS, (params) => localScreenText(params ?? {})),
  });
}

/** Contains no names, IPs, accounts, or message content, so it is safe to share. */
function copyDiagnostics() {
  const state = lastState;
  const isConnected = (id) => state?.clients.items.some((client) => client.id === id && client.connected);
  const lines = [
    `SMCP ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron}`,
    tr(state?.tailscale.installed ? (state.tailscale.running ? "Tailscale: connected" : "Tailscale: installed, not connected") : "Tailscale: not installed"),
    tr("Machines: {online} of {total} online", {
      online: state?.tailscale.machines.filter((machine) => machine.online).length ?? 0,
      total: state?.tailscale.machines.length ?? 0,
    }),
    tr(state?.whatsapp.supported ? (state.whatsapp.linked ? "WhatsApp: linked" : "WhatsApp: not linked") : "WhatsApp: unavailable"),
    `${tr(isConnected("claudeCode") ? "Claude Code: connected" : "Claude Code: no")} · ${tr(isConnected("claudeDesktop") ? "Claude Desktop: connected" : "Claude Desktop: no")}`,
    `${tr(state?.policy.paused ? "Paused: yes" : "Paused: no")} · ${tr(state?.policy.readOnly ? "Read-only: yes" : "Read-only: no")}`,
  ];
  clipboard.writeText(lines.join("\n"));
}

function restart() {
  app.relaunch();
  app.quit();
}

function beginLogin() {
  if (cancelLogin) return;
  cancelLogin = startLogin({
    onQr: async (code) => {
      const image = await QRCode.toDataURL(code, { width: 280, margin: 2 });
      win?.webContents.send("whatsapp-login", { state: "qr", image });
    },
    onDone: (error) => {
      cancelLogin = null;
      win?.webContents.send("whatsapp-login", { state: error ? "error" : "done", error: error ? tr(error) : error });
      collectState();
    },
  });
  win?.webContents.send("whatsapp-login", { state: "starting" });
}

/** The Dock icon follows the windows: the app can live only in the top bar. */
function syncDock() {
  if (!IS_MAC) return;
  if (win?.isVisible() || tasksWin?.isVisible()) app.dock?.show();
  else app.dock?.hide();
}

function showTasksWindow(taskId) {
  if (tasksWin) {
    tasksWin.show();
    tasksWin.focus();
    syncDock();
    if (taskId) tasksWin.webContents.send("focus-task", taskId);
    return;
  }
  tasksWin = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 760,
    minHeight: 480,
    title: tr("SMCP Tasks"),
    show: false,
    autoHideMenuBar: true,
    icon: join(HERE, "assets", "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181613" : "#f6f3ef",
    ...(IS_MAC ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  tasksWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  tasksWin.webContents.on("will-navigate", (event) => event.preventDefault());
  tasksWin.once("ready-to-show", () => {
    tasksWin.show();
    syncDock();
    if (taskId) tasksWin.webContents.send("focus-task", taskId);
  });
  tasksWin.on("closed", () => {
    tasksWin = null;
    syncDock();
  });
  tasksWin.loadFile(join(HERE, "ui", "tasks.html"));
}

function showWindow() {
  if (win) {
    if (IS_MAC) app.dock?.show();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 400,
    minHeight: 560,
    title: "SMCP",
    show: false,
    autoHideMenuBar: true,
    icon: join(HERE, "assets", "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181613" : "#f6f3ef",
    ...(IS_MAC ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    if (IS_MAC) app.dock?.show();
    win.show();
  });
  // Closing the window leaves the app in the top bar. "Quit" is what ends it.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    syncDock();
  });
  win.on("closed", () => {
    win = null;
  });
  win.loadFile(join(HERE, "ui", "index.html"));
}

function trayLook() {
  return {
    bar: !IS_MAC || nativeTheme.shouldUseDarkColors ? "dark" : "light",
    status: lastState?.policy.paused ? "paused" : "on",
  };
}

function trayImage() {
  const { bar, status } = trayLook();
  return nativeImage.createFromPath(join(HERE, "assets", `tray-${bar}-${status}.png`));
}

const setTrayImage = whenChanged(({ bar, status }) => {
  tray.setImage(nativeImage.createFromPath(join(HERE, "assets", `tray-${bar}-${status}.png`)));
});
const setTrayToolTip = whenChanged((text) => tray.setToolTip(text));
// A small arrow next to the icon in the menu bar while any of the user's computers has a newer SMCP waiting.
const setTrayTitle = whenChanged((text) => tray.setTitle(text));
// The panel re-reads state when told it changed, so telling it on every read would loop forever.
const tellPanel = whenChanged(() => panel?.webContents.send("state-changed"));

function updateTray() {
  if (!tray) return;
  setTrayImage(trayLook());
  const online = lastState?.tailscale.machines.filter((machine) => machine.online).length ?? 0;
  const pending = lastState?.update?.status === "available" || Boolean(lastState?.tailscale.machines.some((machine) => machine.outdated));
  if (IS_MAC) setTrayTitle(pending ? "↑" : "");
  const status = lastState?.policy.paused ? tr("SMCP: paused") : tr("SMCP: active · {online} online", { online });
  setTrayToolTip(pending ? `${status} · ${tr("update available")}` : status);
  tellPanel(lastState);
}

function positionPanel() {
  const trayBounds = tray.getBounds();
  const { width, height } = panel.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const centered = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const x = Math.min(Math.max(centered, workArea.x + 8), workArea.x + workArea.width - width - 8);
  const below = trayBounds.y < workArea.y + workArea.height / 2;
  const y = below ? Math.round(trayBounds.y + trayBounds.height + 6) : Math.round(trayBounds.y - height - 6);
  panel.setPosition(x, y, false);
}

function createPanel() {
  panel = new BrowserWindow({
    width: 320,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    ...(IS_MAC
      ? { vibrancy: "popover", visualEffectState: "active", transparent: true, backgroundColor: "#00000000" }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? "#181613" : "#f6f3ef" }),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (IS_MAC) panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.on("blur", () => {
    panelHiddenAt = Date.now();
    panel.hide();
  });
  panel.loadFile(join(HERE, "ui", "tray.html"));
}

function togglePanel() {
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  // The click that blurs the open panel arrives here too; do not reopen it.
  if (Date.now() - panelHiddenAt < 250) return;
  positionPanel();
  panel.show();
  panel.focus();
  panel.webContents.send("panel-shown");
  collectState();
}

function resizePanel(height) {
  const clamped = Math.min(Math.max(Math.ceil(Number(height) || 0), 160), screen.getPrimaryDisplay().workAreaSize.height - 16);
  const { width } = panel.getBounds();
  panel.setSize(width, clamped, false);
  if (panel.isVisible()) positionPanel();
}

function createTray() {
  tray = new Tray(trayImage());
  createPanel();
  tray.on("click", togglePanel);
  tray.on("right-click", () =>
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: tr("Open SMCP"), click: showWindow },
        { type: "separator" },
        { label: tr("Quit"), click: () => app.quit() },
      ]),
    ),
  );
  nativeTheme.on("updated", updateTray);
}

/** Every channel reports errors as data so the UI can show them. */
/* Updates: reachable only from the app's own windows, never from the AI tools. */

const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_UPDATE_CHECK_MS = 60_000;

const tellUpdates = whenChanged(() => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("updates-changed");
  if (lastState) {
    lastState = { ...lastState, update: updateSummary() };
    updateTray();
  }
});

/** The part of the updater's state the top bar and the devices list need. */
function updateSummary() {
  const { current, status, latest, canInstall } = updater.state();
  return { current, status, latest, canInstall };
}

const updater = createUpdater({
  currentVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  appBundle: IS_MAC && app.isPackaged ? join(process.execPath, "..", "..", "..") : null,
  tempRoot: app.getPath("temp"),
  bundleId: "com.santiago.smcp",
  quit: () => app.quit(),
  onChange: tellUpdates,
});

async function updatesState() {
  const settings = await readSettings().catch(() => ({}));
  const state = updater.state();
  return { ...state, message: tr(state.message), auto: settings.updates?.auto ?? null };
}

async function setAutoUpdates(enabled) {
  const settings = await readSettings();
  settings.updates = { ...settings.updates, auto: Boolean(enabled) };
  await writeSettings(settings);
}

let askingAboutUpdates = false;

/** Asks once, after setup, so a person always chooses before anything installs by itself. */
async function askAutoUpdates() {
  if (askingAboutUpdates || !app.isPackaged) return;
  const settings = await readSettings();
  if (settings.updates?.auto !== undefined || !settings.onboarded) return;
  askingAboutUpdates = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: tr("Do you want SMCP to update automatically?"),
      detail: IS_MAC
        ? tr("When there is a new version, SMCP will install it and restart. After each update, macOS will ask for the app's permissions again. You can change this in Settings.")
        : tr("We will let you know when there is a new version. You can change this in Settings."),
      buttons: [tr("Update automatically"), tr("Ask me first")],
      defaultId: 1,
      cancelId: 1,
    });
    await setAutoUpdates(response === 0);
  } finally {
    askingAboutUpdates = false;
  }
}

let notifiedVersion = null;

async function checkForUpdatesInBackground() {
  const snapshot = await updater.check();
  if (snapshot.status !== "available") return;
  await askAutoUpdates();
  const { updates } = await readSettings();
  if (updates?.auto === true && snapshot.canInstall) {
    await updater.install({ background: true });
    return;
  }
  if (notifiedVersion === snapshot.latest) return;
  notifiedVersion = snapshot.latest;
  new Notification({ title: tr("A new version of SMCP is available"), body: tr("Install version {version} from Settings.", { version: snapshot.latest }) }).show();
}

async function noticeAfterUpdate() {
  const settings = await readSettings();
  const version = app.getVersion();
  if (settings.lastVersion === version) return;
  const updated = Boolean(settings.lastVersion);
  settings.lastVersion = version;
  await writeSettings(settings);
  if (updated && IS_MAC) {
    new Notification({ title: tr("SMCP updated to {version}", { version }), body: tr("Check the macOS permissions in Settings so everything keeps working.") }).show();
  }
}

function startUpdates() {
  noticeAfterUpdate().catch((error) => console.error("updates:", error.message));
  if (!app.isPackaged) return;
  const run = () => checkForUpdatesInBackground().catch((error) => console.error("updates:", error.message));
  if (!startedInBackground) askAutoUpdates().catch((error) => console.error("updates:", error.message));
  setTimeout(run, FIRST_UPDATE_CHECK_MS);
  setInterval(run, UPDATE_CHECK_MS);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      // Core modules throw plain English; this is where a fixed message reaches a person.
      return { ok: false, error: tr(error.message) };
    }
  });
}

/** Asking for the language already in use does nothing, so a page can never reload itself in a loop. */
async function setLanguage(language) {
  if (language !== "en" && language !== "es") throw new Error(tr("Unknown language."));
  if (language === SMCP_I18N.language()) return;
  const settings = await readSettings();
  settings.language = language;
  await writeSettings(settings);
  SMCP_I18N.setLanguage(language);
  updateTray();
  // After this reply is delivered, so the page that asked does not lose it mid-reload.
  setImmediate(() => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.reload();
  });
}

function registerIpc() {
  // The preload calls this synchronously, so it must answer before any window exists.
  ipcMain.on("get-language", (event) => {
    event.returnValue = SMCP_I18N.language();
  });
  handle("set-language", setLanguage);
  handle("state", collectState);
  handle("open-terminal", openTerminal);
  handle("wake", wakeMachine);
  handle("update-machine", updateMachine);
  handle("set-client", setClient);
  handle("save-machine", saveMachine);
  handle("whatsapp-sync", syncWhatsApp);
  handle("whatsapp-login", beginLogin);
  handle("whatsapp-login-cancel", () => cancelLogin?.());
  handle("whatsapp-disconnect", disconnectWhatsApp);
  handle("whatsapp-audio", setWhatsAppAudio);
  handle("remote-set", setRemote);
  handle("remote-code", newRemoteCode);
  handle("remote-copy", copyRemoteUrl);
  handle("remote-revoke", (id) => remote?.revokeClient(String(id)));
  handle("panel-resize", resizePanel);
  handle("open-main", (tab) => {
    panel?.hide();
    showWindow();
    if (!["connections", "tasks", "settings"].includes(tab)) return;
    const send = () => win?.webContents.send("select-tab", tab);
    if (win?.webContents.isLoading()) win.webContents.once("did-finish-load", send);
    else send();
  });
  handle("tasks", runTask);
  handle("open-tasks", (id) => {
    panel?.hide();
    showTasksWindow(typeof id === "string" ? id : null);
  });
  handle("calendar-status", () => (IS_MAC ? calendarStatus() : "restricted"));
  handle("calendar-request", requestCalendar);
  handle("calendar-events", (from, to) => calendarEvents({ from, to }));
  handle("audit-list", () => readAudit({ limit: 200 }));
  handle("audit-clear", () => clearAudit());
  handle("tasks-set-hub", setTasksHub);
  handle("tasks-set-host", setTasksHost);
  handle("vault-add", addVault);
  handle("vault-set", toggleVault);
  handle("gmail-add", (values) => gmail.verifyAndAdd(values));
  handle("gmail-remove", disconnectGmail);
  handle("set-policy", updatePolicy);
  handle("set-onboarded", setOnboarded);
  handle("open-link", openLink);
  handle("open-tailscale", openTailscale);
  handle("open-privacy", openPrivacy);
  handle("copy-diagnostics", copyDiagnostics);
  handle("restart", restart);
  handle("set-open-at-login", (enabled) => app.setLoginItemSettings({ openAtLogin: Boolean(enabled) }));
  handle("quit", () => app.quit());
  handle("updates-state", updatesState);
  handle("updates-check", async () => {
    await updater.check();
    return updatesState();
  });
  handle("updates-install", async () => {
    await updater.install();
    return updatesState();
  });
  handle("updates-set-auto", setAutoUpdates);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", () => {
    if (!startedInBackground || process.uptime() > 5) showWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
    cancelLogin?.();
    remote?.stop();
    tasksHub?.stop();
    peerHub?.stop();
  });
  // Keep running in the top bar with no windows open.
  app.on("window-all-closed", () => {});
  app.whenReady().then(() => {
    Menu.setApplicationMenu(
      IS_MAC
        ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
        : null,
    );
    if (IS_MAC && !app.isPackaged) app.dock?.setIcon(join(HERE, "assets", "icon.png"));
    registerIpc();
    if (IS_MAC) startActionHelper().catch((error) => console.error("helper:", error.message));
    createTray();
    collectState();
    setInterval(collectState, REFRESH_MS);
    // At login Tailscale may still be starting. Each attempt re-reads the setting, so switching off stops it.
    retry(resumeRemote).catch((error) => console.error("remote:", error.message));
    retry(resumeTasksHub).catch((error) => console.error("tasks hub:", error.message));
    retry(startPeerHub).catch((error) => console.error("peers:", error.message));
    startUpdates();
    if (startedInBackground) app.dock?.hide();
    else showWindow();
  });
}
