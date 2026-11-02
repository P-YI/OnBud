#!/usr/bin/env bash
# Download code-generation benchmark data (data only; nothing from it is executed here) into runtime/bench/code.
#   humaneval   164 problems, MIT                                   (~0.2 MB)
#   bcb-hard    BigCodeBench-Hard v0.1.4, 148 tasks, Apache-2.0      (~1 MB via the HF datasets-server API)
#   lcb         LiveCodeBench code_generation_lite release v6        (test6.jsonl, ~134 MB) — 60 problems are sampled,
#               then the big file is deleted. Hidden tests are pickled: only pickles without code-loading opcodes
#               are accepted (checked with pickletools before loading).
# usage: tools/bench/fetch-code-benchmarks.sh [humaneval|bcb-hard|lcb|all]
set -eu
D="${OPENAFM_HOME:-$HOME/OpenAFM}/runtime/bench/code"; mkdir -p "$D"
what="${1:-all}"
if [ "$what" = humaneval ] || [ "$what" = all ]; then
  curl -fsSL https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz | gunzip > "$D/humaneval.jsonl"
  echo "humaneval: $(wc -l < "$D/humaneval.jsonl") problems"
fi
if [ "$what" = bcb-hard ] || [ "$what" = all ]; then
  : > "$D/bcb-hard.jsonl"
  for off in 0 100; do
    curl -fsSL "https://datasets-server.huggingface.co/rows?dataset=bigcode/bigcodebench-hard&config=default&split=v0.1.4&offset=$off&length=100" \
      | python3 -I -c 'import json,sys;[print(json.dumps(r["row"])) for r in json.load(sys.stdin)["rows"]]' >> "$D/bcb-hard.jsonl"
  done
  echo "bcb-hard: $(wc -l < "$D/bcb-hard.jsonl") tasks"
fi
if [ "$what" = bcb-full ]; then   # dev split source (full BigCodeBench v0.1.4, 1140 tasks; Hard tasks excluded later)
  : > "$D/bcb-full.jsonl"
  for off in $(seq 0 100 1100); do
    curl -fsSL "https://datasets-server.huggingface.co/rows?dataset=bigcode/bigcodebench&config=default&split=v0.1.4&offset=$off&length=100" \
      | python3 -I -c 'import json,sys;[print(json.dumps(r["row"])) for r in json.load(sys.stdin)["rows"]]' >> "$D/bcb-full.jsonl"
  done
  echo "bcb-full: $(wc -l < "$D/bcb-full.jsonl") tasks"
fi
if [ "$what" = lcb ] || [ "$what" = all ]; then
  tmp="$D/lcb-test6.jsonl"
  curl -fsSL "https://huggingface.co/datasets/livecodebench/code_generation_lite/resolve/main/test6.jsonl" -o "$tmp"
  python3 -I - "$tmp" "$D/lcb.jsonl" <<'PY'
import base64, json, pickle, pickletools, random, sys, zlib
UNSAFE = {"GLOBAL", "STACK_GLOBAL", "REDUCE", "INST", "OBJ", "NEWOBJ", "NEWOBJ_EX", "BUILD", "EXT1", "EXT2", "EXT4"}
def safe_unpickle(b):
    for op, _, _ in pickletools.genops(b):
        if op.name in UNSAFE: raise ValueError("unsafe pickle opcode " + op.name)
    return pickle.loads(b)
def private(s):
    try: return json.loads(s)
    except Exception: return json.loads(safe_unpickle(zlib.decompress(base64.b64decode(s.encode()))))
rows = [json.loads(l) for l in open(sys.argv[1])]
random.seed(0); out = []
for diff in ("easy", "medium", "hard"):
    pool = [r for r in rows if r.get("difficulty") == diff]
    for r in random.sample(pool, min(20, len(pool))):
        out.append({"id": r["question_id"], "title": r["question_title"], "difficulty": diff, "date": r["contest_date"], "content": r["question_content"],
                    "starter": r.get("starter_code", ""), "public": json.loads(r["public_test_cases"]), "private": private(r["private_test_cases"]),
                    "metadata": json.loads(r.get("metadata") or "{}")})
with open(sys.argv[2], "w") as f:
    for o in out: f.write(json.dumps(o) + "\n")
print("lcb:", len(out), "problems (release v6 sample)")
PY
  rm -f "$tmp"
fi
du -sh "$D"
