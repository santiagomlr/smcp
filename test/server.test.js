import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "index.js");
const client = new Client({ name: "test", version: "1" });
let dir;

// Its own settings and log, so the person's real ones neither decide nor record these calls.
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "smcp-server-"));
  await writeFile(join(dir, "config.json"), JSON.stringify({ disabled: { terminal: false } }));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...process.env,
        WACLI_BIN: "/no/existe/wacli",
        SMCP_CONFIG: join(dir, "config.json"),
        SMCP_AUDIT: join(dir, "audit.jsonl"),
        SMCP_SOCKET: join(dir, "none.sock"),
      },
    }),
  );
});
after(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test("expone las herramientas esperadas por MCP", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "app_focus",
    "app_list",
    "applenotes_read",
    "applenotes_recent",
    "applenotes_search",
    "awake_screen_off",
    "awake_start",
    "awake_status",
    "awake_stop",
    "calendar_auto_history",
    "calendar_create_event",
    "calendar_delete_event",
    "calendar_free_slots",
    "calendar_list_calendars",
    "calendar_list_events",
    "calendar_update_event",
    "clipboard_read",
    "clipboard_write",
    "daily_brief",
    "file_list",
    "file_read",
    "file_search",
    "file_write",
    "followups_list",
    "followups_to_tasks",
    "gmail_draft",
    "gmail_list_accounts",
    "gmail_read",
    "gmail_read_attachment",
    "gmail_reply",
    "gmail_search",
    "gmail_send",
    "nightlight_now",
    "nightlight_set",
    "nightlight_status",
    "notes_list_vaults",
    "notes_read",
    "notes_recent",
    "notes_search",
    "notes_semantic_search",
    "notes_write",
    "people_lookup",
    "reminders_complete",
    "reminders_create",
    "reminders_delete",
    "reminders_list",
    "reminders_list_lists",
    "reminders_update",
    "run_command",
    "screen_read_text",
    "screenshot",
    "security_check_persistence",
    "security_check_url",
    "security_delete_quarantined",
    "security_quarantine",
    "security_quarantine_list",
    "security_restore",
    "security_scan_file",
    "security_scan_folder",
    "smcp_context",
    "smcp_remember",
    "smcp_status",
    "tasks_append_note",
    "tasks_available",
    "tasks_claude_queue",
    "tasks_complete",
    "tasks_create",
    "tasks_forecast",
    "tasks_hygiene",
    "tasks_list_projects",
    "tasks_mark_reviewed",
    "tasks_review_list",
    "tasks_search",
    "tasks_update",
    "ui_click",
    "ui_key",
    "ui_read_tree",
    "ui_type",
    "vpn_connect",
    "vpn_disconnect",
    "vpn_status",
    "vpn_tailscale_dns",
    "whatsapp_chat_digest",
    "whatsapp_list_chats",
    "whatsapp_read_messages",
    "whatsapp_scan_file",
    "whatsapp_search_contacts",
    "whatsapp_search_messages",
    "whatsapp_search_transcripts",
    "whatsapp_send",
    "whatsapp_send_file",
    "whatsapp_status",
    "whatsapp_sync",
    "whatsapp_transcribe_audio",
    "window_list",
  ]);
  const send = tools.find((tool) => tool.name === "whatsapp_send");
  assert.equal(send.annotations.destructiveHint, true);
});

test("sin wacli instalado, el error dice qué hacer", async () => {
  const result = await client.callTool({ name: "whatsapp_status", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /whatsapp:install/);
});

test("una llamada real de punta a punta funciona", async () => {
  const result = await client.callTool({
    name: "run_command",
    arguments: { command: "echo punta-a-punta" },
  });
  assert.match(result.content[0].text, /punta-a-punta/);
});

test("cada llamada queda en el registro de actividad, sin sus argumentos", async () => {
  await client.callTool({ name: "run_command", arguments: { command: "echo secreto-del-registro" } });
  const log = await readFile(join(dir, "audit.jsonl"), "utf8");
  assert.ok(!log.includes("secreto-del-registro"));
  const last = JSON.parse(log.trim().split("\n").at(-1));
  assert.equal(last.tool, "run_command");
  assert.equal(last.outcome, "ok");
  assert.equal(last.source, "local");
  assert.equal(last.client, "test");
});

test("rechaza un JID inválido antes de llamar a wacli", async () => {
  const result = await client.callTool({
    name: "whatsapp_read_messages",
    arguments: { chat: "--all" },
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /whatsapp:install/);
});
