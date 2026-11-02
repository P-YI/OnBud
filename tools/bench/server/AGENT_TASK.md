# Task for the server agent: score open models on the OpenAFM benchmark subsets

You are on a Linux GPU server. You received `openafm-bench-kit.tar.gz`: this kit plus the subset id files. Score each open model on exactly these subsets with the kit's scripts, return the results, and leave no checkpoints or datasets behind.

## Rules
- **Run only the kit's scripts.** Do not change the subsets, prompts or checker (`run_subsets.py`); the numbers must be comparable with the Mac runs. If something must change to run at all, stop and report what and why.
- **Isolation.** Generated code is executed. Use a disposable container or VM. If `./run.sh selftest` prints `network isolation: NOT available`, say so in the report. Never run as root on a shared host.
- **Gated models (Llama, Gemma).** If access is not granted, skip the model and list it in the report. Do not write Hugging Face tokens into any file; use `huggingface-cli login` or the `HF_TOKEN` environment variable for this session only.
- **Budget.** Stop and report if the whole run would exceed **4 GPU-hours** or **200 GB** of disk. Expect about 5–20 minutes per model on one 24 GB GPU.
- **Data.** Do not upload code, data or results anywhere except back to the user (the `results.tar.gz` below).

## Steps
```bash
tar xzf openafm-bench-kit.tar.gz && cd tools/bench/server
./run.sh setup        # .venv with vLLM + bfcl-eval; note the installed versions (pip freeze | grep -E 'vllm|torch|bfcl')
./run.sh data         # HumanEval, BigCodeBench-Hard rows, LiveCodeBench v6 (only the 30 subset ids kept)
./run.sh selftest     # REQUIRED gate: HumanEval 40/40 and BCB ≥ 23/25 with the reference solutions; otherwise stop and report
./run.sh models       # all models in models.txt; each checkpoint is deleted right after scoring
# optional, per model, if time allows (check flag names with `bfcl generate --help`):
./run.sh bfcl Qwen/Qwen3-4B
./run.sh pack         # → results.tar.gz
./run.sh cleanup      # removes checkpoints (HF cache), datasets and the venv; keeps results/ and results.tar.gz
```

## Report back
1. `results.tar.gz`, containing `results/<model>/{humaneval,lcb,bcb}.jsonl` and `summary.json`.
2. A short note with:
   - GPU model, driver and CUDA version
   - vLLM, torch and bfcl versions
   - wall time per model
   - skipped models and why
   - selftest numbers
   - whether network isolation was active
   - anything unusual: out-of-memory errors, tokenizer or chat-template warnings, timeouts
3. Confirmation that `./run.sh cleanup` ran, and `du -sh` of what remains.
