import { execFile, spawn } from "node:child_process";
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
  powerSaveBlocker,
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
import "./ui/i18n/pt-settings.js";
import "./ui/i18n/pt-tasks.js";
import "./ui/i18n/pt-main.js";
import "./ui/i18n/fr-settings.js";
import "./ui/i18n/fr-tasks.js";
import "./ui/i18n/fr-main.js";
import "./ui/i18n/de-settings.js";
import "./ui/i18n/de-tasks.js";
import "./ui/i18n/de-main.js";
import "./ui/i18n/it-settings.js";
import "./ui/i18n/it-tasks.js";
import "./ui/i18n/it-main.js";
import {
  addToClaudeCode,
  addToDesktop,
  clientCatalog,
  isRegistered,
  removeFromClaudeCode,
  removeFromDesktop,
  serverEntry,
} from "./core/clients.js";
import { APPROVAL_LOCAL_PORT, APPROVAL_PORT, createApprovalPage } from "./core/approval-page.js";
import { createApprovals } from "./core/approvals.js";
import { createBrainExports } from "./core/brain.js";
import { createCalendarOps } from "./core/calendar-ops.js";
import { calendarEvents, calendarStatus, eventKit, requestCalendar } from "./core/calendar.js";
import { disableFunnel, enableFunnel, isFunnelOn, readBaseUrl } from "./core/funnel.js";
import { createAccountStore, createGmail } from "./core/gmail.js";
import { linuxSshCommand, magicPacket, readPcConfig, readTailscale, sendWake, sshCommandFile, sshTarget } from "./core/machines.js";
import { callPeer, createPeerHub, PEER_LOCAL_PORT, PEER_PORT, peerInfo, whatsappHost } from "./core/peers.js";
import { createAwake } from "./core/awake.js";
import { createNightLight } from "./core/nightlight.js";
import { createRemote, REMOTE_PORT } from "./core/remote.js";
import { createRemoteTasks, createTasksHub, disableServe, enableServe, tailscaleLogin } from "./core/tasks-hub.js";
import { createTaskStore, TASK_OPERATIONS } from "./core/tasks.js";
import { runSmokeTest } from "./core/smoke.js";
import { coalesce, retry, whenChanged } from "./core/throttle.js";
import { createUpdater, isNewer, RELEASES_PAGE } from "./core/updater.js";
import { createLiveSync, logoutWhatsApp, readWhatsApp, startLogin, syncWhatsApp } from "./core/whatsapp.js";
import { audioSupported, downloadModel } from "./core/whisper.js";
import { rawFolder, readBrainConfig, writeBrainConfig } from "../src/brain/config.js";
import { isAway } from "../src/origin.js";
import { buildAwayServer, buildRemoteServer } from "../src/remote-tools.js";
import { readServerConfig, ROUTED_AREAS, writeServerConfig } from "../src/server-route.js";
import { callToolInProcess } from "../src/tool-runner.js";
import { isActive as isAwakeActive, readSettings as readAwakeSettings } from "../src/awake.js";
import { clearAudit, readAudit } from "../src/audit.js";
import { aboutLocation, aboutStatus, startAbout } from "../src/context.js";
import { isLanguage } from "../src/languages.js";
import { localContacts } from "../src/contacts.js";
import { EVENTS } from "../src/eventkit.js";
import { startHelper } from "../src/helper.js";
import { denialFor, GROUPS, readPolicy, REMOTE_SWITCHES, WHATSAPP_ABILITIES, writePolicy } from "../src/policy.js";
import { createVpn } from "../src/vpn.js";
import { modelReady } from "../src/whisper.js";
import { listVaultChoices, setVault, vaultLocation } from "../src/vaults.js";
import { localAppleNotes } from "../src/tools/applenotes.js";
import { localJxa, localScreenshot, localScreenText } from "../src/tools/apps.js";
import { localConfirm, storeDir, wacliBin } from "../src/tools/whatsapp.js";
import { relayableArgs } from "../src/whatsapp-relay.js";
import { run as runCommand } from "../src/util.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
const REFRESH_MS = 30_000;
// CI starts the real app with this set to check it opens cleanly on every system, then quits.
const SMOKE_TEST = Boolean(process.env.SMCP_SMOKE_TEST);

