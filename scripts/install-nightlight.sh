#!/bin/bash
# Builds the night light helper (native/nightlight.swift) into vendor/mac-<arch>. It only needs the
# Command Line Tools that come with Xcode, and it links nothing outside macOS itself.
# Usage: bash scripts/install-nightlight.sh [arm64|x64]   (default: this Mac's chip)
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "Solo se compila en Mac." >&2; exit 1; }
source "$(dirname "$0")/mac-arch.sh" "${1:-}"

# The Command Line Tools work even when the Xcode license is still pending.
if [ -d /Library/Developer/CommandLineTools ]; then export DEVELOPER_DIR=/Library/Developer/CommandLineTools; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
xcrun swiftc -O -swift-version 5 -target "${CLANG_ARCH}-apple-macos13" \
  -o "$TMP/smcp-nightlight" "$ROOT/native/nightlight.swift"
install_helper "$TMP/smcp-nightlight" smcp-nightlight
try_helper "$OUT/smcp-nightlight" --check
echo "smcp-nightlight ($ARCH) instalado en $OUT"
