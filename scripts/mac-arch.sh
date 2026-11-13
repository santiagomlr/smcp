#!/bin/bash
# Shared by the install scripts: which Mac the helper is for and where it goes.
# Usage: source scripts/mac-arch.sh [arm64|x64]   (default: this Mac's own chip)
# Sets ARCH (Electron's name: arm64 or x64), CLANG_ARCH (arm64 or x86_64), OUT (vendor/mac-$ARCH)
# and NATIVE (1 when the helper is for this Mac's own chip).
case "$(uname -m)" in
  arm64) HOST_ARCH="arm64" ;;
  x86_64) HOST_ARCH="x64" ;;
  *) echo "Arquitectura no soportada: $(uname -m)" >&2; exit 1 ;;
esac
ARCH="${1:-${SMCP_ARCH:-$HOST_ARCH}}"
case "$ARCH" in
  arm64) CLANG_ARCH="arm64" ;;
  x64) CLANG_ARCH="x86_64" ;;
  *) echo "Arquitectura no soportada: $ARCH (usa arm64 o x64)" >&2; exit 1 ;;
esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Each chip's helpers live in their own folder, which is what electron-builder packs for that chip.
OUT="$ROOT/vendor/mac-$ARCH"
NATIVE=0
[ "$ARCH" = "$HOST_ARCH" ] && NATIVE=1

# Copies a finished helper into vendor/mac-$ARCH and, when it is for this Mac, into vendor/bin for development.
install_helper() {
  local src="$1" name="$2"
  mkdir -p "$OUT"
  install -m 755 "$src" "$OUT/$name"
  /usr/bin/lipo "$OUT/$name" -verify_arch "$CLANG_ARCH" || { echo "$name no es para $CLANG_ARCH" >&2; exit 1; }
  if [ "$NATIVE" = 1 ]; then
    mkdir -p "$ROOT/vendor/bin"
    install -m 755 "$src" "$ROOT/vendor/bin/$name"
  fi
}

# Runs a finished helper to check it works, through Rosetta when it is for Intel and this Mac has it.
# A helper this Mac cannot run at all is only checked by lipo above.
try_helper() {
  if [ "$NATIVE" = 1 ]; then
    "$@"
  elif [ "$ARCH" = x64 ] && /usr/bin/arch -x86_64 /usr/bin/true 2> /dev/null; then
    /usr/bin/arch -x86_64 "$@"
  else
    echo "No se puede probar $1 en esta Mac; solo se revisó que sea para $CLANG_ARCH."
  fi
}
