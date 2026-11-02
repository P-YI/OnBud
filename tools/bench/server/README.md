# Server kit: open models on the OpenAFM benchmark subsets

These steps score open models with exactly the same subsets and checks as the Mac runs, then delete the checkpoints and data. The Mac produces the **AFM raw / S2 / S3 / S1 / Codex** rows; the server produces the **open-model rows**. Both are merged by `tools/bench/report-eval.ts`.

## What is compared
| Benchmark | Subset (ids in `../subsets/`) | Protocol |
|---|---|---|
| HumanEval | `humaneval-40.json`: 40 of 164, seeded | greedy pass@1; whole function in one code block; `check()` from the dataset |
| LiveCodeBench v6 | `lcb-v6-30.json`: 10 easy / 10 medium / 10 hard from release v6 (`test6.jsonl`) | stdin or LeetCode-style function; official import prefix; public + hidden tests (first 30) |
| BigCodeBench-Hard v0.1.4 | `bcb-hard-stdlib.json`: 25 tasks whose libs **and** test imports are stdlib-only | unittest from the dataset |
| BFCL v4 | `bfcl-v4-120.json`: 20 evenly spaced ids × 6 categories | official harness (`bfcl generate/evaluate --run-ids`) |

Open-model numbers from this kit are directly comparable with the Mac's **AFM raw** row (one sample, no tools). S2/S3/S1 are framework results (self-checks on the examples in the problem text) and are reported separately.

## Getting the kit to the server
`tools/bench/server/pack-kit.sh` writes `~/OpenAFM/runtime/openafm-bench-kit.tar.gz` (about 12 KB). It contains only this folder and `../subsets/`: no personal configuration, data or results. Copying the whole repository also works, but it is not needed.

To have an agent on the server do the run, give it `AGENT_TASK.md`, which covers the rules, steps and what to report back.

## Steps (on the server)
```bash
tar xzf openafm-bench-kit.tar.gz && cd tools/bench/server
./run.sh setup        # venv with vLLM and bfcl-eval
./run.sh data         # data/ : HumanEval, BCB-Hard rows, LCB v6 (only the 30 subset problems kept; 134 MB file deleted)
./run.sh selftest     # reference solutions must pass: HumanEval 40/40, BCB ≥ 23/25
./run.sh models       # every model in models.txt; each checkpoint is deleted right after it is scored
./run.sh bfcl Qwen/Qwen3-4B   # optional, per model; check flag names with `bfcl generate --help` for your version
./run.sh pack         # results.tar.gz
./run.sh cleanup      # removes HF cache (checkpoints), datasets, venv; keeps results/ and results.tar.gz
```

Then copy `results.tar.gz` to the Mac, unpack it into `~/OpenAFM/runtime/bench/server/`, and run:
```bash
node --experimental-strip-types tools/bench/report-eval.ts
```

## Notes
- **BigCodeBench 971 and 1040 fail with their own reference solutions on macOS** (file timestamps; a local socket server timing out), so every Mac setting fails them equally. On Linux they may pass. Compare open-model and Mac rows with that in mind (at most 2 of 25).
- **Generated code runs on the server.** Use a disposable machine or container. `run_subsets.py` uses `unshare -rn` (no network) when the kernel allows it, plus timeouts.
- **Hidden LiveCodeBench tests are pickled.** `lcb_extract.py` refuses pickles that contain code-loading opcodes.
- **Gated models (Llama, Gemma) need an accepted licence and `huggingface-cli login`.** Do not commit tokens.
- **Disk:**
  - about 3–15 GB per checkpoint, deleted after each model
  - about 10 GB of wheels in the venv
  - about 150 MB of data
- **Per-category BFCL scores:** the harness writes them to `score/`. The kit copies them into `results/bfcl/<model>/`.

## Remote models scored on the Mac (`run_remote_subsets.py`)
When the models are served on the server (vLLM, OpenAI-compatible) and reached through an SSH tunnel, the Mac generates and scores:
```bash
python3 -I run_remote_subsets.py selftest                       # HumanEval 40/40, BCB 23/25 (971 and 1040 fail on macOS)
python3 -I run_remote_subsets.py generate --model Qwen/Qwen3-4B --base-url http://127.0.0.1:18000/v1 --out results
python3 -I run_remote_subsets.py score --gen results/Qwen__Qwen3-4B
# supplementary, larger budget (reported separately from the protocol run):
python3 -I run_remote_subsets.py generate --model Qwen/Qwen3-4B --base-url http://127.0.0.1:18000/v1 --max-tokens 4096 --out results-mt4096
```
- **Unchanged from `run_subsets.py`:** prompts, subsets, `code_block()` and `check()` are imported from it.
- **Generation:** temperature 0 and `max_tokens` 1024 (protocol). Every reply's `finish_reason` is kept, and the summary reports the share cut off at the budget.
- **Scoring on macOS:** each program runs under `sandbox-exec` with the same profile and Python as the AFM runs: no outside network, and writes only in temp areas.