if (SMOKE_TEST) {
  const fail = (error) => {
    console.error(`SMCP smoke test failed: ${error?.stack ?? error}`);
    app.exit(1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}

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

/** What was asked from outside this computer and waits for the person's answer on their own device. */
const approvals = createApprovals({
  onChange: () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("state-changed");
  },
});
let approvalPage = null;
let approvalUrl = null;

/**
 * The same dialog as ever, worded in the app's language. The AI supplies only the body.
 * A request that began outside this computer cannot use a window nobody is looking at: it waits on the
 * approval page instead, and fails at once when that page is not running, so nothing waits in vain.
 */
function confirmInApp(body, title = "SMCP: send WhatsApp", button = "Send") {
  if (isAway()) {
    if (!approvalUrl) throw new Error("The approval page is not running on the computer, so this could not be approved. It needs Tailscale. Nothing was done.");
    return approvals.confirm({ title: tr(title), action: tr(button), body });
  }
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

/** The raw exports to the vault. A source that starts failing tells the person once, not on every run. */
const brainExports = createBrainExports({
  gmail,
  storePath: () => join(storeDir(), "wacli.db"),
  onChange: () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("state-changed");
  },
  onFailure: (source, message) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: tr("SMCP could not export {source} to your notes", { source }), body: message }).show();
  },
});
/** Warms the screen like f.lux. Every window hears about changes so its sliders stay in step. */
const nightLight = createNightLight({
  supported: IS_MAC,
  onChange: () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("nightlight-changed");
  },
});

/** What the AI may ask of the night light, each checked against the policy like any other tool. */
const NIGHTLIGHT_OPS = {
  status: { name: "nightlight_status", annotations: { readOnlyHint: true }, run: () => nightLight.status() },
  configure: { name: "nightlight_set", run: (a) => nightLight.configure(a) },
  setNow: { name: "nightlight_now", run: (a) => nightLight.setNow(a) },
  pause: { name: "nightlight_now", run: (a) => nightLight.pause(Number(a.minutes) || 60) },
  clearNow: { name: "nightlight_now", run: () => nightLight.clearNow() },
};

/** Tailscale and the person's other VPNs. A click in the window is the person's own choice, like the night light's. */
const vpn = createVpn();
const VPN_UI_OPS = {
  // The window checks every few seconds, so a VPN turned on in its own app gets Tailscale's DNS out of the way too.
  status: async () => {
    await vpn.reconcile().catch(() => null);
    return vpn.status();
  },
  connect: (a) => vpn.connect(String(a.vpn ?? "")),
  disconnect: (a) => vpn.disconnect(String(a.vpn ?? "")),
};

/** What the windows may ask: the same, plus a short preview while a slider moves. */
const NIGHTLIGHT_UI_OPS = {
  status: () => nightLight.status(),
  configure: (a) => nightLight.configure(a),
  setNow: (a) => nightLight.setNow(a),
  pause: (a) => nightLight.pause(Number(a.minutes) || 60),
  clearNow: () => nightLight.clearNow(),
  preview: (a) => nightLight.preview(a),
};

/** Windows and Linux have no caffeinate: Electron's own blocker holds the computer awake there. */
function startElectronKeeper({ displayOn }) {
  const id = powerSaveBlocker.start(displayOn ? "prevent-display-sleep" : "prevent-app-suspension");
  return { pid: null, stop: () => powerSaveBlocker.stop(id) };
}

const AWAKE_ENDED = {
  time: () => tr("The time you chose is up."),
  app: () => tr("The app it was waiting for has closed."),
  battery: () => tr("The battery reached the level you chose, so the computer can sleep and save it."),
};

/** Keeps the computer running with its screen off, like Amphetamine. Every window hears about changes. */
const awake = createAwake({
  ...(IS_MAC ? {} : { startKeeper: startElectronKeeper }),
  onChange: () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("awake-changed");
    updateTray();
  },
  onEnded: (reason) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: tr("SMCP stopped keeping the computer awake"), body: AWAKE_ENDED[reason]?.() ?? tr("Keep awake ended.") }).show();
  },
});

