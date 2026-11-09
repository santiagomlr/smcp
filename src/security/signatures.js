// Detection rules for the local antivirus. They describe what known threats look like so SMCP can
// recognise them; they contain no working malicious code. Weights add up to a score per file.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Known-bad SHA-256 hashes that ship with SMCP. The EICAR test file lets anyone check the scanner works. */
export const BUILTIN_HASHES = new Map([
  ["275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f", "EICAR-Test-File (not a virus, the standard antivirus test)"],
]);

// Split so this source file is not itself detected by other antivirus products.
const EICAR_MARKER = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!"].join("");

/**
 * Content rules. `all` lists patterns that must every one appear; `any` needs one of them.
 * `kinds` limits a rule to some file kinds (see fileKind in scanner.js); without it, it applies to all.
 */
export const RULES = [
  {
    id: "eicar.test",
    title: "EICAR antivirus test file",
    severity: "malicious",
    weight: 100,
    any: [EICAR_MARKER],
  },

  // Windows executables: combinations of imports that real malware relies on.
  {
    id: "pe.process_injection",
    title: "Writes code into other processes (process injection)",
    severity: "high",
    weight: 45,
    kinds: ["pe"],
    all: ["VirtualAllocEx", "WriteProcessMemory", "CreateRemoteThread"],
  },
  {
    id: "pe.process_hollowing",
    title: "Replaces the code of another process (process hollowing)",
    severity: "high",
    weight: 45,
    kinds: ["pe"],
    all: ["NtUnmapViewOfSection", "SetThreadContext", "ResumeThread"],
  },
  {
    id: "pe.keylogger",
    title: "Reads every key you press (keylogger behaviour)",
    severity: "high",
    weight: 35,
    kinds: ["pe"],
    all: ["SetWindowsHookEx", "GetAsyncKeyState"],
  },
  {
    id: "pe.credential_theft",
    title: "Reads saved browser passwords",
    severity: "high",
    weight: 35,
    kinds: ["pe", "macho", "elf", "script"],
    all: ["Login Data", "CryptUnprotectData"],
  },
  {
    id: "pe.shadow_copy_delete",
    title: "Deletes Windows backups (typical of ransomware)",
    severity: "high",
    weight: 50,
    any: ["vssadmin delete shadows", "vssadmin.exe delete shadows", "wmic shadowcopy delete", "wbadmin delete catalog"],
  },
  {
    id: "pe.anti_analysis",
    title: "Checks whether it is being watched by a debugger",
    severity: "low",
    weight: 8,
    kinds: ["pe"],
    any: ["IsDebuggerPresent", "CheckRemoteDebuggerPresent"],
  },

  // Scripts: download-and-run chains and hidden commands.
  {
    id: "script.powershell_encoded",
    title: "Runs a hidden, encoded PowerShell command",
    severity: "high",
    weight: 40,
    any: [/powershell(\.exe)?[^\n]{0,80}\s-(e|en|enc|enco|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i],
  },
  {
    id: "script.powershell_cradle",
    title: "Downloads code from the internet and runs it in memory",
    severity: "high",
    weight: 45,
    any: [
      /\b(iex|invoke-expression)\b[^\n]{0,120}(downloadstring|downloaddata|invoke-webrequest|\biwr\b|net\.webclient)/i,
      /(downloadstring|net\.webclient)[^\n]{0,200}\|\s*(iex|invoke-expression)\b/i,
    ],
  },
  {
    id: "script.powershell_hidden",
    title: "Starts PowerShell hidden and without its safety policy",
    severity: "medium",
    weight: 20,
    all: [/-w(indowstyle)?\s+hidden/i, /-(ep|executionpolicy)\s+bypass/i],
  },
  {
    id: "script.reverse_shell",
    title: "Opens a remote shell to another computer (reverse shell)",
    severity: "high",
    weight: 50,
    any: [
      /\/dev\/tcp\/[\w.-]+\/\d+/,
      /\bnc(at)?\b[^\n]{0,40}\s-e\s+\/bin\/(ba|z)?sh/,
      /socket\.socket\([^\n]{0,200}\.connect\([^\n]{0,200}(subprocess|pty\.spawn|os\.dup2)/s,
    ],
  },
  {
    id: "script.download_and_execute",
    title: "Downloads a script and runs it straight away",
    severity: "medium",
    weight: 25,
    any: [/\b(curl|wget)\b[^\n|]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b/, /\b(curl|wget)\b[^\n|]{0,200}\|\s*python3?\b/],
  },
  {
    id: "script.base64_exec",
    title: "Decodes hidden text and runs it as a command",
    severity: "medium",
    weight: 25,
    any: [/base64\s+(-d|--decode|-D)[^\n]{0,40}\|\s*(ba|z)?sh\b/, /eval\s*\(\s*(atob|base64_decode|Buffer\.from)\s*\(/i],
  },
  {
    id: "script.mac_quarantine_removal",
    title: "Removes the macOS download warning from files",
    severity: "medium",
    weight: 25,
    any: [/xattr\s+(-[a-z]*d[a-z]*|-c)[^\n]{0,40}com\.apple\.quarantine/i, /xattr\s+-(c|cr|rc)\s/],
  },
  {
    id: "script.mac_fake_password_prompt",
    title: "Shows a fake password window to capture your password",
    severity: "high",
    weight: 40,
    all: [/osascript/i, /with hidden answer/i],
  },
  {
    id: "script.mac_keychain_dump",
    title: "Copies passwords out of the macOS keychain",
    severity: "high",
    weight: 40,
    any: [/security\s+(dump-keychain|find-generic-password\s+[^\n]*-w)/i, /chainbreaker/i],
  },
  {
    id: "script.persistence_install",
    title: "Installs itself to start every time the computer starts",
    severity: "medium",
    weight: 20,
    any: [
      /launchctl\s+(load|bootstrap)/i,
      /Library\/Launch(Agents|Daemons)\//,
      /CurrentVersion\\Run(Once)?\b/i,
      /schtasks(\.exe)?\s+\/create/i,
      /\(crontab\s+-l[^\n]{0,80}\)\s*\|\s*crontab/,
    ],
  },
  {
    id: "script.wscript_shell",
    title: "Script that runs programs through Windows Script Host",
    severity: "medium",
    weight: 20,
    kinds: ["script", "office", "html"],
    any: [/WScript\.Shell/i, /Shell\.Application/i],
  },
  {
    id: "script.miner",
    title: "Cryptocurrency miner",
    severity: "high",
    weight: 40,
    any: [/stratum\+tcp:\/\//i, /\bxmrig\b/i, /coinhive/i],
  },
  {
    id: "text.ransom_note",
    title: "Ransom note: says your files were encrypted",
    severity: "high",
    weight: 35,
    kinds: ["text", "html"],
    all: [/(your|all)\s+(important\s+)?files\s+(have\s+been|are|were)\s+encrypted/i, /(bitcoin|btc|monero|decrypt)/i],
  },

  // Documents.
  {
    id: "office.auto_macro",
    title: "Office document with a macro that runs as soon as it opens",
    severity: "high",
    weight: 40,
    kinds: ["office", "ole"],
    all: [/vba/i, /(AutoOpen|Auto_Open|Document_Open|Workbook_Open|AutoExec)/],
  },
  {
    id: "office.macro_shell",
    title: "Office macro that starts other programs",
    severity: "high",
    weight: 40,
    kinds: ["office", "ole"],
    all: [/vba/i, /(Shell\s*\(|CreateObject|URLDownloadToFile|WScript)/i],
  },
  {
    id: "pdf.auto_action",
    title: "PDF that runs JavaScript or opens something when you open it",
    severity: "medium",
    weight: 25,
    kinds: ["pdf"],
    all: [/\/(OpenAction|AA)\b/, /\/(JavaScript|JS|Launch)\b/],
  },
  {
    id: "pdf.launch",
    title: "PDF that tries to start a program",
    severity: "high",
    weight: 35,
    kinds: ["pdf"],
    any: [/\/Launch\b[^\n]{0,200}\/(F|Win)\b/s],
  },
  {
    id: "html.credential_form_offline",
    title: "Saved web page that asks for a password and sends it elsewhere",
    severity: "medium",
    weight: 30,
    kinds: ["html"],
    all: [/type\s*=\s*["']?password/i, /(action\s*=\s*["']?https?:\/\/|fetch\s*\(\s*["']https?:\/\/|XMLHttpRequest)/i],
  },
];

/** Signatures a person adds themselves: ~/.smcp/security/signatures.json with {"hashes": {"<sha256>": "name"}}. */
export function userSignaturesPath() {
  return process.env.SMCP_SIGNATURES || join(homedir(), ".smcp", "security", "signatures.json");
}

export function loadHashes(path = userSignaturesPath()) {
  const hashes = new Map(BUILTIN_HASHES);
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const [hash, name] of Object.entries(saved?.hashes ?? {})) {
      if (/^[0-9a-f]{64}$/i.test(hash)) hashes.set(hash.toLowerCase(), String(name).slice(0, 200));
    }
  } catch {
    // No file or a damaged one: the built-in list still applies.
  }
  return hashes;
}
