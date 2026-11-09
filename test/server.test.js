import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "index.js");
const client = new Client({ name: "test", version: "1" });

before(() =>
  client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, WACLI_BIN: "/no/existe/wacli" },
    }),
  ),
);
after(() => client.close());

test("expone las herramientas esperadas por MCP", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "app_focus",
    "app_list",
    "file_list",
    "file_read",
    "file_search",
    "file_write",
    "gmail_list_accounts",
    "gmail_read",
    "gmail_search",
    "gmail_send",
    "notes_list_vaults",
    "notes_read",
    "notes_recent",
    "notes_search",
    "notes_write",
    "run_command",
    "screenshot",
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
    "whatsapp_list_chats",
    "whatsapp_read_messages",
    "whatsapp_search_contacts",
    "whatsapp_search_messages",
    "whatsapp_send",
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

test("rechaza un JID inválido antes de llamar a wacli", async () => {
  const result = await client.callTool({
    name: "whatsapp_read_messages",
    arguments: { chat: "--all" },
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /whatsapp:install/);
});
