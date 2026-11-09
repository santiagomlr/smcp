// Lists what starts by itself with the computer, the place malware hides to survive a restart, and
// flags the entries that look wrong. It only reads: removing an entry is left to the person.

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { run } from "../util.js";
import { scanPath } from "./scanner.js";

const RISKY_PLACES = [/^\/tmp\//, /^\/private\/tmp\//, /^\/var\/tmp\//, /^\/Users\/Shared\//, /\/Downloads\//, /\/\.[^/]+\//, /\\AppData\\Local\\Temp\\/i, /\\Users\\Public\\/i];
const SHELL_TRICKS = /(curl|wget|base64|python3?\s+-c|osascript\s+-e|bash\s+-c|sh\s+-c|powershell|mshta|rundll32|regsvr32)/i;

/** Reads a launchd property list. plutil handles binary plists on a Mac; XML is read directly elsewhere. */
async function readPlist(file, exec = run) {
  if (platform() === "darwin") {
    const { code, stdout } = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { timeoutMs: 10_000 });
    if (code === 0) {
      try {
        return JSON.parse(stdout);
      } catch {
        // Fall through to the XML reader.
      }
    }
  }
  const xml = await readFile(file, "utf8");
  const value = (key) => xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
  const flag = (key) => new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(xml);
  const array = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  return {
    Label: value("Label"),
    Program: value("Program"),
    ProgramArguments: array ? [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]) : undefined,
    RunAtLoad: flag("RunAtLoad"),
    KeepAlive: flag("KeepAlive"),
  };
}

/** Why one start-up entry looks wrong, with a scan of the program it starts when that file exists. */
export async function assessEntry(entry, { scan = scanPath } = {}) {
  const reasons = [];
  const program = entry.program ?? "";
  const command = entry.command ?? program;
  if (RISKY_PLACES.some((pattern) => pattern.test(program))) reasons.push("Starts a program from a temporary, shared or hidden folder.");
  if (SHELL_TRICKS.test(command)) reasons.push("Starts a shell command that downloads or decodes something.");
  if (entry.label && program && /^[a-z0-9]{12,}$/i.test(entry.label.split(".").at(-1) ?? "")) reasons.push("Its name looks randomly generated.");
  if (program && !existsSync(program) && program.startsWith("/")) reasons.push("The program it starts no longer exists.");
  let scanResult;
  if (program && existsSync(program)) {
    try {
      const info = await stat(program);
      if (info.isFile()) {
        const { verdict, score, findings, sha256 } = await scan(program);
        scanResult = { verdict, score, sha256, findings };
        if (verdict !== "clean") reasons.push(`The program it starts was rated ${verdict}.`);
      }
    } catch {
      // Unreadable programs are reported without a scan.
    }
  }
  return { ...entry, flagged: reasons.length > 0, reasons, ...(scanResult ? { scan: scanResult } : {}) };
}

async function macEntries(exec) {
  const home = homedir();
  const places = [
    { dir: join(home, "Library", "LaunchAgents"), scope: "user" },
    { dir: "/Library/LaunchAgents", scope: "all users" },
    { dir: "/Library/LaunchDaemons", scope: "system" },
  ];
  const entries = [];
  for (const { dir, scope } of places) {
    const names = await readdir(dir).catch(() => []);
    for (const name of names.filter((item) => item.endsWith(".plist"))) {
      const file = join(dir, name);
      try {
        const plist = await readPlist(file, exec);
        const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
        const info = await stat(file);
        entries.push({
          kind: "launchd",
          scope,
          file,
          label: plist.Label ?? name,
          program: plist.Program ?? args[0],
          command: [plist.Program, ...args].filter(Boolean).join(" ").slice(0, 500),
          runsAtLoad: plist.RunAtLoad === true,
          keepAlive: Boolean(plist.KeepAlive),
          added: info.mtime,
        });
      } catch (error) {
        entries.push({ kind: "launchd", scope, file, label: name, error: error.message });
      }
    }
  }
  return entries;
}

async function linuxEntries(exec) {
  const home = homedir();
  const entries = [];
  const autostart = join(home, ".config", "autostart");
  for (const name of (await readdir(autostart).catch(() => [])).filter((item) => item.endsWith(".desktop"))) {
    const file = join(autostart, name);
    const text = await readFile(file, "utf8").catch(() => "");
    const command = text.match(/^Exec=(.*)$/m)?.[1] ?? "";
    entries.push({ kind: "autostart", scope: "user", file, label: name, program: command.split(/\s+/)[0], command: command.slice(0, 500) });
  }
  const units = join(home, ".config", "systemd", "user");
  for (const name of (await readdir(units).catch(() => [])).filter((item) => item.endsWith(".service"))) {
    const file = join(units, name);
    const text = await readFile(file, "utf8").catch(() => "");
    const command = text.match(/^ExecStart=(.*)$/m)?.[1] ?? "";
    entries.push({ kind: "systemd-user", scope: "user", file, label: name, program: command.replace(/^[-@+!:]+/, "").split(/\s+/)[0], command: command.slice(0, 500) });
  }
  const cron = await exec("crontab", ["-l"], { timeoutMs: 10_000 });
  if (cron.code === 0) {
    for (const line of cron.stdout.split("\n").map((item) => item.trim()).filter((item) => item && !item.startsWith("#"))) {
      const command = line.startsWith("@") ? line.split(/\s+/).slice(1).join(" ") : line.split(/\s+/).slice(5).join(" ");
      entries.push({ kind: "cron", scope: "user", label: line.slice(0, 80), program: command.split(/\s+/)[0], command: command.slice(0, 500) });
    }
  }
  return entries;
}

async function windowsEntries(exec) {
  const entries = [];
  const keys = [
    ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "user"],
    ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "user"],
    ["HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "all users"],
    ["HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "all users"],
  ];
  for (const [key, scope] of keys) {
    const { code, stdout } = await exec("reg", ["query", key], { timeoutMs: 10_000 });
    if (code !== 0) continue;
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
      if (!match) continue;
      const command = match[2].trim();
      const program = command.startsWith('"') ? command.slice(1, command.indexOf('"', 1)) : command.split(/\s+/)[0];
      entries.push({ kind: "registry-run", scope, file: key, label: match[1], program, command: command.slice(0, 500) });
    }
  }
  const startup = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  for (const name of await readdir(startup).catch(() => [])) {
    if (name === "desktop.ini") continue;
    entries.push({ kind: "startup-folder", scope: "user", file: join(startup, name), label: name, program: join(startup, name) });
  }
  return entries;
}

export async function checkPersistence({ exec = run, os = platform(), scan = scanPath } = {}) {
  const raw = os === "darwin" ? await macEntries(exec) : os === "win32" ? await windowsEntries(exec) : await linuxEntries(exec);
  const entries = await Promise.all(raw.map((entry) => (entry.error ? entry : assessEntry(entry, { scan }))));
  const flagged = entries.filter((entry) => entry.flagged);
  return {
    platform: os,
    total: entries.length,
    flagged: flagged.length,
    entries: [...flagged, ...entries.filter((entry) => !entry.flagged)],
    note: "SMCP only reports these. To remove one, the person should confirm it is unwanted first.",
  };
}
