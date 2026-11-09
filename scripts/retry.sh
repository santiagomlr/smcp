#!/bin/bash
# Runs a command and, if it fails, tries again after 15s, 45s, 90s, 180s and 300s (about 10 minutes in all).
# Downloads from GitHub (Electron, electron-builder's tools, wacli, whisper.cpp) sometimes get a 5xx answer
# that lasts several minutes. Each attempt keeps what earlier ones downloaded, so later attempts have less to fetch.
set -uo pipefail

for delay in 15 45 90 180 300 0; do
  "$@" && exit 0
  [ "$delay" = 0 ] && exit 1
  echo "::warning::'$*' failed; retrying in ${delay}s."
  sleep "$delay"
done
