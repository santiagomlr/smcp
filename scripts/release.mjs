// Publishes the current package.json version: builds, signs the update manifest and creates the GitHub release.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSignedManifest } from "../app/core/updater.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.SMCP_UPDATE_KEY_FILE ?? join(homedir(), ".smcp-release", "update-signing-key.pem");
const DRY_RUN = process.argv.includes("--dry-run");
const BUILD = join(homedir(), "Library", "Caches", "smcp-build");
const GH = process.env.GH ?? "gh";
const APP = join(BUILD, "mac-arm64", "SMCP.app");
// macOS ties Accessibility and Screen Recording to the certificate that signs SMCP. Signing every release with
// the same one keeps those permissions on after each update. scripts/create-mac-signing-cert.sh makes it.
const MAC_IDENTITY = process.env.SMCP_MAC_SIGN_IDENTITY ?? "SMCP Code Signing";

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

/** Fails before the long build if the certificate is not in a keychain and trusted for code signing. */
function checkMacIdentity() {
  const found = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if (!found.includes(`"${MAC_IDENTITY}"`)) {
    throw new Error(
      `No valid signing certificate named "${MAC_IDENTITY}". Run scripts/create-mac-signing-cert.sh once on your Mac ` +
        "(in CI, set the SMCP_MAC_CERT_P12 and SMCP_MAC_CERT_PASSWORD secrets).",
    );
  }
}

/** electron-builder only warns when it cannot sign, so check the app really carries the certificate. */
function checkMacSignature() {
  run("codesign", ["--verify", "--deep", "--strict", APP]);
  const details = spawnSync("codesign", ["-dvv", APP], { encoding: "utf8" });
  if (!`${details.stdout}${details.stderr}`.includes(`Authority=${MAC_IDENTITY}`)) {
    throw new Error(`The Mac app is not signed with "${MAC_IDENTITY}". Every Mac would lose its permissions on this update.`);
  }
}

checkMacIdentity();
run("npm", ["test"]);
runWithRetry("npm", ["run", "dist:mac", "--", `-c.mac.identity=${MAC_IDENTITY}`], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});
checkMacSignature();
// electron-builder only warns when an extraResources file is missing, so a release could ship without them.
const helpers = join(APP, "Contents", "Resources", "bin");
for (const name of ["wacli", "whisper-cli", "smcp-nightlight"]) {
  try {
    accessSync(join(helpers, name), constants.X_OK);
  } catch {
    throw new Error(`The Mac app was built without ${name}. Run its install script before releasing.`);
  }
}
runWithRetry("npm", ["run", "dist:win"], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });

const out = join(BUILD, "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const zipName = `SMCP-${version}-mac-arm64.zip`;
const zip = join(out, zipName);
run("ditto", ["-c", "-k", "--keepParent", APP, zip]);

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

// Each download keeps the same name in every release, so the README can link straight to the latest one.
const downloads = ["SMCP-mac-arm64.dmg", "SMCP-windows-x64-setup.exe"].map((name) => join(BUILD, name));
// The release workflow builds the Linux packages on Linux and passes their folder here.
const LINUX_DIR = process.env.SMCP_LINUX_PACKAGES ?? BUILD;
const linux = ["SMCP-linux-x86_64.AppImage", "SMCP-linux-amd64.deb"].map((name) => join(LINUX_DIR, name));
const missingLinux = linux.filter((path) => !existsSync(path));
if (missingLinux.length && process.env.CI) throw new Error(`Missing Linux packages: ${missingLinux.join(", ")}`);
if (missingLinux.length) console.warn("::warning::No Linux packages found; publishing without them.");
for (const path of downloads) if (!existsSync(path)) throw new Error(`Missing ${path}`);

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
  ...downloads,
  ...linux.filter((path) => existsSync(path)),
  "--repo",
  "santiagomlr/smcp",
  "--title",
  `SMCP ${version}`,
  ...(process.env.GITHUB_SHA ? ["--target", process.env.GITHUB_SHA] : []),
  "--notes",
  "Download the .dmg for Apple Silicon Macs, the setup .exe for Windows, or the .deb (Ubuntu, Debian) or .AppImage for Linux.",
]);
