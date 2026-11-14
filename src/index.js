#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildInstructions } from "./context.js";
import { guarded } from "./policy.js";
import { createRouter } from "./server-route.js";
import { registerAllTools } from "./toolset.js";
import { registerPrompts } from "./tools/context.js";

const server = new McpServer(
  { name: "smcp", version: "0.2.0" },
  {
    // Built when the client connects, with the current time, switches and the person's own notes.
    instructions: buildInstructions(),
  },
);

// The router sends a tool to the person's server computer when they chose that, call by call.
registerAllTools(guarded(server, { router: createRouter() }));
registerPrompts(server);

await server.connect(new StdioServerTransport());
