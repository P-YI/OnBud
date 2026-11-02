#!/usr/bin/env bash
# Foreground apfel server wrapper used by the LaunchAgent and start-afm.sh.
# Token is passed via APFEL_TOKEN (env), never on the command line, so it does not show up in `ps`.
set -eu

OPENAFM_HOME="${OPENAFM_HOME:-$HOME/OpenAFM}"
TOKEN_FILE="$OPENAFM_HOME/config/apfel.token"
AFM_PORT="${AFM_PORT:-11434}"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "missing $TOKEN_FILE (run scripts/afm-launchagent.sh install)" >&2
  exit 78   # EX_CONFIG: launchd will not hot-loop thanks to ThrottleInterval
fi
APFEL_TOKEN="$(cat "$TOKEN_FILE")"
export APFEL_TOKEN

# Loopback only; one concurrent model request until memory impact is measured.
APFEL="$(command -v apfel || echo /opt/homebrew/bin/apfel)"   # Homebrew (brew install apfel); PATH first
exec "$APFEL" --serve --host 127.0.0.1 --port "$AFM_PORT" --max-concurrent 1
