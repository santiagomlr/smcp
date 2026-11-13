#!/bin/bash
# Builds a pinned whisper.cpp release into vendor/mac-<arch>. The result is one file with no libraries to carry along.
# GGML_NATIVE stays off so a build made on one Mac also runs on the others.
# Usage: bash scripts/install-whisper.sh [arm64|x64]   (default: this Mac's chip; either chip can build for the other)
set -euo pipefail

VERSION="1.9.5"
SHA256="ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720"
CMAKE_VERSION="3.31.6"

[ "$(uname -s)" = "Darwin" ] || { echo "Solo se compila en Mac." >&2; exit 1; }
source "$(dirname "$0")/mac-arch.sh" "${1:-}"

# Apple Silicon uses Metal. Intel Macs use the CPU with AVX2, which every Intel Mac that runs macOS 14 has,
# plus Apple's Accelerate; their GPUs are too uneven for whisper.cpp's Metal code.
if [ "$ARCH" = arm64 ]; then
  CHIP_FLAGS=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
else
  CHIP_FLAGS=(-DGGML_METAL=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON)
fi

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
  -DCMAKE_OSX_ARCHITECTURES="$CLANG_ARCH" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF \
  "${CHIP_FLAGS[@]}" \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF
"$TMP/venv/bin/cmake" --build "$TMP/build" --target whisper-cli -j "$(sysctl -n hw.ncpu)"

install_helper "$TMP/build/bin/whisper-cli" whisper-cli
try_helper "$OUT/whisper-cli" --help > /dev/null
echo "whisper-cli ${VERSION} ($ARCH) instalado en $OUT"
