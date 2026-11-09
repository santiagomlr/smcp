// Picks the version for the next release: package.json if someone raised it, otherwise the next patch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isNewer } from "../app/core/updater.js";

export function nextVersion(current, latest) {
  if (!latest || isNewer(current, latest)) return current;
  const [major, minor, patch] = latest.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(nextVersion(version, process.argv[2]?.replace(/^v/, "")));
}
