// Publishes the current package.json version: builds, signs the update manifest and creates the GitHub release.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSignedManifest } from "../app/core/updater.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.SMCP_UPDATE_KEY_FILE ?? join(homedir(), ".smcp-release", "update-signing-key.pem");
const DRY_RUN = process.argv.includes("--dry-run");
const BUILD = join(homedir(), "Library", "Caches", "smcp-build");
const GH = process.env.GH ?? "gh";

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
/** electron-builder downloads Electron and its tools from GitHub, which sometimes answers 5xx; try again before failing the release. */
function runWithRetry(command, args, options = {}, delaysSeconds = [20, 60, 120]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return run(command, args, options);
    } catch (error) {
      if (attempt >= delaysSeconds.length) throw error;
      console.warn(`::warning::'${command} ${args.join(" ")}' failed; retrying in ${delaysSeconds[attempt]}s.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delaysSeconds[attempt] * 1000);
    }
  }
}
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const privateKey = createPrivateKey(readFileSync(KEY));

run("npm", ["test"]);
runWithRetry("npm", ["run", "dist:mac"], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
runWithRetry("npm", ["run", "dist:win"], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });

const out = join(BUILD, "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const zipName = `SMCP-${version}-mac-arm64.zip`;
const zip = join(out, zipName);
run("ditto", ["-c", "-k", "--keepParent", join(BUILD, "mac-arm64", "SMCP.app"), zip]);

const manifest = JSON.stringify(
  {
    version,
    mac: {
      arm64: {
        file: zipName,
        sha256: createHash("sha256").update(readFileSync(zip)).digest("hex"),
        size: statSync(zip).size,
      },
    },
  },
  null,
  2,
);
const manifestPath = join(out, "latest.json");
writeFileSync(manifestPath, manifest);
const signature = sign(null, Buffer.from(manifest), privateKey).toString("base64");
writeFileSync(`${manifestPath}.sig`, signature);

// Installed apps would reject anything this check rejects, so never publish it.
readSignedManifest(manifest, signature);

if (DRY_RUN) {
  console.log(`Dry run: SMCP ${version} built and signed. Nothing was published.`);
  process.exit(0);
}

run(GH, [
  "release",
  "create",
  `v${version}`,
  zip,
  manifestPath,
  `${manifestPath}.sig`,
  join(BUILD, `SMCP-${version}-arm64.dmg`),
  join(BUILD, `SMCP Setup ${version}.exe`),
  "--repo",
  "santiagomlr/smcp",
  "--title",
  `SMCP ${version}`,
  ...(process.env.GITHUB_SHA ? ["--target", process.env.GITHUB_SHA] : []),
  "--notes",
  "Download the .dmg for Apple Silicon Macs or the Setup .exe for Windows.",
]);
