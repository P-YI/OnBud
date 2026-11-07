#!/usr/bin/env bash
# One command for the benchmark (tools/bench/BENCHMARK.md): task suite for the chosen settings, optionally the code
# benchmarks, then the report.
#   run-suite.sh [--public] [--settings s2,s3,s1,codex] [--code] [--tag name]
# AFM-bound runs go one after another (apfel serves one request at a time).
set -u
cd "$(dirname "$0")/../.."
N="node --experimental-strip-types --experimental-sqlite --no-warnings"
L="${ONBUD_HOME:-$HOME/OnBud}/runtime/bench/logs"; mkdir -p "$L"
S=tools/bench/subsets
PUBLIC=""; SETTINGS="s2,s3,s1"; CODE=0; TAG="suite"
while [ $# -gt 0 ]; do
  case "$1" in
    --public) PUBLIC="--public" ;;
    --settings) SETTINGS="$2"; shift ;;
    --code) CODE=1 ;;
    --tag) TAG="$2"; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
# Codex only when OpenCode can reach it; the other settings need only apfel (and Ollaya for s3).
if [[ ",$SETTINGS," == *",codex,"* ]] && ! command -v opencode >/dev/null && [ ! -x "$HOME/.opencode/bin/opencode" ]; then
  echo "skipping codex: OpenCode not found"; SETTINGS="${SETTINGS//codex/}"
fi
curl -s --max-time 3 http://127.0.0.1:11434/health >/dev/null || curl -s --max-time 3 http://127.0.0.1:11434/v1/models >/dev/null || { echo "apfel is not answering on 127.0.0.1:11434"; exit 1; }

for s in ${SETTINGS//,/ }; do
  [ -n "$s" ] || continue
  echo "task suite: $s"
  $N tools/bench/framework-eval.ts --setting "$s" --tag "$TAG" $PUBLIC > "$L/suite-fw-$s.log" 2>&1
  grep -E "pass, [0-9]+ deferred" "$L/suite-fw-$s.log"
done

if [ "$CODE" = 1 ]; then
  bash tools/bench/fetch-code-benchmarks.sh all > "$L/suite-fetch.log" 2>&1 || { echo "dataset download failed (see $L/suite-fetch.log)"; exit 1; }
  for s in ${SETTINGS//,/ }; do
    [ -n "$s" ] || continue
    for b in "humaneval humaneval-40 40" "lcb lcb-v6-30 30" "bcb-hard bcb-hard-stdlib 25"; do set -- $b
      echo "code: $1 $s"
      $N tools/bench/code-eval.ts --bench "$1" --mode "$s" --ids "$S/$2.json" --tag v4 --codex-budget "$3" > "$L/suite-code-$1-$s.log" 2>&1
      grep "pass@1" "$L/suite-code-$1-$s.log"
    done
  done
fi

$N tools/bench/report-eval.ts --fw-tag "$TAG" > /dev/null && echo "report: docs/benchmark-results-$(date +%F).md"
