import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../../src/util.js";

export const SERVER_NAME = "smcp";

export function clientPaths(home = homedir()) {
  return {
    claudeCode: join(home, ".claude.json"),
    claudeDesktop: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  };
}

/** AI apps SMCP can register itself in. `key` is the setting that holds MCP servers in each file. */
export function clientCatalog(home = homedir()) {
  const paths = clientPaths(home);
  return [
    { id: "claudeDesktop", name: "Claude Desktop", app: "/Applications/Claude.app", path: paths.claudeDesktop, key: "mcpServers" },
    { id: "claudeCode", name: "Claude Code", path: paths.claudeCode, key: "mcpServers", cli: true },
    { id: "cursor", name: "Cursor", app: "/Applications/Cursor.app", path: join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    {
      id: "vscode",
      name: "VS Code",
      app: "/Applications/Visual Studio Code.app",
      path: join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
      key: "servers",
      extra: { type: "stdio" },
    },
    { id: "antigravity", name: "Antigravity", app: "/Applications/Antigravity.app", path: join(home, ".gemini", "antigravity", "mcp_config.json"), key: "mcpServers" },
  ];
}

/** Runs the MCP server with the app's own runtime, so no separate Node install is needed. */
export function serverEntry({ execPath, script, wacliBin }) {
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  if (wacliBin) env.WACLI_BIN = wacliBin;
  return { command: execPath, args: [script], env };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read ${path}: ${error.message}`);
  }
}

export async function isRegistered(path, key = "mcpServers") {
  try {
    return Boolean((await readJson(path))?.[key]?.[SERVER_NAME]);
  } catch {
    return false;
  }
}

/** Keeps a one-time backup, then replaces the file atomically so a crash cannot truncate it. */
async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await copyFile(path, `${path}.smcp.bak`).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const temp = `${path}.smcp.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function addToDesktop(path, entry, key = "mcpServers") {
  const config = (await readJson(path)) ?? {};
  config[key] = { ...config[key], [SERVER_NAME]: entry };
  await writeConfig(path, config);
}

export async function removeFromDesktop(path, key = "mcpServers") {
  const config = await readJson(path);
  if (!config?.[key]?.[SERVER_NAME]) return;
  delete config[key][SERVER_NAME];
  await writeConfig(path, config);
}

/** Apps opened from Finder get a minimal PATH, so ask a login shell where the CLI lives. */
async function findClaudeCli() {
  const result = await run("/bin/zsh", ["-lc", "command -v claude"], { timeoutMs: 10_000 });
  const path = result.stdout.trim().split("\n").at(-1);
  if (result.code !== 0 || !path?.startsWith("/")) {
    throw new Error("Claude Code was not found on this computer.");
  }
  return path;
}

export async function addToClaudeCode(entry) {
  const cli = await findClaudeCli();
  await run(cli, ["mcp", "remove", SERVER_NAME, "-s", "user"], { timeoutMs: 20_000 });
  const envArgs = Object.entries(entry.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const result = await run(
    cli,
    ["mcp", "add", SERVER_NAME, "--scope", "user", ...envArgs, "--", entry.command, ...entry.args],
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 500));
}

export async function removeFromClaudeCode() {
  const cli = await findClaudeCli();
  const result = await run(cli, ["mcp", "remove", SERVER_NAME, "-s", "user"], { timeoutMs: 20_000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 500));
}
