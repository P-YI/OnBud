#!/usr/bin/env bash
# Read-only environment feasibility report. Changes nothing.
set -u

OPENAFM_HOME="${OPENAFM_HOME:-$HOME/OpenAFM}"
AFM_PORT="${AFM_PORT:-11434}"

section() { printf '\n== %s ==\n' "$1"; }

section "System"
sw_vers 2>/dev/null | sed 's/^/  /'
printf '  chip:   %s\n' "$(sysctl -n machdep.cpu.brand_string)"
printf '  ram:    %s GB\n' "$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))"

section "Resources"
df -h / | awk 'NR==2 {print "  disk free: " $4 " (used " $5 ")"}'
memory_pressure 2>/dev/null | awk -F': ' '/free percentage/ {print "  memory free: " $2}'
sysctl -n vm.swapusage | sed 's/^/  swap: /'
[ -d "$OPENAFM_HOME/runtime" ] && du -sh "$OPENAFM_HOME/runtime" | awk '{print "  runtime dir: " $1}'

section "Tools"
for c in fm apfel opencode ollama brew git node python3 uv cursor code; do
  p="$(command -v "$c" 2>/dev/null)"
  printf '  %-9s %s\n' "$c" "${p:-(not found)}"
done
command -v apfel >/dev/null && printf '  apfel version:    %s\n' "$(apfel --version 2>&1 | head -1)"
command -v opencode >/dev/null && printf '  opencode version: %s\n' "$(opencode --version 2>&1 | head -1)"

section "AFM model (apfel --model-info)"
command -v apfel >/dev/null && apfel --model-info 2>&1 | sed 's/^/  /'

section "Port $AFM_PORT"
if lsof -nP -iTCP:"$AFM_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -nP -iTCP:"$AFM_PORT" -sTCP:LISTEN | sed 's/^/  /'
  curl -s -m 2 "http://127.0.0.1:$AFM_PORT/health" | sed 's/^/  health: /'; echo
else
  echo "  free (no listener)"
fi

section "Non-loopback listeners (informational)"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 && $9 !~ /^(127\.0\.0\.1|\[::1\])/ {print "  " $1, $9}' | sort -u

section "OpenAFM services"
for p in 11434 11435; do printf '  %-6s %s\n' "$p" "$(curl -s -m 2 "http://127.0.0.1:$p/health" | head -c 90 || echo down)"; done
launchctl print "gui/$(id -u)/dev.openafm.agent" 2>/dev/null | grep -q "watch-path" && echo "  agent: auto-restart on code changes (node --watch-path)"
S="$HOME/.local/state/opencode/service.json"
[ -f "$S" ] && printf '  opencode service: %s (perm %s)\n' "$(python3 -c "import json;d=json.load(open('$S'));print(d['url'],d['version'])")" "$(stat -f %Lp "$S")"
[ -f "$OPENAFM_HOME/runtime/logs/mcp.jsonl" ] && printf '  openafm MCP: last event %s\n' "$(tail -1 "$OPENAFM_HOME/runtime/logs/mcp.jsonl" | cut -c1-110)"
printf '  token file perm: %s\n' "$(stat -f %Lp "$OPENAFM_HOME/config/apfel.token" 2>/dev/null)"
printf '  sqlite perm:     %s\n' "$(stat -f %Lp "$OPENAFM_HOME/runtime/db/openafm.sqlite" 2>/dev/null)"

section "Local capabilities"
printf '  pdftext (PDFKit+Vision): %s\n' "$([ -x "$OPENAFM_HOME/runtime/bin/pdftext" ] && echo built || echo 'missing (scripts/build-tools.sh)')"
printf '  tmux:   %s\n' "$(command -v tmux || echo '(not found)')"
printf '  TeX:    %s\n' "$([ -x /Library/TeX/texbin/latexmk ] && /Library/TeX/texbin/pdflatex --version | head -1 || echo '(no MacTeX)')"
command -v fm >/dev/null && printf '  fm models: %s\n' "$(NO_COLOR=1 fm respond --help 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | awk '/MODELS/{f=1;next} f&&NF{print $1}' | tr '\n' ' ')"
printf '  SearXNG: %s\n' "$(curl -s -m 2 http://127.0.0.1:8888/healthz >/dev/null && echo running || echo 'not running (web search uses DuckDuckGo/arXiv/Wikipedia)')"
printf '  Decima (Ollaya 11436): %s\n' "$(curl -s -m 2 http://127.0.0.1:11436/api/tags >/dev/null && echo running || ([ -x "$OPENAFM_HOME/runtime/ollaya/bin/ollaya" ] && echo 'installed, not running (scripts/decima-setup.sh start)' || echo 'not installed (scripts/decima-setup.sh install)'))"
