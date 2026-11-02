#!/usr/bin/env bash
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPENAFM_HOME="${OPENAFM_HOME:-$(dirname "$REPO")}"
PIDFILE="$OPENAFM_HOME/runtime/apfel.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" && echo "stopped apfel (pid $(cat "$PIDFILE"))"
else
  echo "apfel not running (per $PIDFILE)"
fi
rm -f "$PIDFILE"
