#!/bin/bash
# Runs a command and, if it fails, tries again after 15s, 45s and 90s.
# Downloads from GitHub (Electron, wacli, whisper.cpp) sometimes get a 5xx answer that clears up within minutes.
set -uo pipefail

for delay in 15 45 90 0; do
  "$@" && exit 0
  [ "$delay" = 0 ] && exit 1
  echo "::warning::'$*' failed; retrying in ${delay}s."
  sleep "$delay"
done
