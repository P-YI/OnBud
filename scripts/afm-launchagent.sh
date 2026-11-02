#!/usr/bin/env bash
# Manage per-user LaunchAgents (login-time start, restart on crash).
# usage: afm-launchagent.sh install|uninstall|status|restart [apfel|agent]   (restart/status with no service: both)
#   apfel : apfel OpenAI-compatible server, 127.0.0.1:11434 (model only)
#   agent : AFM controller front for OpenCode, 127.0.0.1:11435 (needs apfel)
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPENAFM_HOME="${OPENAFM_HOME:-$(dirname "$REPO")}"
TOKEN_FILE="$OPENAFM_HOME/config/apfel.token"
DOMAIN="gui/$(id -u)"
CMD="${1:-status}"
# restart/status without a service act on both: both read the same token file at start, so after a
# token change restarting only apfel leaves the agent on the old token (OpenCode then shows "unauthorized").
if [ -z "${2:-}" ] && { [ "$CMD" = "restart" ] || [ "$CMD" = "status" ]; }; then
  echo "apfel:"; "$0" "$CMD" apfel
  echo "agent:"; "$0" "$CMD" agent
  exit 0
fi
SERVICE="${2:-apfel}"

case "$SERVICE" in
  apfel)
    LABEL="dev.openafm.apfel"; PORT=11434
    LOG="$OPENAFM_HOME/runtime/logs/apfel-serve.log"
    PROGRAM="<string>/bin/bash</string><string>$REPO/scripts/apfel-run.sh</string>"
    ;;
  agent)
    LABEL="dev.openafm.agent"; PORT=11435
    LOG="$OPENAFM_HOME/runtime/logs/afm-agent-server.log"
    NODE="$(command -v node)"
    # --watch-path: Node restarts the server when its code or policies change (no manual restart after edits).
    PROGRAM="<string>$NODE</string><string>--experimental-strip-types</string><string>--experimental-sqlite</string><string>--no-warnings</string><string>--watch-preserve-output</string><string>--watch-path=$REPO/bin</string><string>--watch-path=$REPO/services</string><string>--watch-path=$REPO/policies</string><string>$REPO/bin/afm-agent-server.ts</string>"
    ;;
  *) echo "unknown service: $SERVICE (apfel|agent)" >&2; exit 2 ;;
esac
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "$CMD" in
  install)
    mkdir -p "$OPENAFM_HOME/config" "$OPENAFM_HOME/runtime/logs" "$HOME/Library/LaunchAgents"
    if [ ! -s "$TOKEN_FILE" ]; then
      (umask 077; openssl rand -hex 32 >"$TOKEN_FILE")
      echo "created token $TOKEN_FILE (mode 600)"
    fi
    chmod 600 "$TOKEN_FILE"
    [ "$SERVICE" = apfel ] && { "$REPO/scripts/stop-afm.sh" >/dev/null 2>&1 || true; }
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>$PROGRAM</array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENAFM_HOME</key><string>$OPENAFM_HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    chmod 644 "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout is asynchronous; bootstrapping too early fails with "5: Input/output error"
    for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    launchctl bootstrap "$DOMAIN" "$PLIST" || { sleep 2; launchctl bootstrap "$DOMAIN" "$PLIST"; }
    echo "installed $PLIST"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL (token kept at $TOKEN_FILE)"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | awk '/^\tstate =|^\tpid =|last exit code/ {$1=$1; print "  " $0}'
    else
      echo "  $LABEL not loaded"
    fi
    curl -s -m 2 "http://127.0.0.1:$PORT/health" | head -c 160; echo
    ;;
  *) echo "usage: $0 install|uninstall|status|restart [apfel|agent]" >&2; exit 2 ;;
esac
