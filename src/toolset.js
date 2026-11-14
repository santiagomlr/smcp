// Every tool SMCP has, registered in one place, so the local server, the remote connector and the
// server that answers the person's other computers can never drift apart.
import { registerAppleNotes } from "./tools/applenotes.js";
import { registerApprovals } from "./tools/approvals.js";
import { registerApps } from "./tools/apps.js";
import { registerAwake } from "./tools/awake.js";
import { registerBrain } from "./tools/brain.js";
import { registerBrief } from "./tools/brief.js";
import { registerCalendar } from "./tools/calendar.js";
import { registerClipboard } from "./tools/clipboard.js";
import { registerContext } from "./tools/context.js";
import { registerFiles } from "./tools/files.js";
import { registerGmail } from "./tools/gmail.js";
import { registerNightLight } from "./tools/nightlight.js";
import { registerNotes } from "./tools/notes.js";
import { registerPeople } from "./tools/people.js";
import { registerSecurity } from "./tools/security.js";
import { registerStatus } from "./tools/status.js";
import { registerTasks } from "./tools/tasks.js";
import { registerTerminal } from "./tools/terminal.js";
import { registerVpn } from "./tools/vpn.js";
import { registerWhatsApp } from "./tools/whatsapp.js";

/** `tools` is anything with registerTool(name, config, handler). `remote` only changes how status and context word things. */
export function registerAllTools(tools, { remote = false } = {}) {
  registerWhatsApp(tools);
  registerGmail(tools);
  registerNotes(tools);
  registerBrain(tools);
  registerTasks(tools);
  registerCalendar(tools);
  registerAppleNotes(tools);
  registerBrief(tools);
  registerPeople(tools);
  registerFiles(tools);
  registerClipboard(tools);
  registerTerminal(tools);
  registerApps(tools);
  registerSecurity(tools);
  registerNightLight(tools);
  registerVpn(tools);
  registerAwake(tools);
  registerApprovals(tools);
  registerStatus(tools, { remote });
  registerContext(tools, { remote });
}

/** The name of every tool, for checks that each one has a rule. */
export function allToolNames() {
  const names = [];
  registerAllTools({ registerTool: (name) => names.push(name) });
  return names;
}
