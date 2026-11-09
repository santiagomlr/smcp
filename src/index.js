#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildInstructions } from "./context.js";
import { guarded } from "./policy.js";
import { registerAppleNotes } from "./tools/applenotes.js";
import { registerApps } from "./tools/apps.js";
import { registerBrief } from "./tools/brief.js";
import { registerCalendar } from "./tools/calendar.js";
import { registerClipboard } from "./tools/clipboard.js";
import { registerContext, registerPrompts } from "./tools/context.js";
import { registerFiles } from "./tools/files.js";
import { registerGmail } from "./tools/gmail.js";
import { registerNightLight } from "./tools/nightlight.js";
import { registerNotes } from "./tools/notes.js";
import { registerSecurity } from "./tools/security.js";
import { registerStatus } from "./tools/status.js";
import { registerTasks } from "./tools/tasks.js";
import { registerTerminal } from "./tools/terminal.js";
import { registerVpn } from "./tools/vpn.js";
import { registerWhatsApp } from "./tools/whatsapp.js";

const server = new McpServer(
  { name: "smcp", version: "0.1.0" },
  {
    // Built when the client connects, with the current time, switches and the person's own notes.
    instructions: buildInstructions(),
  },
);

const tools = guarded(server);
registerWhatsApp(tools);
registerGmail(tools);
registerNotes(tools);
registerTasks(tools);
registerCalendar(tools);
registerAppleNotes(tools);
registerBrief(tools);
registerFiles(tools);
registerClipboard(tools);
registerTerminal(tools);
registerApps(tools);
registerSecurity(tools);
registerNightLight(tools);
registerVpn(tools);
registerStatus(tools);
registerContext(tools);
registerPrompts(server);

await server.connect(new StdioServerTransport());
