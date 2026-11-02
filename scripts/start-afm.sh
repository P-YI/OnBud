#!/usr/bin/env bash
# Start apfel manually (loopback, token auth) when the LaunchAgent is not installed.
# Prefer scripts/afm-launchagent.sh install for a login-time service.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPENAFM_HOME="${OPENAFM_HOME:-$(dirname "$REPO")}"
AFM_PORT="${AFM_PORT:-11434}"
PIDFILE="$OPENAFM_HOME/runtime/apfel.pid"
LOG="$OPENAFM_HOME/runtime/logs/apfel-serve.log"

if curl -s -m 1 "http://127.0.0.1:$AFM_PORT/health" >/dev/null 2>&1; then
  echo "apfel already serving on 127.0.0.1:$AFM_PORT"; exit 0
fi
if lsof -nP -iTCP:"$AFM_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $AFM_PORT is taken by another process; set AFM_PORT" >&2; exit 1
fi

OPENAFM_HOME="$OPENAFM_HOME" nohup "$REPO/scripts/apfel-run.sh" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"

for _ in $(seq 1 20); do
  curl -s -m 1 "http://127.0.0.1:$AFM_PORT/health" >/dev/null 2>&1 && { echo "apfel up on 127.0.0.1:$AFM_PORT (pid $(cat "$PIDFILE"))"; exit 0; }
  sleep 0.5
done
echo "apfel did not become healthy; see $LOG" >&2; exit 1
