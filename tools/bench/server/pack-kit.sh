#!/usr/bin/env bash
# Pack only what the server needs (server kit + subset ids), no personal config, no data, no results.
#   tools/bench/server/pack-kit.sh  →  ~/OpenAFM/runtime/openafm-bench-kit.tar.gz
set -eu
R="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${1:-${OPENAFM_HOME:-$HOME/OpenAFM}/runtime/openafm-bench-kit.tar.gz}"
tar -C "$R" -czf "$OUT" --exclude '.venv' --exclude '.hf' --exclude 'data' --exclude 'results' --exclude 'score' --exclude 'result' --exclude '__pycache__' --exclude '*.tar.gz' \
  tools/bench/server tools/bench/subsets
echo "$OUT ($(du -h "$OUT" | cut -f1))"; tar -tzf "$OUT"
