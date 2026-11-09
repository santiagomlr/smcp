import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import {
  addToClaudeCode,
  addToDesktop,
  clientCatalog,
  isRegistered,
  removeFromClaudeCode,
  removeFromDesktop,
  serverEntry,
} from "./core/clients.js";
import { calendarEvents, calendarStatus, requestCalendar } from "./core/calendar.js";
import { disableFunnel, enableFunnel, isFunnelOn, readBaseUrl } from "./core/funnel.js";
import { createAccountStore, createGmail } from "./core/gmail.js";
import { readPcConfig, readTailscale, sendWake, sshCommandFile, sshTarget } from "./core/machines.js";
import { createRemote, REMOTE_PORT } from "./core/remote.js";
import { createRemoteTasks, createTasksHub, disableServe, enableServe, tailscaleLogin } from "./core/tasks-hub.js";
import { createTaskStore, TASK_OPERATIONS } from "./core/tasks.js";
import { coalesce, retry, whenChanged } from "./core/throttle.js";
import { createUpdater, RELEASES_PAGE } from "./core/updater.js";
import { logoutWhatsApp, readWhatsApp, startLogin, syncWhatsApp } from "./core/whatsapp.js";
import { audioSupported, downloadModel } from "./core/whisper.js";
import { buildRemoteServer } from "../src/remote-tools.js";
import { startHelper } from "../src/helper.js";
import { denialFor, GROUPS, readPolicy, WHATSAPP_ABILITIES, writePolicy } from "../src/policy.js";
import { modelReady } from "../src/whisper.js";
import { listVaultChoices, setVault, vaultLocation } from "../src/vaults.js";
import { localJxa, localScreenshot } from "../src/tools/apps.js";
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

const gmail = createGmail({
  store: createAccountStore({
    encrypt: (text) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Esta computadora no permite guardar contraseñas cifradas.");
      return safeStorage.encryptString(text).toString("base64");
    },
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, "base64")),
  }),
  confirm: localConfirm,
});

let localTasks = null;
let tasksHub = null;

const settingsPath = () => join(app.getPath("userData"), "settings.json");

/** A damaged file is an error, not empty settings: empty would send tasks to a second, local list. */
async function readSettings() {
  let text;
  try {
    text = await readFile(settingsPath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("No se pudieron leer los ajustes de SMCP.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Los ajustes de SMCP están dañados. Revisa ${settingsPath()}.`);
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
  const machines = tailscale.machines.map((machine) => ({
    ...machine,
    alias: settings.machines?.[machine.name]?.alias ?? "",
    user: settings.machines?.[machine.name]?.user ?? "",
    canWake: machine.os === "windows" && !machine.online && Boolean(pcConfig.mac),
  }));
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
      clients: remote?.listClients() ?? [],
    },
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    onboarded: settings.onboarded === true,
    permissions: readPermissions(),
    policy: readPolicy(),
    version: app.getVersion(),
  };
  updateTray();
  return lastState;
}

function findMachine(name) {
  const machine = lastState?.tailscale.machines.find((item) => item.name === name);
  if (!machine) throw new Error("Esa máquina ya no aparece en Tailscale.");
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

async function wakeMachine(name) {
  if (findMachine(name).os !== "windows") throw new Error("Solo la PC se puede encender desde aquí.");
  await sendWake(await readPcConfig());
}

function mcpEntry() {
  return serverEntry({
    execPath: process.execPath,
    script: join(ROOT, "src", "index.js"),
    wacliBin: process.env.WACLI_BIN || (app.isPackaged ? null : join(ROOT, "vendor", "bin", "wacli")),
  });
}

async function setClient(client, enabled) {
  if (!IS_MAC) throw new Error("El servidor local por ahora solo funciona en Mac.");
  const item = clientCatalog().find(({ id }) => id === client);
  if (!item) throw new Error("Cliente desconocido.");
  if (item.cli) {
    await (enabled ? addToClaudeCode(mcpEntry()) : removeFromClaudeCode());
  } else if (enabled) {
    await addToDesktop(item.path, { ...item.extra, ...mcpEntry() }, item.key);
  } else {
    await removeFromDesktop(item.path, item.key);
  }
}

/* Tasks */

function localStore() {
  localTasks ??= createTaskStore();
  return localTasks;
}

/** One list only: if another computer holds it, an outage is an error, never a second list. */
async function runTask(op, args) {
  if (!TASK_OPERATIONS.includes(op)) throw new Error("Operación desconocida.");
  const { tasksHost } = await readSettings();
  const store = tasksHost ? createRemoteTasks({ host: tasksHost }) : localStore();
  return store[op](args ?? {});
}

async function readTasksSummary() {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("La computadora de tus tareas no responde.")), 3_000));
  try {
    return { summary: await Promise.race([runTask("summary"), timeout]), error: null };
  } catch (error) {
    return { summary: null, error: error.message };
  }
}

