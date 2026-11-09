// Publishes the current package.json version: builds, signs the update manifest and creates the GitHub release.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = join(homedir(), ".smcp-release", "update-signing-key.pem");
const BUILD = join(homedir(), "Library", "Caches", "smcp-build");
const GH = process.env.GH ?? "gh";

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const privateKey = createPrivateKey(readFileSync(KEY));

run("npm", ["test"]);
run("npm", ["run", "dist:mac"], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
run("npm", ["run", "dist:win"], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });

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
writeFileSync(`${manifestPath}.sig`, sign(null, Buffer.from(manifest), privateKey).toString("base64"));

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
  "--notes",
  "Descarga el .dmg para Mac o el Setup .exe para Windows.",
]);
