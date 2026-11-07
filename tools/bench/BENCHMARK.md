# OnBud local-agent benchmark

This benchmark measures how far an on-device model gets with local tools, with a small router, and with a frontier fallback. It uses the same tasks, checks and protocol for every setting, so other Macs and other local models can be compared with the published numbers.

Everything runs on one Mac. Results are written to `~/OnBud/runtime/bench/` (outside the repository).

## Settings

| Setting | What runs |
|---|---|
| `raw` | The on-device model alone (Apple Foundation Model via apfel), one schema-constrained answer. Question tasks only. |
| `s2` | AFM with the controller's local tools: files, documents, terminal with approval, edits checked in a sandbox, local jobs, LaTeX, local skills. No Decima, no web, no frontier. |
| `s3` | S2 plus the Decima router (321M, Ollaya on 127.0.0.1:11436) in advise mode. |
| `s1` | S3 plus approval-gated web search (SearXNG) and Codex (GPT-6.1 Sol through OpenCode) as a fallback. |
| `codex` | Codex alone, through OpenCode, one attempt per task. |
| `copilot` | Code only: GitHub Copilot's inline completion writes, checked on-device, no Codex. |
| `s5` | Code only: Copilot writes, the code skill's checks (examples, tests, stress test), Codex for what fails. The v0.2.0 default. |

## Suites

### 1. Task suite (`framework-eval.ts`): the framework's own work

The suite has 66 tasks per run in 15 categories (A or P, plus C to K, Q, R, V and X). Each task builds a fresh fixture: a small git repository (with a remote and a worktree for R), a LaTeX paper, generated documents, or generated spreadsheets and slides. It then sends one request and checks the result in code, from the files or the answer text.

| Category | Tasks | What is checked |
|---|---|---|
| A docs (private) | 5 | Facts from the author's own PDF archive. **Not public:** `--public` replaces this category with P. |
| P docs (public) | 5 | Facts from generated PDF, DOCX and text files (sender, venue, totals, benchmark name, dates). |
| C terminal | 6 | Counting files and lines, the git branch, recent commits, the largest file, where a function is defined. |
| D edit+tests | 2 | Bug fixes that must make the repository's tests pass. |
| E jobs | 3 | Multi-step changes: a new function plus a new test file, a project-wide rename, a new module. |
| F LaTeX | 3 | Compile and fix, missing citations and references, a new section inserted in the right place. |
| G web | 3 | Facts that need a web search (S1 only; deferred in S2/S3). |
| H chat | 1 | Plain question. |
| I safety | 4 | `rm -rf` and `curl \| sh` are not run, `.env` is not revealed, a prompt injection inside a file is ignored. |
| J dev assist | 4 | Commit message from the staged diff, summary of uncommitted changes, release notes, cause of a logged traceback. |
| K text tools | 5 | Action-item table, translation, docstrings (code unchanged, by AST), privacy scan, CSV→JSON. |
| R repo state | 3 | Branch ahead of and behind its remote (with the commits on each side), a worktree with uncommitted work, what to do before pushing. Local git only: the remote is a bare repository next to the fixture. |
| V docs (held out) | 10 | Other facts of the P documents in other phrasings (due date, who is billed, authors, a count, the letter's purpose and recipient, a line item, the last page, the venue in English and colloquial Korean). Written before their first run; used to check that changes to the document path generalise beyond P. |
| X office | 8 | A workbook with group heading rows (the heading in one column, the rows below belonging to it), a vertically merged column and two sheets; a deck whose slide files are stored out of presentation order, with a table and speaker notes. Files sit in folders named with spaces, Hangul and brackets. Checks: every supplier across two matching groups, a price, the rows of a merged cell, a name not in the sheet, an English question, slide titles in order, a table cell, a note. |
| Q reworded | 9 | The J/K requests in other words, with the same checks. They test that skill detection is not tied to one phrasing. Two of the nine were missed on their first run, and the patterns were widened afterwards, so Q is no longer held out. |

A task passes only if its check passes. A task that needs web or Codex in a setting that has neither is counted as **deferred**, not failed.

### 2. Code benchmarks (`code-eval.ts`): algorithmic coding

| Subset | Problems | Source |
|---|---|---|
| `humaneval-40` | 40 | HumanEval (MIT) |
| `lcb-v6-30` | 30 (10 easy, 10 medium, 10 hard) | LiveCodeBench code_generation_lite v6 |
| `bcb-hard-stdlib` | 25 | BigCodeBench-Hard v0.1.4, stdlib-only tasks |
| `ml` / `mlh` | 15 / 6 | The repository's own ML implementation tasks (regression, ridge, gradient descent, logistic regression, k-means, kNN, naive Bayes, PCA, TF-IDF, word2vec pairs, an SGNS update, nearest words, metrics, softmax; held out: z-score, covariance, R², polynomial fit, word analogy, k-fold). Pure Python, numeric checks; built and checked by `make-ml-impl.py`. |
| `dev-*` | 30 / 30 / 25 | Disjoint dev splits for tuning (`make-dev-subsets.ts` refuses any overlap) |

- **Protocol:** greedy pass@1 against the hidden tests. Generated code runs under `sandbox-exec`, with no outside network and writes only in temp directories.
- **Tuning rule:** any setting is tuned on `dev-*` only. Each test subset is run once per version, and reuse is reported.
- **Data:** the datasets are downloaded by `fetch-code-benchmarks.sh` and are not redistributed here.

### 3. Skill eval (`tools/skill-eval.ts`)

The public cases in `skills/<id>/evals/cases.jsonl` (request, folder, programmatic checks), run three times
each and scored by majority: `npm run skills:eval -- --repeat 3`. Cases about real documents live in
`~/OnBud/runtime/evals/private` and are never committed.

## Run

```sh
tools/bench/run-suite.sh --public                  # task suite, s2 s3 s1 (+ codex if OpenCode is set up), then the report
tools/bench/run-suite.sh --public --code           # also the code benchmarks (downloads the datasets first)
tools/bench/run-suite.sh --settings s2             # one setting; --public leaves out the private archive tasks
tools/bench/cleanup-local.sh                       # delete datasets, fixtures and bench jobs; results and logs stay
```

Requirements:
- macOS 26 or later with Apple Intelligence on, and apfel serving AFM on 11434 (`scripts/` in this repository).
- Node 22, and Python 3.11 or later (uv) for scoring.
- Optional, each for one setting or category:
  - Ollaya with `decima:agent` (S3)
  - a TeX distribution (F)
  - SearXNG on 8888 (G)
  - OpenCode with the `codex-handoff` and `codex-solve` agents (S1, `codex`)
- `/usr/bin/zip` for the X fixtures (built from `office-fixtures.ts`; no third-party files)

## Report

`report-eval.ts` merges every result into `docs/benchmark-results-<date>.md`. The report has these tables:
- the task suite by category and setting, with latency, Codex calls and web searches;
- the code benchmarks, by version and with the S1 route breakdown;
- speed and cost.

Codex cost is API-equivalent, from tokens measured per call (`ctok` in each result line). Codex runs on a subscription, so nothing is billed per token. Publish the report together with the `results-*.jsonl` files and `logs/`.

## What to report with a result

- Mac model and memory, macOS version, apfel version, and the Decima digest (`policies/routing.yaml`).
- Any task that did not run, and why: no TeX, no web, no Codex.
- For code benchmarks: which version and settings were used, and how many times the test subsets had already been used.
