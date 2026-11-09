// Looks for new versions on GitHub and installs them. Only a manifest signed with the release key is trusted.
import { execFile, spawn } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { coalesce } from "./throttle.js";

const REPO = "santiagomlr/smcp";
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;
const MANIFEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const RETRY_DELAYS_MS = [2_000, 5_000];

/** 5xx and 429 come from GitHub being busy, not from a missing or bad release, so they are worth another try. */
export function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAEh47zB+6DGcWhZnY4dSmeGXZi+zdLLsC/7F8ZHlBKDA=
-----END PUBLIC KEY-----`;

const VERSION = /^\d+\.\d+\.\d+$/;
const MAC_FILE = /^SMCP-\d+\.\d+\.\d+-mac-arm64\.zip$/;

export function isNewer(candidate, current) {
  if (!VERSION.test(candidate) || !VERSION.test(current)) return false;
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Returns the manifest only if the signature matches its exact bytes; anything else throws. */
export function readSignedManifest(text, signature, publicKey = UPDATE_PUBLIC_KEY) {
  const valid = verifySignature(null, Buffer.from(text), createPublicKey(publicKey), Buffer.from(signature.trim(), "base64"));
  if (!valid) throw new Error("The update signature is not valid.");
  const manifest = JSON.parse(text);
  const mac = manifest?.mac?.arm64;
  if (!VERSION.test(manifest?.version ?? "")) throw new Error("The update does not state a valid version.");
  if (mac && (!MAC_FILE.test(mac.file ?? "") || !/^[0-9a-f]{64}$/.test(mac.sha256 ?? "") || !Number.isInteger(mac.size) || mac.size <= 0)) {
    throw new Error("The Mac update is incomplete.");
  }
  return manifest;
}

/** Waits for the app to exit, swaps the bundle, and restores the old one if the copy fails. */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; fresh="$2"; target="$3"; mode="$4"; work="$5"
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.2; i=$((i + 1)); done
if kill -0 "$pid" 2>/dev/null; then rm -rf "$work"; exit 1; fi
backup="$target.previous-$$"
if mv "$target" "$backup"; then
  if ditto "$fresh" "$target"; then rm -rf "$backup"; else rm -rf "$target"; mv "$backup" "$target"; fi
fi
if [ "$mode" = background ]; then open -g -a "$target" --args --background; else open -a "$target"; fi
rm -rf "$work"
`;

const execFileAsync = promisify(execFile);

export function createUpdater({
  currentVersion,
  platform,
  arch,
  appBundle,
  tempRoot,
  bundleId,
  quit,
  onChange = () => {},
  fetchImpl = fetch,
  run = (command, args) => execFileAsync(command, args),
  startSwap = (script, args) => spawn("/bin/sh", [script, ...args], { detached: true, stdio: "ignore" }).unref(),
  publicKey = UPDATE_PUBLIC_KEY,
  pid = process.pid,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const macBuild = platform === "darwin" && arch === "arm64";
  let snapshot = { current: currentVersion, status: "idle", latest: null, message: "", canInstall: false, progress: null };
  let manifest = null;

  function set(patch) {
    snapshot = { ...snapshot, ...patch };
    onChange(snapshot);
  }

  async function fetchText(url) {
    for (let attempt = 0; ; attempt++) {
      let transient;
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
        if (response.ok) return await response.text();
        transient = isTransientStatus(response.status);
        if (!transient || attempt >= RETRY_DELAYS_MS.length) {
          throw new Error(transient ? `GitHub is not responding right now (${response.status}). Try again in a few minutes.` : `GitHub responded ${response.status}.`);
        }
      } catch (error) {
        // A network failure or timeout is also transient; an HTTP error built above is final.
        if (transient !== undefined || attempt >= RETRY_DELAYS_MS.length) throw error;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  const check = coalesce(async () => {
    if (snapshot.status === "installing") return snapshot;
    set({ status: "checking", message: "" });
    try {
      const [text, signature] = await Promise.all([fetchText(MANIFEST_URL), fetchText(`${MANIFEST_URL}.sig`)]);
      manifest = readSignedManifest(text, signature, publicKey);
      if (!isNewer(manifest.version, currentVersion)) {
        set({ status: "latest", latest: manifest.version, canInstall: false });
      } else {
        set({ status: "available", latest: manifest.version, canInstall: macBuild && Boolean(manifest.mac?.arm64) });
      }
    } catch (error) {
      set({ status: "error", message: `Could not check: ${error.message}`, canInstall: false });
    }
    return snapshot;
  });

  async function download(url, path, expected) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GitHub responded ${response.status}.`);
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > expected.size) return done(new Error("The download is larger than expected."));
        hash.update(chunk);
        const progress = Math.floor((received / expected.size) * 100);
        if (progress !== snapshot.progress) set({ progress });
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(path, { mode: 0o600 }));
    if (received !== expected.size || hash.digest("hex") !== expected.sha256) {
      throw new Error("The download does not match the signed version.");
    }
  }

  async function verifyBundle(bundle, version) {
    const plist = join(bundle, "Contents", "Info.plist");
    const read = async (key) => (await run("plutil", ["-extract", key, "raw", plist])).stdout.trim();
    if ((await read("CFBundleIdentifier")) !== bundleId) throw new Error("The downloaded package is not SMCP.");
    if ((await read("CFBundleShortVersionString")) !== version) throw new Error("The downloaded package is a different version.");
    await run("codesign", ["--verify", "--deep", bundle]);
  }

  /** Downloads, verifies and hands over to a script that replaces the app once it has quit. */
  async function install({ background = false } = {}) {
    if (snapshot.status !== "available" || !snapshot.canInstall) return snapshot;
    let work = null;
    try {
      if (!appBundle?.endsWith(".app")) throw new Error("Only the installed app can be updated.");
      await access(dirname(appBundle), constants.W_OK);
      const build = manifest.mac.arm64;
      set({ status: "installing", message: "Downloading…", progress: 0 });
      work = await mkdtemp(join(tempRoot, "smcp-update-"));
      const zip = join(work, build.file);
      await download(`https://github.com/${REPO}/releases/download/v${manifest.version}/${build.file}`, zip, build);
      set({ message: "Verifying…", progress: null });
      const extracted = join(work, "extracted");
      await run("ditto", ["-x", "-k", zip, extracted]);
      const fresh = join(extracted, "SMCP.app");
      await verifyBundle(fresh, manifest.version);
      const script = join(work, "swap.sh");
      await writeFile(script, SWAP_SCRIPT, { mode: 0o700 });
      await chmod(script, 0o700);
      set({ message: "Restarting…" });
      startSwap(script, [String(pid), fresh, appBundle, background ? "background" : "foreground", work]);
      quit();
    } catch (error) {
      if (work) await rm(work, { recursive: true, force: true });
      set({ status: "error", message: `Could not update: ${error.message}`, canInstall: false, progress: null });
    }
    return snapshot;
  }

  return { check, install, state: () => snapshot };
}
