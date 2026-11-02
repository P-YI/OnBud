#!/usr/bin/env bash
# Remove local benchmark data after an evaluation; keep results (*.jsonl / *.json), logs and reports.
#   datasets: runtime/bench/code/{humaneval,lcb,bcb-hard}.jsonl, runtime/bench/bfcl/
#   leftovers: runtime/bench/fw/fx/ (fixtures), bench jobs + worktrees, sandbox clones, LaTeX build output
# Re-download with tools/bench/fetch-code-benchmarks.sh and tools/bench/fetch-bfcl.sh.
set -eu
B="${OPENAFM_HOME:-$HOME/OpenAFM}/runtime"
before=$(du -sh "$B/bench" 2>/dev/null | cut -f1)
rm -f "$B/bench/code/humaneval.jsonl" "$B/bench/code/lcb.jsonl" "$B/bench/code/bcb-hard.jsonl"
rm -rf "$B/bench/bfcl" "$B/bench/fw/fx" "$B/sandbox" "$B/latex"
cd "$(dirname "$0")/../.."
node --experimental-strip-types --experimental-sqlite --no-warnings -e '
const J = await import("./services/controller/jobs.ts"); const { rmSync } = await import("node:fs"); const { join } = await import("node:path");
let n = 0; for (const j of J.listJobs()) if (/runtime\/bench\//.test(j.root)) { if (j.workspace.dir) await J.discardJob(j).catch(() => {}); rmSync(join(process.env.OPENAFM_HOME ?? join(process.env.HOME, "OpenAFM"), "runtime/jobs", j.id), { recursive: true, force: true }); n++; }
console.log("bench jobs removed:", n);'
echo "runtime/bench: $before → $(du -sh "$B/bench" | cut -f1) (results and logs kept)"