async function startTasksHub() {
  if (tasksHub) return;
  const owner = await tailscaleLogin();
  if (!owner) throw new Error("Inicia sesión en Tailscale para compartir tus tareas.");
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
    if (settings.tasksHost) throw new Error("Esta computadora usa las tareas de otra. Cambia primero dónde se guardan.");
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
    if (!machine) throw new Error("Esa computadora ya no aparece en Tailscale.");
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
  if (!remote?.running()) throw new Error("Activa primero el acceso remoto.");
  return remote.newPairingCode();
}

function copyRemoteUrl() {
  if (!remoteBaseUrl) throw new Error("Activa primero el acceso remoto.");
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
    tellAudioProgress(canceled ? undefined : error.message || "No se pudo descargar el modelo de audio.");
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
    message: "¿Desconectar WhatsApp?",
    detail: "Esta computadora deja de ser un dispositivo vinculado. Tus mensajes guardados se conservan y puedes volver a vincular con un QR.",
    buttons: ["Cancelar", "Desconectar"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await logoutWhatsApp();
}

async function disconnectGmail(email) {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: "¿Desconectar esta cuenta de Gmail?",
    detail: `${String(email)}\n\nSMCP borrará su contraseña guardada. Para cancelarla por completo, revócala también en tu cuenta de Google.`,
    buttons: ["Cancelar", "Desconectar"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await gmail.remove(String(email));
}

async function addVault() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Elige la carpeta de tus notas",
    buttonLabel: "Conectar",
    properties: ["openDirectory"],
  });
  if (!canceled && filePaths[0]) setVault(filePaths[0], true);
}

function toggleVault(path, enabled) {
  const known = lastState?.notes.vaults.some((vault) => vault.path === path);
  if (!known) throw new Error("Esa bóveda ya no está disponible.");
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
  if (!url) throw new Error("Enlace desconocido.");
  return shell.openExternal(url);
}

