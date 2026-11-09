import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Open model from the whisper.cpp project. It is free to use and is verified before it is kept. */
export const WHISPER_MODEL = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  bytes: 487_601_967,
  sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
};

/** The packaged app keeps it in Resources/bin and development in vendor/bin. Null if neither has it. */
export function whisperBin() {
  if (process.env.WHISPER_BIN) return process.env.WHISPER_BIN;
  for (const path of [join(PROJECT_ROOT, "..", "bin", "whisper-cli"), join(PROJECT_ROOT, "vendor", "bin", "whisper-cli")]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

export function modelPath() {
  return process.env.WHISPER_MODEL || join(homedir(), ".smcp", "whisper", "ggml-small.bin");
}

/** The download only reaches this path after its checksum passes, so existing means complete. */
export function modelReady(path = modelPath()) {
  return existsSync(path);
}
