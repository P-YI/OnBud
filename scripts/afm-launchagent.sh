#!/usr/bin/env bash
# Manage per-user LaunchAgents (login-time start, restart on crash).
# usage: afm-launchagent.sh install|uninstall|status|restart [apfel|agent|decima|searxng]
#        (restart/status with no service: every installed one)
#   apfel   : apfel OpenAI-compatible server, 127.0.0.1:11434 (model only)
#   agent   : AFM controller front for OpenCode, 127.0.0.1:11435 (needs apfel)
#   decima  : Ollaya serving the Decima router, 127.0.0.1:11436 (optional; scripts/decima-setup.sh install first)
#   searxng : SearXNG for web search, 127.0.0.1:8888 (optional; scripts/searxng-setup.sh install first)
# decima and searxng used to run in tmux (setup scripts' "start"), which does not survive a restart of the Mac;
# as LaunchAgents they start at login and come back after a crash.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"   # real path, also when run through the ~/OnBud link
ONBUD_HOME="${ONBUD_HOME:-$(dirname "$REPO")}"
TOKEN_FILE="$ONBUD_HOME/config/apfel.token"
DOMAIN="gui/$(id -u)"
CMD="${1:-status}"
# restart/status without a service act on both: both read the same token file at start, so after a
# token change restarting only apfel leaves the agent on the old token (OpenCode then shows "unauthorized").
if [ -z "${2:-}" ] && { [ "$CMD" = "restart" ] || [ "$CMD" = "status" ]; }; then
  echo "apfel:"; "$0" "$CMD" apfel
  echo "agent:"; "$0" "$CMD" agent
  for s in decima searxng; do [ -f "$HOME/Library/LaunchAgents/dev.onbud.$s.plist" ] && { echo "$s:"; "$0" "$CMD" "$s"; }; done
  exit 0
fi
SERVICE="${2:-apfel}"

case "$SERVICE" in
  apfel)
    LABEL="dev.onbud.apfel"; PORT=11434
    LOG="$ONBUD_HOME/runtime/logs/apfel-serve.log"
    PROGRAM="<string>/bin/bash</string><string>$REPO/scripts/apfel-run.sh</string>"
    ;;
  agent)
    LABEL="dev.onbud.agent"; PORT=11435
    LOG="$ONBUD_HOME/runtime/logs/afm-agent-server.log"
    NODE="$(command -v node)"
    # --watch-path: Node restarts the server when its code or policies change (no manual restart after edits).
    PROGRAM="<string>$NODE</string><string>--experimental-strip-types</string><string>--experimental-sqlite</string><string>--no-warnings</string><string>--watch-preserve-output</string><string>--watch-path=$REPO/bin</string><string>--watch-path=$REPO/services</string><string>--watch-path=$REPO/policies</string><string>$REPO/bin/afm-agent-server.ts</string>"
    ;;
  decima)
    LABEL="dev.onbud.decima"; PORT=11436; HEALTH="/api/tags"
    LOG="$ONBUD_HOME/runtime/logs/decima-serve.log"
    BIN="$ONBUD_HOME/runtime/ollaya/bin/ollaya"
    [ -x "$BIN" ] || { [ "$CMD" != install ] || { echo "Ollaya is not installed: scripts/decima-setup.sh install" >&2; exit 1; }; }
    PROGRAM="<string>$BIN</string><string>serve</string>"
    EXTRA_ENV="<key>OLLAYA_HOST</key><string>127.0.0.1:11436</string>"
    ;;
  searxng)
    LABEL="dev.onbud.searxng"; PORT=8888; HEALTH="/healthz"
    LOG="$ONBUD_HOME/runtime/logs/searxng.log"
    D="$ONBUD_HOME/runtime/searxng"
    [ -x "$D/venv/bin/python" ] || { [ "$CMD" != install ] || { echo "SearXNG is not installed: scripts/searxng-setup.sh install" >&2; exit 1; }; }
    PROGRAM="<string>$D/venv/bin/python</string><string>-m</string><string>searx.webapp</string>"
    EXTRA_ENV="<key>SEARXNG_SETTINGS_PATH</key><string>$D/settings.yml</string>"
    WORKDIR="$D/src"
    ;;
  *) echo "unknown service: $SERVICE (apfel|agent|decima|searxng)" >&2; exit 2 ;;
esac
HEALTH="${HEALTH:-/health}"; EXTRA_ENV="${EXTRA_ENV:-}"; WORKDIR="${WORKDIR:-$REPO}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "$CMD" in
  install)
    mkdir -p "$ONBUD_HOME/config" "$ONBUD_HOME/runtime/logs" "$HOME/Library/LaunchAgents"
    if [ ! -s "$TOKEN_FILE" ]; then
      (umask 077; openssl rand -hex 32 >"$TOKEN_FILE")
      echo "created token $TOKEN_FILE (mode 600)"
    fi
    chmod 600 "$TOKEN_FILE"
    [ "$SERVICE" = apfel ] && { "$REPO/scripts/stop-afm.sh" >/dev/null 2>&1 || true; }
    # a copy started by hand in tmux would hold the port
    [ "$SERVICE" = decima ] || [ "$SERVICE" = searxng ] && { tmux -L onbud kill-session -t "$([ "$SERVICE" = decima ] && echo ollaya || echo searxng)" 2>/dev/null || true; }
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>$PROGRAM</array>
  <key>WorkingDirectory</key><string>$WORKDIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ONBUD_HOME</key><string>$ONBUD_HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    $EXTRA_ENV
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
    # The same service under its v0.1.0 label (the project was called OpenAFM then) would hold the port.
    OLD="dev.openafm.$SERVICE"
    if [ -f "$HOME/Library/LaunchAgents/$OLD.plist" ] || launchctl print "$DOMAIN/$OLD" >/dev/null 2>&1; then
      launchctl bootout "$DOMAIN/$OLD" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$OLD.plist"
      echo "removed the old LaunchAgent $OLD"
    fi
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
    curl -s -m 2 "http://127.0.0.1:$PORT$HEALTH" | head -c 160; echo
    ;;
  *) echo "usage: $0 install|uninstall|status|restart [apfel|agent|decima|searxng]" >&2; exit 2 ;;
esac
