#!/bin/bash
# Installs a pinned wacli release into vendor/mac-<arch> and verifies its published checksum.
# Usage: bash scripts/install-wacli.sh [arm64|x64]   (default: this Mac's chip)
set -euo pipefail
source "$(dirname "$0")/mac-arch.sh" "${1:-}"

VERSION="0.26.0"
case "$ARCH" in
  arm64) WACLI_ARCH="arm64" ;;
  x64) WACLI_ARCH="amd64" ;;
esac

ARCHIVE="wacli_${VERSION}_darwin_${WACLI_ARCH}.tar.gz"
BASE="https://github.com/openclaw/wacli/releases/download/v${VERSION}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL --max-time 120 -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL --max-time 30 -o "$TMP/checksums.txt" "$BASE/checksums.txt"

(cd "$TMP" && /usr/bin/grep -F " $ARCHIVE" checksums.txt | /usr/bin/shasum -a 256 -c -)

mkdir -p "$TMP/x"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP/x"
BIN="$(find "$TMP/x" -type f -name wacli | head -1)"
[ -n "$BIN" ] || { echo "No se encontró wacli dentro de $ARCHIVE" >&2; exit 1; }
install_helper "$BIN" wacli

try_helper "$OUT/wacli" version
echo "wacli ${VERSION} ($ARCH) instalado en $OUT"
