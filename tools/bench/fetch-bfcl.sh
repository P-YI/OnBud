#!/usr/bin/env bash
# Re-download the BFCL v4 subsets used by tools/bench/bfcl-eval.ts (~1.8 MB) into runtime/bench/bfcl.
set -eu
B="${OPENAFM_HOME:-$HOME/OpenAFM}/runtime/bench/bfcl"
mkdir -p "$B/answers"
base=https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data
for c in simple_python multiple parallel parallel_multiple irrelevance live_simple; do
  curl -sfL "$base/BFCL_v4_$c.json" -o "$B/$c.json"
  [ "$c" != irrelevance ] && curl -sfL "$base/possible_answer/BFCL_v4_$c.json" -o "$B/answers/$c.json"
done
du -sh "$B"
