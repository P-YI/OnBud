#!/usr/bin/env bash
# OnBud setup: installs what the AFM Agent needs, from each project's own source, asking before every step.
#   1. Homebrew (https://brew.sh)          — only to install the next two
#   2. apfel  (brew install apfel, MIT)    — the on-device Apple model as a local server (127.0.0.1:11434)
#   3. Node.js 22.6+ (brew install node)   — runs the OnBud controller (127.0.0.1:11435)
#   4. LaunchAgents dev.onbud.apfel / dev.onbud.agent — start both at login (scripts/afm-launchagent.sh)
# Nothing runs without a "y". Re-running skips what is already there. The launcher app opens this in
# Terminal ("Set up OnBud…"); it also works from a checkout: scripts/setup.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"   # real path, also when run through the ~/OnBud link
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local a; read -r -p "$1 [y/N] " a; [ "$a" = y ] || [ "$a" = Y ]; }
ok()  { printf '  ✓ %s\n' "$*"; }

say "OnBud setup"
echo "  Backend: $REPO"

# 0. The Mac: Apple silicon, macOS 26+, Apple Intelligence (the on-device model only exists there).
[ "$(uname -m)" = arm64 ] || { echo "  OnBud needs an Apple silicon Mac."; exit 1; }
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 26 ] || { echo "  OnBud needs macOS 26 or later (this Mac: $(sw_vers -productVersion))."; exit 1; }
ok "macOS $(sw_vers -productVersion) on Apple silicon"
echo "  Apple Intelligence must be on: System Settings > Apple Intelligence & Siri."

# 1. Homebrew
if ! command -v brew >/dev/null; then
  say "Homebrew is not installed."
  echo "  apfel and Node are installed with Homebrew. Its official installer is:"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  if ask "Run the Homebrew installer now (it asks for your password)?"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || exit 1
    eval "$(/opt/homebrew/bin/brew shellenv)"
  else
    echo "  Install Homebrew (https://brew.sh), then run this again."; exit 1
  fi
fi
ok "Homebrew $(brew --version | head -1 | cut -d' ' -f2)"

# 2. apfel
if command -v apfel >/dev/null; then ok "apfel $(apfel --version 2>/dev/null | head -1)"
else
  say "apfel (https://github.com/Arthur-Ficial/apfel, MIT) serves Apple's on-device model to OnBud."
  ask "brew install apfel?" && brew install apfel || { echo "  OnBud cannot answer without apfel."; exit 1; }
fi

# 3. Node.js 22.6+
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)'; }
if node_ok; then ok "Node.js $(node --version)"
else
  say "Node.js 22.6 or later runs the OnBud controller$(command -v node >/dev/null && echo " (found $(node --version), too old)")."
  if command -v node >/dev/null && brew list node >/dev/null 2>&1; then ask "brew upgrade node?" && brew upgrade node
  else ask "brew install node?" && brew install node; fi
  node_ok || { echo "  Node.js 22.6+ is still missing (another Node may come first on PATH: $(command -v node))."; exit 1; }
fi

# 4. LaunchAgents (token, apfel, controller)
say "Start apfel (127.0.0.1:11434) and the controller (127.0.0.1:11435) at login?"
echo "  Writes ~/Library/LaunchAgents/dev.onbud.{apfel,agent}.plist and a private token in ~/OnBud/config."
echo "  Both listen on this Mac only. Remove them any time: $REPO/scripts/afm-launchagent.sh uninstall apfel|agent"
if ask "Install and start them now?"; then
  "$REPO/scripts/afm-launchagent.sh" install apfel && "$REPO/scripts/afm-launchagent.sh" install agent || exit 1
  for _ in $(seq 1 20); do curl -s -m 1 http://127.0.0.1:11435/health >/dev/null && break; sleep 1; done
  curl -s -m 2 http://127.0.0.1:11435/health >/dev/null && ok "controller running" || echo "  The controller did not answer yet; see ~/OnBud/runtime/logs/afm-agent-server.log"
  curl -s -m 2 http://127.0.0.1:11434/health | grep -q '"model_available":true' && ok "on-device model available" \
    || echo "  apfel runs, but the model is not available yet (Apple Intelligence still downloading or turned off)."
else
  echo "  Skipped. Start them later with: $REPO/scripts/afm-launchagent.sh install apfel && $REPO/scripts/afm-launchagent.sh install agent"
fi

say "Done. Back in OnBud, press Check again. Optional extras (router model, Codex, web search, LaTeX) are in Settings > Plugins."
