#!/usr/bin/env node
// Links WhatsApp by showing wacli's QR code in this terminal.
import { spawnSync } from "node:child_process";
import { storeDir, wacliBin } from "./tools/whatsapp.js";

const result = spawnSync(wacliBin(), [`--store=${storeDir()}`, "auth"], { stdio: "inherit" });
if (result.error?.code === "ENOENT") {
  console.error("wacli no está instalado. Corre: npm run whatsapp:install");
  process.exit(1);
}
process.exit(result.status ?? 1);