async function openTailscale() {
  const error = await shell.openPath(IS_MAC ? "/Applications/Tailscale.app" : "C:\\Program Files\\Tailscale\\tailscale-ipn.exe");
  if (error) throw new Error("No se pudo abrir Tailscale.");
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
  if (!url) throw new Error("Ajuste desconocido.");
  if (pane === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
  else if (pane === "screen") await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
  await shell.openExternal(url);
}

const TASK_TOOLS = {
  available: { name: "tasks_available" },
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

/** The only actions the MCP server can ask this app to perform. */
function startActionHelper() {
  const whenRunning = (fn) => (params) => {
    if (readPolicy().paused) throw new Error("SMCP está en pausa. Puedes reanudarlo desde la app.");
    return fn(params);
  };
  return startHelper({
    jxa: whenRunning(({ name, params, timeoutMs }) => localJxa(name, params, Math.min(Number(timeoutMs) || 30_000, 60_000))),
    screenshot: whenRunning(localScreenshot),
    confirm: whenRunning(({ body }) => localConfirm(String(body))),
    tasks: ({ op, args }) => {
      const tool = TASK_TOOLS[op];
      if (!tool) throw new Error("Operación desconocida.");
      return allowed(tool.name, tool.write ? SENDS : READS, () => runTask(op, args))();
    },
    gmailAccounts: allowed("gmail_list_accounts", READS, () => gmail.listAccounts()),
    gmailSearch: allowed("gmail_search", READS, (params) => gmail.search(params)),
    gmailRead: allowed("gmail_read", READS, (params) => gmail.read(params)),
    gmailSend: allowed("gmail_send", SENDS, (params) => gmail.send(params)),
  });
}

/** Contains no names, IPs, accounts, or message content, so it is safe to share. */
function copyDiagnostics() {
  const state = lastState;
  const isConnected = (id) => state?.clients.items.some((client) => client.id === id && client.connected);
  const lines = [
    `SMCP ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron}`,
    `Tailscale: ${state?.tailscale.installed ? (state.tailscale.running ? "conectado" : "instalado, sin conectar") : "sin instalar"}`,
    `Máquinas: ${state?.tailscale.machines.filter((machine) => machine.online).length ?? 0} de ${state?.tailscale.machines.length ?? 0} en línea`,
    `WhatsApp: ${state?.whatsapp.supported ? (state.whatsapp.linked ? "vinculado" : "sin vincular") : "no disponible"}`,
    `Claude Code: ${isConnected("claudeCode") ? "conectado" : "no"} · Claude Desktop: ${isConnected("claudeDesktop") ? "conectado" : "no"}`,
    `Pausa: ${state?.policy.paused ? "sí" : "no"} · Solo lectura: ${state?.policy.readOnly ? "sí" : "no"}`,
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
      win?.webContents.send("whatsapp-login", { state: error ? "error" : "done", error });
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
    title: "SMCP Tareas",
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
  // Closing the window leaves the app in the top bar. "Salir" is what ends it.
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
// The panel re-reads state when told it changed, so telling it on every read would loop forever.
const tellPanel = whenChanged(() => panel?.webContents.send("state-changed"));

function updateTray() {
  if (!tray) return;
  setTrayImage(trayLook());
  const online = lastState?.tailscale.machines.filter((machine) => machine.online).length ?? 0;
  setTrayToolTip(lastState?.policy.paused ? "SMCP: en pausa" : `SMCP: activo · ${online} en línea`);
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
  tray.on("double-click", showWindow);
  tray.on("right-click", () =>
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Abrir SMCP", click: showWindow },
        { type: "separator" },
        { label: "Salir", click: () => app.quit() },
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
});

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
  return { ...updater.state(), auto: settings.updates?.auto ?? null };
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
      message: "¿Quieres que SMCP se actualice automáticamente?",
      detail: IS_MAC
        ? "Cuando haya una versión nueva, SMCP la instalará y se reiniciará. Después de cada actualización, macOS volverá a pedir los permisos de la app. Puedes cambiarlo en Ajustes."
        : "Te avisaremos cuando haya una versión nueva. Puedes cambiarlo en Ajustes.",
      buttons: ["Actualizar automáticamente", "Preguntarme antes"],
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
  new Notification({ title: "Hay una versión nueva de SMCP", body: `Instala la versión ${snapshot.latest} desde Ajustes.` }).show();
}

async function noticeAfterUpdate() {
  const settings = await readSettings();
  const version = app.getVersion();
  if (settings.lastVersion === version) return;
  const updated = Boolean(settings.lastVersion);
  settings.lastVersion = version;
  await writeSettings(settings);
  if (updated && IS_MAC) {
    new Notification({ title: `SMCP se actualizó a ${version}`, body: "Revisa los permisos de macOS en Ajustes para que todo siga funcionando." }).show();
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
      return { ok: false, error: error.message };
    }
  });
}

function registerIpc() {
  handle("state", collectState);
  handle("open-terminal", openTerminal);
  handle("wake", wakeMachine);
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
    startUpdates();
    if (startedInBackground) app.dock?.hide();
    else showWindow();
  });
}
