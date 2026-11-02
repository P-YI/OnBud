#!/usr/bin/env bash
# Server kit: score open models on the OpenAFM benchmark subsets, then clean up.
# Run on a Linux GPU server (CUDA; ≥ 24 GB VRAM for 7B in bf16; 1–4B models fit 16 GB).
#   ./run.sh setup                  venv + vLLM + BFCL harness (~10 GB of wheels)
#   ./run.sh data                   HumanEval, BigCodeBench-Hard rows, LiveCodeBench v6 (only the 30 subset ids kept), BFCL
#   ./run.sh selftest               score the official solutions with the same checker (expect HumanEval 40/40, BCB ≥ 23/25)
#   ./run.sh models [list]          score every model in models.txt (or the given ids) → results/
#   ./run.sh bfcl [model]           BFCL v4 on the same 120 ids with the official harness (see notes in README)
#   ./run.sh pack                   results.tar.gz to copy back to the Mac (~/OpenAFM/runtime/bench/server/)
#   ./run.sh cleanup                delete model checkpoints (HF cache), datasets and the venv; keeps results + pack
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
VENV="$HERE/.venv"; DATA="$HERE/data"; export HF_HOME="${HF_HOME:-$HERE/.hf}"
py() { "$VENV/bin/python" "$@"; }
case "${1:-help}" in
  setup)
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q -U pip
    "$VENV/bin/pip" install -q "vllm>=0.8" "bfcl-eval"   # pin versions in your run notes
    ;;
  data)
    mkdir -p "$DATA"
    curl -fsSL https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz | gunzip > "$DATA/humaneval.jsonl"
    : > "$DATA/bcb-hard.jsonl"
    for off in 0 100; do
      curl -fsSL "https://datasets-server.huggingface.co/rows?dataset=bigcode/bigcodebench-hard&config=default&split=v0.1.4&offset=$off&length=100" \
        | python3 -I -c 'import json,sys;[print(json.dumps(r["row"])) for r in json.load(sys.stdin)["rows"]]' >> "$DATA/bcb-hard.jsonl"
    done
    curl -fsSL https://huggingface.co/datasets/livecodebench/code_generation_lite/resolve/main/test6.jsonl -o "$DATA/test6.jsonl"
    python3 -I "$HERE/lcb_extract.py" "$DATA/test6.jsonl" "$HERE/../subsets/lcb-v6-30.json" "$DATA/lcb.jsonl" && rm -f "$DATA/test6.jsonl"
    du -sh "$DATA"
    ;;
  selftest)
    # The checker must accept the datasets' own reference solutions before any model is scored.
    py - "$DATA" "$HERE/../subsets" <<'PY'
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath("run_subsets.py")))
import run_subsets as R
data, subs = sys.argv[1], sys.argv[2]
for bench, sub, field in [("humaneval", "humaneval-40.json", "prompt"), ("bcb", "bcb-hard-stdlib.json", "complete_prompt")]:
    items = list(R.problems(bench, data, os.path.join(subs, sub)))
    ok = sum(R.check(bench, p, p[field] + p["canonical_solution"])[0] for _, _, p in items)
    print(f"{bench}: reference solutions pass {ok}/{len(items)}")
print("network isolation:", " ".join(R.NO_NET) or "NOT available (run inside a disposable container/VM)")
PY
    ;;
  models)
    shift || true
    list=("$@"); [ ${#list[@]} -gt 0 ] || mapfile -t list < <(grep -v '^#' "$HERE/models.txt" | sed '/^\s*$/d')
    for m in "${list[@]}"; do
      echo "== $m"; py "$HERE/run_subsets.py" --model "$m" --data "$DATA" --subsets "$HERE/../subsets" --out "$HERE/results"
      # Free disk as we go: drop this model's checkpoint once it is scored.
      rm -rf "$HF_HOME/hub/models--${m//\//--}"
    done
    ;;
  bfcl)
    # Official harness on the same ids: write test_case_ids_to_generate.json from the subset and run with --run-ids.
    m="${2:?model id}"
    py -c 'import json,sys;json.dump(json.load(open(sys.argv[1]))["ids"],open("test_case_ids_to_generate.json","w"),indent=1)' "$HERE/../subsets/bfcl-v4-120.json"
    "$VENV/bin/bfcl" generate --model "$m" --test-category simple_python,multiple,parallel,parallel_multiple,irrelevance,live_simple --run-ids --backend vllm --num-gpus 1
    "$VENV/bin/bfcl" evaluate --model "$m" --test-category simple_python,multiple,parallel,parallel_multiple,irrelevance,live_simple
    mkdir -p "results/bfcl"; cp -r score "results/bfcl/${m//\//__}" 2>/dev/null || true
    ;;
  pack) tar czf results.tar.gz results && ls -lh results.tar.gz ;;
  cleanup)
    rm -rf "$HF_HOME/hub" "$HF_HOME/datasets" "$DATA" "$VENV" result score test_case_ids_to_generate.json
    echo "removed checkpoints, datasets and venv; kept: results/ results.tar.gz"
    ;;
  *) sed -n '2,12p' "$0" ;;
esac
