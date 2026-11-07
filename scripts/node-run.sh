#!/usr/bin/env bash
# Runs an OnBud TypeScript entry point with the user's Node (22.6 or later: type stripping, node:sqlite),
# found on PATH or in the usual install places, so configs never hard-code /usr/local/bin/node.
# usage: node-run.sh <file.ts> [args…]     (ONBUD_NODE=/path/to/node overrides the search)
set -eu
find_node() {
  [ -n "${ONBUD_NODE:-}" ] && { echo "$ONBUD_NODE"; return; }
  for n in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node \
           "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node" \
           "$(ls -d "$HOME"/.nvm/versions/node/v2*/bin/node 2>/dev/null | sort -V | tail -1)"; do
    [ -n "$n" ] && [ -x "$n" ] && { echo "$n"; return; }
  done
}
NODE="$(find_node)"
[ -n "$NODE" ] || { echo "OnBud needs Node.js 22.6 or later (brew install node)" >&2; exit 127; }
v="$("$NODE" -p 'process.versions.node')"; major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 6 ]; }; then
  echo "OnBud needs Node.js 22.6 or later; $NODE is $v (brew upgrade node)" >&2; exit 127
fi
exec "$NODE" --experimental-strip-types --experimental-sqlite --no-warnings "$@"