/** What the AI may ask: the same checks as any other tool. Setting up closed-lid mode is only for the person. */
const AWAKE_OPS = {
  status: { name: "awake_status", annotations: { readOnlyHint: true }, run: () => awake.status() },
  diagnose: { name: "awake_status", annotations: { readOnlyHint: true }, run: () => awake.diagnose() },
  start: { name: "awake_start", run: (a) => awake.start({ ...a, by: "ai" }) },
  stop: { name: "awake_stop", run: () => awake.stop() },
  screenOff: { name: "awake_screen_off", run: () => awake.screenOff() },
};

const AWAKE_UI_OPS = {
  status: () => awake.status(),
  diagnose: () => awake.diagnose(),
  start: (a) => awake.start({ ...a, by: "person" }),
  stop: () => awake.stop(),
  screenOff: () => awake.screenOff(),
  configure: (a) => awake.configure(a),
  setupClosedLid: () => awake.setupClosedLid(),
  removeClosedLid: () => awake.removeClosedLid(),
};

/** What each of the user's other computers running SMCP last said about itself, by machine name. */
const peers = new Map();

const settingsPath = () => join(app.getPath("userData"), "settings.json");

/** Read synchronously: the preload asks for the language before any window can wait on a promise. */
function readSavedLanguage() {
  try {
    const { language } = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return isLanguage(language) ? language : "en";
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

// New WhatsApp messages are saved as they arrive while WhatsApp is linked, not only when someone asks for a sync.
const liveSync = createLiveSync();

/** Follows the linked state that every refresh reads, so linking starts it and unlinking stops it. */
async function readWhatsAppLive() {
  const whatsapp = await readWhatsApp();
  if (SMOKE_TEST) return whatsapp;
  if (whatsapp.linked) liveSync.start();
  // A diagnostics read that failed says nothing about the link, so it leaves the live sync alone.
  else if (whatsapp.installed && !whatsapp.unreadable) liveSync.stop();
  // Not linked here, but linked on another of the person's computers: that one answers for this one.
  const elsewhere = whatsapp.linked ? null : (whatsappHost(lastState?.tailscale.machines ?? [], peers)?.name ?? null);
  return { ...whatsapp, live: liveSync.running(), elsewhere };
}

const RELAY_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 250_000;

/**
 * Another of the person's computers asks this one for WhatsApp. Only checked read-only commands run,
 * against this computer's own store, and only while this computer lets AI read WhatsApp.
 */
async function serveWhatsAppToPeer({ args } = {}) {
  const policy = readPolicy();
  if (policy.paused) throw new Error("SMCP is paused on the computer with WhatsApp.");
  if (policy.disabled?.whatsapp || !policy.whatsapp?.read) throw new Error("Reading WhatsApp is turned off on the computer with WhatsApp.");
  if (!lastState?.whatsapp?.linked) throw new Error("WhatsApp is not linked on that computer anymore.");
  if (Array.isArray(args) && args.length === 1 && args[0] === "sync") {
    await syncWhatsAppNow();
    return { code: 0, stdout: JSON.stringify({ success: true, data: { synced: true, live: liveSync.running() } }), stderr: "" };
  }
  const command = relayableArgs(args);
  if (!command) throw new Error("That WhatsApp command cannot be asked for from another computer.");
  const result = await runCommand(wacliBin(), [`--store=${storeDir()}`, "--read-only", "--json", ...command], { timeoutMs: RELAY_TIMEOUT_MS });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: Boolean(result.timedOut), truncated: Boolean(result.truncated) };
}

/** This computer has no WhatsApp session, so it asks the one that has it. */
async function relayWhatsApp({ args, timeoutMs } = {}) {
  const host = whatsappHost(lastState?.tailscale.machines ?? [], peers);
  if (!host) {
    throw new Error(
      "WhatsApp is not linked on this computer, and none of your other computers with WhatsApp linked is on with SMCP open right now.",
    );
  }
  const sync = Array.isArray(args) && args[0] === "sync";
  const wait = sync ? SYNC_TIMEOUT_MS : Math.min(Number(timeoutMs) || RELAY_TIMEOUT_MS, RELAY_TIMEOUT_MS);
  return callPeer(host.dns, "whatsapp", { args }, { timeoutMs: wait + 5_000 });
}

/** While the live sync runs, the database is already current, so a manual sync has nothing to add. */
async function syncWhatsAppNow() {
  if (liveSync.running()) return;
  await syncWhatsApp();
  liveSync.start();
}

async function readState() {
  const [tailscale, whatsapp, settings, pcConfig, gmailAccounts, tasks] = await Promise.all([
    readTailscale(),
    readWhatsAppLive(),
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
      smcp: smcp ? { version: smcp.version, latest: outdated ? newest : null, tools: Boolean(smcp.tools) } : null,
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
      healthUrl: remoteBaseUrl ? `${remoteBaseUrl}/health` : null,
      pairing: remote?.activePairing() ?? null,
      clients: (remote?.listClients() ?? []).map((client) => ({ ...client, name: tr(client.name) })),
      activity: remote?.activity() ?? null,
      approvalsUrl: approvalUrl,
      waiting: approvals.pending().length,
    },
    // Which computer is the person's server, and whether this one lets the others use it.
    server: { chosen: readServerConfig(), areas: ROUTED_AREAS },
    brain: IS_MAC ? brainExports.status() : null,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    onboarded: settings.onboarded === true,
    permissions: readPermissions(),
    policy: readPolicy(),
    about: readAboutStatus(),
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
  if (IS_LINUX) {
    const terminal = linuxSshCommand(target);
    if (!terminal) throw new Error(tr("No terminal app was found to open SSH."));
    spawn(terminal.command, terminal.args, { detached: true, stdio: "ignore" }).unref();
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

/**
 * Another of the person's computers asks this one, their server, to run a tool. It goes through the
 * same server as the remote connector: this computer's own switches, limits and approvals decide.
 */
async function runPeerTool({ name, args, origin, from } = {}) {
  const client = String(from ?? "").replace(/[^\w .-]/g, "").slice(0, 40) || "another computer";
  const server = buildAwayServer({ source: "peer", client, approvals, approvalUrl: () => approvalUrl, relayedRemote: origin === "remote" });
  return callToolInProcess(server, name, args, { timeoutMs: 170_000 });
}

async function startPeerHub() {
  if (peerHub) return;
  if (!(await readTailscale()).installed) return;
  const owner = await tailscaleLogin();
  if (!owner) throw new Error(tr("Sign in to Tailscale to share your tasks."));
  const hub = createPeerHub({
    owner,
    handlers: {
      info: () =>
        peerInfo({ version: app.getVersion(), platform: process.platform, update: updater.state(), whatsapp: lastState?.whatsapp, tools: readPolicy().peers.tools }),
      whatsapp: serveWhatsAppToPeer,
      tool: runPeerTool,
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

/** The cheapest full check: build the connector's server and run its lightest tool, as a remote call would. */
async function remoteHealthCheck() {
  const result = await callToolInProcess(buildAwayServer({ source: "remote", client: "health check" }), "smcp_ping", {}, { timeoutMs: 10_000 });
  return !result?.isError;
}

async function ensureRemote() {
  remoteBaseUrl ??= await readBaseUrl();
  remote ??= createRemote({
    baseUrl: remoteBaseUrl,
    buildServer: (context) => buildRemoteServer({ ...context, approvals, approvalUrl: () => approvalUrl }),
    healthCheck: remoteHealthCheck,
  });
  return remote;
}

/**
 * The approval page runs while something outside this computer could need it: remote access is on, or
 * the person's other computers may use this one. It is shared only inside their Tailscale network.
 */
async function syncApprovalPage() {
  const needed = IS_MAC && (Boolean(remote?.running()) || readPolicy().peers.tools);
  if (!needed) {
    if (!approvalPage) return;
    await approvalPage.stop();
    approvalPage = null;
    approvalUrl = null;
    await disableServe(APPROVAL_PORT, { scheme: "https" }).catch(() => {});
    return;
  }
  if (approvalPage) return;
  const owner = await tailscaleLogin();
  if (!owner) throw new Error(tr("Sign in to Tailscale to turn on remote access."));
  const host = new URL(await readBaseUrl()).host;
  const page = createApprovalPage({ approvals, owner, tr, lang: () => SMCP_I18N.locale() });
  await page.start();
  let scheme = "https";
  try {
    await enableServe(APPROVAL_PORT, APPROVAL_LOCAL_PORT, { scheme });
  } catch {
    // A tailnet without HTTPS certificates still serves it plainly; the tunnel itself is encrypted.
    scheme = "http";
    try {
      await enableServe(APPROVAL_PORT, APPROVAL_LOCAL_PORT, { scheme });
    } catch (error) {
      await page.stop();
      throw error;
    }
  }
  approvalPage = page;
  approvalUrl = `${scheme}://${host}:${APPROVAL_PORT}/`;
}

const syncApprovalPageQuietly = () => syncApprovalPage().catch((error) => console.error("approvals:", error.message));

/**
 * One button that ends everything reachable from outside: the public URL goes off, every remote switch
 * goes back to off, every connected app is signed out, and anything waiting for approval is rejected.
 */
async function remotePanic() {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: tr("Turn off all remote access?"),
    detail: tr("The private URL stops working, every remote permission goes back to off, every connected app is signed out and anything waiting for your approval is rejected. Your other computers stop being able to use this one too."),
    buttons: [tr("Cancel"), tr("Turn everything off")],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return { done: false };
  const rejected = approvals.rejectAll();
  const policy = readPolicy();
  for (const name of REMOTE_SWITCHES) policy.remote[name] = false;
  policy.peers.tools = false;
  writePolicy(policy);
  let signedOut = 0;
  try {
    signedOut = (await ensureRemote()).revokeAll();
  } catch {
    // Without Tailscale there is no connector to sign anyone out of.
  }
  await setRemote(false).catch((error) => console.error("remote:", error.message));
  await syncApprovalPageQuietly();
  return { done: true, rejected, signedOut };
}

/** What was done from outside this computer today, newest first, and what is waiting. */
function remoteActivity() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return {
    activity: remote?.activity() ?? null,
    today: readAudit({ limit: 500, away: true, since: midnight.getTime() }),
    waiting: approvals.pending(),
    approvalsUrl: approvalUrl,
  };
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
  await syncApprovalPageQuietly();
}

async function resumeRemote() {
  if (!IS_MAC || !(await readSettings()).remote) return;
  const server = await ensureRemote();
  await server.start();
  if (!(await isFunnelOn(REMOTE_PORT))) await enableFunnel(REMOTE_PORT);
  await syncApprovalPageQuietly();
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
  for (const name of REMOTE_SWITCHES) {
    if (typeof patch.remote?.[name] === "boolean") policy.remote[name] = patch.remote[name];
  }
  if (typeof patch.peers?.tools === "boolean") policy.peers.tools = patch.peers.tools;
  if (Array.isArray(patch.calendar?.autoWrite)) policy.calendar.autoWrite = patch.calendar.autoWrite;
  writePolicy(policy);
  if (patch.peers) syncApprovalPageQuietly();
}

/**
 * Chooses the person's server computer and which areas run there, or `null` to work on this one alone.
 * Only a computer of theirs that runs SMCP and lets the others use it can be chosen.
 */
function setServer(choice) {
  if (!choice?.host) return writeServerConfig(null);
  const machine = lastState?.tailscale.machines.find((item) => item.dns === choice.host && !item.self);
  if (!machine) throw new Error(tr("That computer no longer appears in Tailscale."));
  if (!peers.has(machine.name)) throw new Error(tr("That computer is not running SMCP right now, so it cannot be your server."));
  return writeServerConfig({ host: machine.dns, name: machine.alias || machine.name, areas: choice.areas ?? {} });
}

/** Saves the raw export settings. The vault must be a folder that already has raw/ inside. */
function setBrain(patch) {
  // A folder outside raw/ is refused out loud; dropping it quietly would look like it was saved.
  for (const entry of Object.values(patch?.gmail?.accounts ?? {})) rawFolder(entry?.folder);
  if (patch?.whatsapp?.folder !== undefined) rawFolder(patch.whatsapp.folder);
  const current = readBrainConfig();
  const next = {
    ...current,
    ...(typeof patch?.vault === "string" || patch?.vault === null ? { vault: patch.vault } : {}),
    whatsapp: { ...current.whatsapp, ...(patch?.whatsapp ?? {}) },
    gmail: { ...current.gmail, ...(patch?.gmail ?? {}) },
  };
  if (next.vault && !existsSync(join(next.vault, "raw"))) throw new Error(tr("That folder has no raw folder inside, so it does not look like your notes vault."));
  return writeBrainConfig(next);
}

async function chooseBrainVault() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: tr("Choose the vault that receives the raw exports"),
    buttonLabel: tr("Choose"),
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths[0]) return null;
  return setBrain({ vault: filePaths[0] });
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
  // Logging out needs the store lock, which the live sync holds, so it pauses first and stays off if the logout works.
  if (response === 1) {
    await liveSync.pause(async () => {
      await logoutWhatsApp();
      await liveSync.stop();
    });
  }
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

/** Where the person's notes for the AI live; a broken vault setting must not break the whole screen. */
function readAboutStatus() {
  try {
    return aboutStatus();
  } catch {
    return null;
  }
}

async function openAbout() {
  const { path } = aboutLocation();
  if (!existsSync(path)) throw new Error(tr("Write something about yourself first."));
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
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
  // On Linux Tailscale has no app window; its machines and settings live in the web console.
  if (IS_LINUX) return shell.openExternal("https://login.tailscale.com/admin/machines");
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

const TCC_SERVICES = { accessibility: "Accessibility", screen: "ScreenCapture" };

/**
 * SMCP is signed ad hoc, so macOS ties each permission to the exact build. After an update or a new build
 * the switch in System Settings still looks on, but it belongs to the old copy and never applies to this one.
 * When the permission is missing, clearing SMCP's entry lets the request below add this copy in its place.
 */
function clearStalePermission(pane) {
  const service = TCC_SERVICES[pane];
  if (!service || readPermissions()[pane]) return Promise.resolve();
  return new Promise((resolve) => execFile("/usr/bin/tccutil", ["reset", service, "com.santiago.smcp"], { timeout: 5_000 }, () => resolve()));
}

/** Asking is what adds SMCP, with its name and icon, to the macOS list. */
async function openPrivacy(pane) {
  const url = PRIVACY_PANES[pane];
  if (!url) throw new Error(tr("Unknown setting."));
  await clearStalePermission(pane);
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

/**
 * Calendar and Reminders. Events ask in a window (or, from outside this computer, on the approval
 * page), except in the calendars the person chose for writing without it.
 */
const CALENDAR_OPS = createCalendarOps({
  eventKit,
  confirm: confirmInApp,
  tr,
  autoCalendars: () => readPolicy().calendar.autoWrite,
});

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
    // The tool already passed this computer's permission check; the computer with WhatsApp checks its own too.
    whatsappRelay: whenRunning(relayWhatsApp),
    approvalStatus: whenRunning(({ id, waitSeconds } = {}) => approvals.describeStatus(id, { waitSeconds, url: approvalUrl })),
    brainExport: allowed("brain_export_now", { readOnlyHint: false, destructiveHint: false }, (params) => brainExports.runNow({ source: text(params?.source, 200) })),
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
    contacts: (params) => {
      if (!IS_MAC) throw new Error("Contacts are only available on a Mac.");
      return allowed("people_lookup", READS, () => localContacts(params ?? {}))();
    },
    screenText: allowed("screen_read_text", READS, (params) => localScreenText(params ?? {})),
    nightlight: ({ op, args }) => {
      const entry = NIGHTLIGHT_OPS[op];
      if (!entry || !IS_MAC) throw new Error("Unknown operation.");
      const annotations = entry.annotations ?? { readOnlyHint: false, destructiveHint: false };
      return allowed(entry.name, annotations, () => entry.run(args && typeof args === "object" ? args : {}))();
    },
    awake: ({ op, args }) => {
      const entry = AWAKE_OPS[op];
      if (!entry) throw new Error("Unknown operation.");
      const annotations = entry.annotations ?? { readOnlyHint: false, destructiveHint: false };
      return allowed(entry.name, annotations, () => entry.run(args && typeof args === "object" ? args : {}))();
    },
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

/** Whether the Windows taskbar is light. It has its own setting, apart from the app colors that nativeTheme follows. */
let windowsTaskbarLight = false;
const PERSONALIZE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";

function readWindowsTaskbar() {
  if (process.platform !== "win32") return;
  execFile("reg", ["query", PERSONALIZE_KEY, "/v", "SystemUsesLightTheme"], { windowsHide: true }, (error, stdout) => {
    const light = !error && /SystemUsesLightTheme\s+REG_DWORD\s+0x0*1\b/i.test(stdout);
    if (light === windowsTaskbarLight) return;
    windowsTaskbarLight = light;
    updateTray();
  });
}

/** Light bars get the black mark with green, dark bars the white one. */
function barIsLight() {
  if (IS_MAC) return !nativeTheme.shouldUseDarkColors;
  if (process.platform === "win32") return windowsTaskbarLight;
  return false;
}

function trayLook() {
  return {
    bar: barIsLight() ? "light" : "dark",
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

/** Whether keep awake is on, for the tray's tooltip. Read from the file, so it never waits on macOS. */
let awakeOn = false;

function updateTray() {
  awakeOn = isAwakeActive(readAwakeSettings());
  if (!tray) return;
  setTrayImage(trayLook());
  const online = lastState?.tailscale.machines.filter((machine) => machine.online).length ?? 0;
  const pending = lastState?.update?.status === "available" || Boolean(lastState?.tailscale.machines.some((machine) => machine.outdated));
  if (IS_MAC) setTrayTitle(pending ? "↑" : "");
  const status = lastState?.policy.paused ? tr("SMCP: paused") : tr("SMCP: active · {online} online", { online });
  const parts = [status, ...(awakeOn ? [tr("keeping the computer awake")] : []), ...(pending ? [tr("update available")] : [])];
  setTrayToolTip(parts.join(" · "));
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
  // Quitting closes every window while the tray icon can still be clicked; forget the panel so nothing touches it.
  panel.on("closed", () => {
    panel = null;
  });
  panel.loadFile(join(HERE, "ui", "tray.html"));
}

function togglePanel() {
  if (quitting) return;
  if (!panel || panel.isDestroyed()) createPanel();
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
  if (!panel || panel.isDestroyed()) return;
  const clamped = Math.min(Math.max(Math.ceil(Number(height) || 0), 160), screen.getPrimaryDisplay().workAreaSize.height - 16);
  const { width } = panel.getBounds();
  panel.setSize(width, clamped, false);
  if (panel.isVisible()) positionPanel();
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: tr("Open SMCP"), click: showWindow },
    { type: "separator" },
    { label: tr("Quit"), click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(trayImage());
  createPanel();
  if (IS_LINUX) {
    // Most Linux desktops show tray icons as app indicators, which never report clicks: a menu is the only way in.
    tray.setContextMenu(trayMenu());
    tray.on("click", showWindow);
  } else {
    tray.on("click", togglePanel);
    tray.on("right-click", () => tray.popUpContextMenu(trayMenu()));
  }
  nativeTheme.on("updated", () => {
    readWindowsTaskbar();
    updateTray();
  });
  if (process.platform === "win32") {
    readWindowsTaskbar();
    // Changing only the taskbar color does not always reach nativeTheme, so it is checked now and then too.
    setInterval(readWindowsTaskbar, 30_000).unref?.();
  }
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
        ? tr("When there is a new version, SMCP will install it and restart. You can change this in Settings.")
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
    new Notification({ title: tr("SMCP updated to {version}", { version }) }).show();
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
  if (!isLanguage(language)) throw new Error(tr("Unknown language."));
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
  handle("whatsapp-sync", syncWhatsAppNow);
  handle("whatsapp-login", beginLogin);
  handle("whatsapp-login-cancel", () => cancelLogin?.());
  handle("whatsapp-disconnect", disconnectWhatsApp);
  handle("whatsapp-audio", setWhatsAppAudio);
  handle("remote-set", setRemote);
  handle("remote-code", newRemoteCode);
  handle("remote-copy", copyRemoteUrl);
  handle("remote-revoke", (id) => remote?.revokeClient(String(id)));
  handle("remote-panic", remotePanic);
  handle("remote-activity", remoteActivity);
  handle("server-set", setServer);
  handle("brain-set", setBrain);
  handle("brain-choose-vault", chooseBrainVault);
  handle("brain-run", (source) => brainExports.runNow({ source: typeof source === "string" ? source : undefined }));
  handle("calendar-list", () => (IS_MAC ? eventKit.calendars(EVENTS) : []));
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
  handle("nightlight", (op, args) => {
    const run = NIGHTLIGHT_UI_OPS[op];
    if (!run) throw new Error(tr("Unknown operation."));
    return run(args && typeof args === "object" ? args : {});
  });
  handle("awake", (op, args) => {
    const run = AWAKE_UI_OPS[op];
    if (!run) throw new Error(tr("Unknown operation."));
    return run(args && typeof args === "object" ? args : {});
  });
  handle("vpn", (op, args) => {
    const run = VPN_UI_OPS[op];
    if (!run) throw new Error(tr("Unknown operation."));
    return run(args && typeof args === "object" ? args : {});
  });
  handle("set-onboarded", setOnboarded);
  handle("about-save", (text) => startAbout(text));
  handle("about-open", openAbout);
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

/** Opens every window, reads the state the screens show, and quits with 0 if nothing went wrong. */
async function smokeTest() {
  showWindow();
  showTasksWindow();
  const problems = await runSmokeTest({
    windows: { main: win, panel, tasks: tasksWin },
    check: async () => {
      const state = await readState();
      if (!state?.policy || !state?.tailscale) throw new Error("the app state is incomplete");
      for (const window of [win, panel, tasksWin]) {
        if (window.isDestroyed()) throw new Error("a window closed by itself");
      }
    },
  });
  if (problems.length) {
    console.error(`SMCP smoke test failed on ${process.platform}:\n- ${problems.join("\n- ")}`);
    app.exit(1);
    return;
  }
  console.log(`SMCP smoke test passed on ${process.platform} ${process.arch} (Electron ${process.versions.electron}).`);
  app.exit(0);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", () => {
    if (!startedInBackground || process.uptime() > 5) showWindow();
  });
  let awakeReleased = false;
  app.on("before-quit", (event) => {
    // Closed-lid mode must be undone before SMCP is gone, so wait for it once.
    if (!awakeReleased) {
      event.preventDefault();
      awakeReleased = true;
      const timeout = new Promise((resolve) => setTimeout(resolve, 5_000));
      Promise.race([awake.shutdown(), timeout])
        .catch(() => {})
        .finally(() => app.quit());
      return;
    }
    quitting = true;
    cancelLogin?.();
    liveSync.stop();
    brainExports.stop();
    approvalPage?.stop();
    remote?.stop();
    tasksHub?.stop();
    peerHub?.stop();
    nightLight.stop();
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
    if (IS_MAC) nightLight.start();
    if (!SMOKE_TEST) awake.launch().catch((error) => console.error("awake:", error.message));
    createTray();
    collectState();
    setInterval(collectState, REFRESH_MS);
    // At login Tailscale may still be starting. Each attempt re-reads the setting, so switching off stops it.
    retry(resumeRemote).catch((error) => console.error("remote:", error.message));
    retry(resumeTasksHub).catch((error) => console.error("tasks hub:", error.message));
    retry(startPeerHub).catch((error) => console.error("peers:", error.message));
    retry(syncApprovalPage).catch((error) => console.error("approvals:", error.message));
    // The exports need the Mac's WhatsApp store and Gmail accounts; elsewhere there is nothing to pull.
    if (IS_MAC && !SMOKE_TEST) brainExports.start();
    if (SMOKE_TEST) return smokeTest();
    startUpdates();
    if (startedInBackground) app.dock?.hide();
    else showWindow();
  });
}
