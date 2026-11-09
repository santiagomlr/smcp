#!/bin/bash
# Builds a pinned whisper.cpp release into vendor/bin. The result is one file with no libraries to carry along.
# GGML_NATIVE stays off so a build made on one Apple chip also runs on the others.
set -euo pipefail

VERSION="1.9.5"
SHA256="ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720"
CMAKE_VERSION="3.31.6"

[ "$(uname -sm)" = "Darwin arm64" ] || { echo "Solo se compila en Mac con Apple Silicon." >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The Command Line Tools work even when the Xcode license is still pending.
if [ -d /Library/Developer/CommandLineTools ]; then export DEVELOPER_DIR=/Library/Developer/CommandLineTools; fi

ARCHIVE="$TMP/whisper.tar.gz"
curl -fsSL --max-time 180 -o "$ARCHIVE" "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VERSION}.tar.gz"
echo "${SHA256}  ${ARCHIVE}" | /usr/bin/shasum -a 256 -c -
mkdir "$TMP/src"
tar -xzf "$ARCHIVE" -C "$TMP/src" --strip-components=1

python3 -m venv "$TMP/venv"
"$TMP/venv/bin/pip" install --quiet "cmake==${CMAKE_VERSION}"

"$TMP/venv/bin/cmake" -S "$TMP/src" -B "$TMP/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF
"$TMP/venv/bin/cmake" --build "$TMP/build" --target whisper-cli -j "$(sysctl -n hw.ncpu)"

mkdir -p "$ROOT/vendor/bin"
install -m 755 "$TMP/build/bin/whisper-cli" "$ROOT/vendor/bin/whisper-cli"
"$ROOT/vendor/bin/whisper-cli" --help > /dev/null
echo "whisper-cli ${VERSION} instalado en vendor/bin"
