#!/bin/bash
# Installs a pinned wacli release into vendor/bin and verifies its published checksum.
set -euo pipefail

VERSION="0.26.0"
case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *) echo "Arquitectura no soportada: $(uname -m)" >&2; exit 1 ;;
esac

ARCHIVE="wacli_${VERSION}_darwin_${ARCH}.tar.gz"
BASE="https://github.com/openclaw/wacli/releases/download/v${VERSION}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL --max-time 120 -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL --max-time 30 -o "$TMP/checksums.txt" "$BASE/checksums.txt"

(cd "$TMP" && /usr/bin/grep -F " $ARCHIVE" checksums.txt | /usr/bin/shasum -a 256 -c -)

mkdir -p "$TMP/x" "$ROOT/vendor/bin"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP/x"
BIN="$(find "$TMP/x" -type f -name wacli | head -1)"
[ -n "$BIN" ] || { echo "No se encontró wacli dentro de $ARCHIVE" >&2; exit 1; }
install -m 755 "$BIN" "$ROOT/vendor/bin/wacli"

"$ROOT/vendor/bin/wacli" version
