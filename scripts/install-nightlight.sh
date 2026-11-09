#!/bin/bash
# Builds the night light helper (native/nightlight.swift) into vendor/bin. It only needs the
# Command Line Tools that come with Xcode, and it links nothing outside macOS itself.
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "Solo se compila en Mac." >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The Command Line Tools work even when the Xcode license is still pending.
if [ -d /Library/Developer/CommandLineTools ]; then export DEVELOPER_DIR=/Library/Developer/CommandLineTools; fi

mkdir -p "$ROOT/vendor/bin"
xcrun swiftc -O -swift-version 5 -target arm64-apple-macos13 \
  -o "$ROOT/vendor/bin/smcp-nightlight" "$ROOT/native/nightlight.swift"
chmod 755 "$ROOT/vendor/bin/smcp-nightlight"
"$ROOT/vendor/bin/smcp-nightlight" --check
echo "smcp-nightlight instalado en vendor/bin"
