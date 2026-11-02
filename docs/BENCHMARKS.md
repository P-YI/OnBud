# Benchmarks (v0.1, 2026-11-01)

Measured on one Mac (Apple silicon, macOS 27.x, Apple's on-device model). Subsets are small and fixed
(`tools/bench/subsets`, seeded), so read them as direction, not significance. Code tasks are greedy pass@1;
OpenAFM's pipelines check themselves only against examples in the problem text, never against hidden tests.

**Settings**
- **AFM raw:** the on-device model alone, one call.
- **S2 · AFM + tools:** the OpenAFM controller with local tools and skills, rules-only routing. This is the
  launcher's "AFM Agent".
- **S3 · + router:** S2 with the Decima router model advising (the launcher's "AFM + Decima").
- **S1 · full:** S2 plus hand-offs to Codex (GPT-6.1 Sol through OpenCode) when local work fails or the task
  is too big.
- **Codex only:** every task straight to Codex.

## Own task suite (66 tasks)

Documents, terminal, edits with tests, local jobs, LaTeX, web, safety, developer assistance, text tools,
office files and repository state, including 10 document tasks held out before any tuning (V).

| | AFM raw | S2 | S3 | S1 | Codex only |
|---|---|---|---|---|---|
| Passed | 2/15 (question tasks only) | **62/66 (94%)** | **62/66 (94%)** | 26/27 | 25/27 |
| Held-out documents (V) | – | 9/10 | 9/10 | – | – |
| Safety (I) | – | 4/4 | 4/4 | 4/4 | 4/4 |
| Median latency | 1.2 s | 1.9 s | 2.1 s | 5.9 s | 12.1 s |
| Codex calls | 0 | 0 | 0 | 2 | 27 |

S2 and S3 run the full 66; S1 and Codex only ran the original 27 shared tasks. S2 failures: three web tasks
that it defers (web search is off in S2) and one held-out document question. After the macOS 27.2 model
update the suite was re-run: same 62/66, median latency 2.6 → 1.9 s (S2).

## Code benchmarks (pass@1)

| Benchmark | AFM raw | S2 | S3 | S1 (v4) | Codex only |
|---|---|---|---|---|---|
| HumanEval (40) | 33% | 35% | 33% | **100%** | 100% |
| LiveCodeBench v6 (30) | 7% | 10% | 10% | **97%** | 97% |
| BigCodeBench-Hard, stdlib (25) | 8% | 8% | 8% | 28% | 28% |
| Mean seconds / problem | 7.6 | 10.9 | 12.1 | 12.5 | 9.7 |
| Codex API-equivalent cost (all 95) | $0 | $0 | $0 | $0.34 | $0.90 |

- **Hybrid routing (S1 v4):** 18 problems stayed local and all 18 passed (6.2 s each); 13 were escalated
  after one local attempt and all passed. It matches Codex alone at about 38% of its cost.
- **Adaptive local effort (v3, S2 only):** more candidates and repair lift S2 to 68% on HumanEval and 20% on
  LiveCodeBench, at about 23 s per problem; v4 keeps the faster path and escalates instead.
- **Costs:** Codex ran on a ChatGPT subscription; the column prices its measured tokens at standard API
  rates. On-device work has no per-token cost.

## ML implementation tasks (written for OpenAFM)

| | AFM alone | S2 | S3 | S1 | Codex only |
|---|---|---|---|---|---|
| ml (15) | 1 | 6 | 5 | 14 | 15 |
| ml held out (6) | – | 1 | – | 5 | – |

## Tool calling: BFCL v4 (20 per category, simplified AST checker)

How the on-device model picks functions, by method:

| Method | Score |
|---|---|
| native tool calling | 19/120 |
| two-step guided selection | 65/80 (simple, multiple, irrelevance, live_simple) |
| hybrid (used by the controller) | **86/120** |

## Small open models, same subsets (for orientation)

Served with vLLM on a rented GPU, greedy, `max_tokens` 1024 (4096 in parentheses).

| Model | HumanEval-40 | LCB-v6-30 | BCB-Hard-stdlib-25 |
|---|---|---|---|
| Apple on-device model (raw) | 33% | 7% | 8% |
| OpenAFM S2 (on-device + tools) | 35% | 10% | 8% |
| Qwen3.5-4B | 77.5% (87.5%) | 20% (30%) | 20% (20%) |
| gemma-4-E2B-it | 87.5% (90%) | 30% (46.7%) | 0% (12%) |
| Ministral-3-3B-Instruct | 82.5% (80%) | 26.7% (20%) | 20% (28%) |
| Qwen3-4B | 12.5% (67.5%) | 13.3% (20%) | 0% (0%) |

**Reading it:** the on-device model is a capable reader, summarizer and form-filler when code does the
searching and checking (94% on the task suite, at about 2 s and no cost), and a weak programmer on its own.
OpenAFM is built around that split.

## Reproducing

`tools/bench/BENCHMARK.md` describes the suites; `tools/bench/run-all.sh` runs them locally (datasets are
fetched at run time; the repository stores only task IDs). Results depend on the macOS model version.
