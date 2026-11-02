#!/usr/bin/env bash
# Full local evaluation: own suite + code benchmarks + BFCL for raw / s2 / s3 / s1 / codex.
# AFM-bound runs go one after another (apfel serves one request at a time); Codex-only runs go in parallel.
# Logs: runtime/bench/logs/*.log · results: runtime/bench/{fw,code}/results-*.jsonl, runtime/bench/bfcl-results-*.json
set -u
cd "$(dirname "$0")/../.."
L="${OPENAFM_HOME:-$HOME/OpenAFM}/runtime/bench/logs"; mkdir -p "$L"
N="node --experimental-strip-types --experimental-sqlite --no-warnings"
S=tools/bench/subsets
code_runs() { # $1 = mode, $2 = extra
  $N tools/bench/code-eval.ts --bench humaneval --mode "$1" --ids $S/humaneval-40.json $2 > "$L/code-humaneval-$1.log" 2>&1
  $N tools/bench/code-eval.ts --bench lcb --mode "$1" --ids $S/lcb-v6-30.json $2 > "$L/code-lcb-$1.log" 2>&1
  $N tools/bench/code-eval.ts --bench bcb-hard --mode "$1" --ids $S/bcb-hard-stdlib.json $2 > "$L/code-bcb-$1.log" 2>&1
}
# Codex-only, in parallel with the AFM runs
( code_runs codex "--codex-budget 100"; $N tools/bench/framework-eval.ts --setting codex > "$L/fw-codex.log" 2>&1; echo done > "$L/codex.done" ) &
# AFM-bound, sequential
for s in raw s2 s3 s1; do $N tools/bench/framework-eval.ts --setting $s > "$L/fw-$s.log" 2>&1; done
code_runs raw ""; code_runs s2 ""; code_runs s3 ""; code_runs s1 "--codex-budget 40"
$N tools/bench/bfcl-eval.ts --n 20 --methods native,twostep,hybrid > "$L/bfcl.log" 2>&1
wait
echo "all done" > "$L/all.done"
