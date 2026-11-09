// iCloud Drive tags files with attributes that make codesign fail, so clear them before signing.
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack({ appOutDir, electronPlatformName }) {
  if (electronPlatformName === "darwin") execFileSync("/usr/bin/xattr", ["-cr", appOutDir]);
};
