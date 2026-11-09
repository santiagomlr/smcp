import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { modelPath, whisperBin, WHISPER_MODEL } from "../../src/whisper.js";
import { run } from "../../src/util.js";

let oggSupport;

/** Older macOS versions cannot decode WhatsApp's audio format, so the option is not offered there. */
function decodesOgg() {
  oggSupport ??= run("/usr/bin/afconvert", ["-hf"], { timeoutMs: 10_000 }).then((result) => /'Oggf'/.test(result.stdout + result.stderr));
  return oggSupport;
}

export async function audioSupported() {
  return process.platform === "darwin" && Boolean(whisperBin()) && (await decodesOgg());
}

/** Calls onProgress only when the whole percentage changes. A failed or canceled download leaves nothing behind. */
export async function downloadModel({ url = WHISPER_MODEL.url, bytes = WHISPER_MODEL.bytes, sha256 = WHISPER_MODEL.sha256, path = modelPath(), signal, onProgress }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.part`;
  const hash = createHash("sha256");
  let received = 0;
  let shown = -1;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      const percent = Math.min(99, Math.floor((received * 100) / bytes));
      if (percent !== shown) {
        shown = percent;
        onProgress?.(percent);
      }
      done(null, chunk);
    },
  });
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`No se pudo descargar el modelo de audio (error ${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { mode: 0o600 }), { signal });
    if (hash.digest("hex") !== sha256) throw new Error("El modelo de audio llegó dañado. Vuelve a intentarlo.");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
