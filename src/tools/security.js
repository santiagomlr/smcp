import { z } from "zod";
import { checkPersistence } from "../security/persistence.js";
import { deleteQuarantined, listQuarantine, quarantineFile, restoreFile } from "../security/quarantine.js";
import { reaAnalyze, reaBin, REA_INSTALL_HINT } from "../security/rea.js";
import { scanPath, scanTree } from "../security/scanner.js";
import { checkUrl, extractUrls } from "../security/url.js";
import { errorResult, externalResult, textResult } from "../util.js";
import { isBlocked, resolveSafe } from "./files.js";

const handle = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (error) {
    return errorResult(error.message);
  }
};

const ADVICE = {
  malicious: "Do not open or run it. Offer to put it in quarantine with security_quarantine.",
  suspicious: "Treat it with care: do not open it until the person confirms where it came from. Quarantine is available.",
  clean: "No known threat found. This is not a guarantee that the file is safe.",
};

export async function scanFileTool({ path, deep = false }) {
  const file = await resolveSafe(path);
  const result = await scanPath(file);
  const deepReport = deep ? await reaAnalyze(file, result.kind) : undefined;
  // Findings describe the file, but names and strings inside it are still the file's own content.
  return externalResult({ ...result, advice: ADVICE[result.verdict], ...(deep ? { deep: deepReport } : {}) });
}

export async function scanFolderTool({ path = "~/Downloads", max_files = 2000, max_depth = 6 }) {
  const root = await resolveSafe(path);
  const report = await scanTree(root, { isBlocked, maxFiles: max_files, maxDepth: max_depth });
  return externalResult({
    ...report,
    advice: report.malicious || report.suspicious ? "Show the person what was found and offer quarantine for each file. Never delete without asking." : ADVICE.clean,
  });
}

export function checkUrlsTool({ urls = [], text = "" }) {
  const all = [...new Set([...urls, ...extractUrls(text)])].slice(0, 100);
  if (!all.length) throw new Error("Pass at least one link in urls, or text that contains links.");
  const results = all.map(checkUrl);
  const order = { dangerous: 0, suspicious: 1, looks_safe: 2, unknown: 3 };
  results.sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
  return textResult({
    checked: results.length,
    dangerous: results.filter((item) => item.verdict === "dangerous").length,
    suspicious: results.filter((item) => item.verdict === "suspicious").length,
    results,
  });
}

export async function quarantineTool({ path, reason = "" }) {
  const file = await resolveSafe(path);
  const scan = await scanPath(file).catch(() => null);
  const record = await quarantineFile(file, { reason, scan });
  return textResult({ quarantined: true, ...record, note: "The file can no longer be opened or run. security_restore puts it back." });
}

/** Facts for smcp_status: how many files are in quarantine and whether deep analysis is available. */
export async function securityProbe() {
  const items = await listQuarantine();
  return { quarantined: items.length, deepAnalysis: reaBin() ? "rea" : "not installed" };
}

export function registerSecurity(server) {
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "security_scan_file",
    {
      description:
        "Antivirus scan of one file without opening or running it: known threats by hash, behaviour rules (process injection, keyloggers, " +
        "download-and-run scripts, reverse shells, macros that run on open, ransom notes), disguised names and packed programs. " +
        "Returns clean, suspicious or malicious with the reasons. Scan files before the person opens something they downloaded or received. " +
        "deep: true adds a static reverse-engineering report from REA when it is installed.",
      inputSchema: {
        path: z.string().describe("Absolute path or one with ~/."),
        deep: z.boolean().default(false).describe("Also analyse the binary with REA, if installed."),
      },
      annotations: readOnly,
    },
    handle(scanFileTool),
  );

  server.registerTool(
    "security_scan_folder",
    {
      description:
        "Antivirus scan of a folder and its subfolders, by default ~/Downloads. Only files that look suspicious or malicious are listed. " +
        "Credential stores are skipped. Good for a scheduled routine.",
      inputSchema: {
        path: z.string().default("~/Downloads"),
        max_files: z.number().int().min(1).max(20_000).default(2000),
        max_depth: z.number().int().min(0).max(20).default(6),
      },
      annotations: readOnly,
    },
    handle(scanFolderTool),
  );

  server.registerTool(
    "security_check_url",
    {
      description:
        "Checks links for phishing offline, without visiting them: look-alike and misspelled brand names (banks, Apple, PayPal, SAT...), " +
        "hidden destinations, bare IP addresses, risky domains and direct program downloads. Pass links, or the text of an email or message to check every link in it.",
      inputSchema: {
        urls: z.array(z.string().max(4000)).max(100).default([]),
        text: z.string().max(200_000).default("").describe("Text to pull links from, such as an email body."),
      },
      annotations: readOnly,
    },
    handle(checkUrlsTool),
  );

  server.registerTool(
    "security_check_persistence",
    {
      description:
        "Lists what starts on its own with the computer (macOS launch agents and daemons, Windows Run keys and Startup folder, Linux autostart, " +
        "systemd user units and cron), scans the programs they start and flags the ones that look like malware hiding there. It changes nothing.",
      annotations: readOnly,
    },
    handle(async () => externalResult(await checkPersistence())),
  );

  server.registerTool(
    "security_quarantine",
    {
      description:
        "Moves a dangerous file into SMCP's quarantine, where it cannot be opened or run. It can be put back with security_restore. " +
        "Ask the person before quarantining a file they did not ask about.",
      inputSchema: {
        path: z.string(),
        reason: z.string().max(500).default(""),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    handle(quarantineTool),
  );

  server.registerTool(
    "security_quarantine_list",
    {
      description: "Lists the files in quarantine, with where they came from and why they were moved.",
      annotations: readOnly,
    },
    handle(async () => externalResult({ items: await listQuarantine(), ...(reaBin() ? {} : { deepAnalysis: REA_INSTALL_HINT }) })),
  );

  server.registerTool(
    "security_restore",
    {
      description: "Puts a quarantined file back where it was. Only do this when the person asks for it.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    handle(async ({ id }) => textResult(await restoreFile(id))),
  );

  server.registerTool(
    "security_delete_quarantined",
    {
      description: "Deletes a quarantined file for good. Only do this when the person asks for it.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    handle(async ({ id }) => textResult(await deleteQuarantined(id))),
  );
}
