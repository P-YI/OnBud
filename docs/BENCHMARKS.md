# Benchmarks (v0.2, 2026-11-08)

Measured on one Mac (Apple silicon, macOS 27.x). Small fixed subsets, so read them as direction, not
significance; models are not deterministic and a rerun moves a score by ±1–2. OnBud checks code only against
examples in the problem text (and its own stress test), never against hidden tests. Codex runs through OpenCode
on a ChatGPT subscription: GPT-6.1 Sol (reasoning medium) and, as the cheap tier, GPT-6.1 Terra. "Cost" prices
the measured tokens at API rates: Sol $2 / $0.10 / $10 per 1M input / cached / output; Terra $1 / $0.05 / $5
(a third-party price list; OpenAI's own page was not checked). On-device work and Copilot's inline completion
cost nothing per call.

## At a glance

The default setup is **OnBud (Copilot + Codex)**, a ladder of three writers, cheapest first: GitHub Copilot
(free), then Codex's cheap tier (Terra), then its strong tier (Sol). Every answer must pass a check before it is
kept (the problem's examples, the stress test, or agreement with Copilot's code), and a failed check moves the
task one rung up. Contest-style code starts at Copilot only when a bundled difficulty classifier calls it easy.
v0.1.0 had no Copilot: code went on-device first, then to Codex.

**Code on held-out set 3 (70 = HumanEval 40, LiveCodeBench v6 30).** Drawn at random from problems no earlier
run had used (seed 20261109), committed (016b1f0) before the ladder was measured, and run once per setup after
the code was frozen (08ab339), all on 2026-11-08. v0.1.0 is its release (7a38390) run again. BigCodeBench-Hard
has no unused stdlib tasks left, so set 3 has none.

| Setup | Passed | Codex calls | Cost | Time |
|---|---|---|---|---|
| v0.1.0 (on-device first, then Codex) | 58 | 45 | $0.19 | 29 min |
| **v0.2.0 (Copilot → Terra → Sol)** | **66** | **41** | **$0.09** | 13 min |
| Codex alone (Sol) | 67 | 70 | $0.26 | 10 min |
| Codex alone (Terra) | 65 | 70 | $0.11 | 7 min |

**Against v0.1.0:** 8 tasks more, cost −50%, wall time −56%. **Against Sol alone:** one task fewer (noise
level), cost −64%, ~1.3× the time. **Against Terra alone:** one task more, cost −17%, ~1.9× the time.
Per set (v0.1.0 / v0.2.0 / Sol / Terra): HumanEval 35 / 40 / 40 / 39 · LiveCodeBench 23 / 26 / 27 / 26.
Of v0.2.0's 36 Codex answers, 29 came from Terra and 7 from Sol. Where the time goes: Copilot requests are spaced
at least 1.5 s apart (an editor's pace), and a task Copilot cannot finish pays for its attempt before Codex.
One run each.

**Earlier sets.** Held-out set 2 (79, frozen 3752466) measured the setup before the ladder once: v0.1.0 70 ·
64 calls · $0.32 · 17 min; that v0.2.0 draft 67 · 34 · $0.17 · 20 min (Copilot first for all contest code,
unchecked code kept); Sol alone 71 · 79 · $0.32 · 12 min. Its failures were read when the ladder was designed,
so it is not a clean test of the ladder. The 95-problem set of the v0.1.0 page informed earlier design choices
(LCB 3696, HumanEval/83) and is retired for the same reason.

**All suites (development sets):**

| Suite (tasks) | v0.1.0 | v0.2.0 | Codex alone |
|---|---|---|---|
| **Everyday work** (framework eval, 56) | 55 · 0 Codex · 1.9 s median | 53 · 0 Codex · 2.8 s median ¹ | – |
| **Skills** (skill eval, 44 × 3 runs) ³ | 19 · 4.2 AFM calls · 5.9 s per request | **44** · 3.0 AFM calls · 5.2 s | – |
| **Code** (code eval, 81) | 77 · 68 Codex · $0.29 · 18 min | **80** · 47 Codex · **$0.11** · 13 min | Sol 80 · $0.31 · 13 min; Terra 78 · $0.14 · 8 min |

¹ The two everyday tasks lost are run-to-run variance: a Copilot-written job function (E3, 2/2 on rerun) and a
web search whose results change (G2, also red on older versions).
² The code skill was tuned on the development sets only after held-out set 2 was drawn; earlier changes had
used failures from the old test set (see "Earlier test set").
³ The skill eval was written with v0.2.0's skills (9 languages, Mac tasks, conversion); v0.1.0 had no such
skills, so read that row as coverage, not as the same test passed better.

## Code: every setup (development sets, 81 = HumanEval dev 30, LiveCodeBench dev 30, ML 15, ML held-out 6)

| Setup | Who writes the code | Passed | Codex calls | Cost | Time |
|---|---|---|---|---|---|
| On-device only | the on-device model, with local tools | 25 | 0 | $0 | 50 min |
| On-device + router | same, Decima advising | 23 | 0 | $0 | 58 min |
| Copilot only | GitHub Copilot, checked on-device | 53 | 0 | $0 | 12 min |
| On-device first, then Codex (v0.1.0 default) | on-device model; Codex when its check fails | 77 | 68 | $0.29 | 18 min |
| Copilot + Codex, first version (2026-11-03/06) | Copilot; Codex when the examples fail | 73–75 | 27–28 | $0.16 | 13 min |
| Copilot + Codex, before the last changes, 2 runs | Copilot with approach notes; stress-tested; Codex (Sol) for what fails or cannot be judged | 79 · 78 | 33 · 34 | $0.18 | 18 min |
| Same, Codex at low reasoning first, one Copilot candidate for contest code, 2 runs | | 81 · 80 | 38 · 41 | $0.16 · $0.19 | 16 · 17 min |
| Same, Terra first, Sol when Terra fails the examples | | 78 | 40 | $0.10 | 15 min |
| **v0.2.0 (default): the ladder (difficulty classifier, Copilot → Terra → Sol, cross-check)** | | **80** | 47 | **$0.11** | **13 min** |
| Codex alone (Sol) | Codex | 80 | 81 | $0.31 | 13 min |
| Codex alone (Terra) | Codex | 78 | 81 | $0.14 | 8 min |

v0.2.0 (one valid run; a second hit the Codex usage limit): LiveCodeBench 30/30, the three misses Copilot-side;
30 escalations ended at Terra, 6 went on to Sol. The development sets were used to tune the code skill; the held-out table above is the
fairer comparison.

**What Copilot changed.** Copilot alone is far above the on-device model (53 vs 25) at ~9 s a task. Using it as
the writer cut Codex calls from 68 to 27, at first for 3–4 points: Copilot's code could pass a contest problem's
examples and still be wrong.

**What the code skill added (v0.2.0).**
- *Difficulty classifier* (`skills/code/difficulty.json`, `services/controller/code-difficulty.ts`): on the dev
  logs Copilot solved 80% of easy contest problems and 2-6% of medium and hard ones, so trying it on those only
  cost time. Decima's code-difficulty question did not separate them (AUC 0.42-0.59 over four wordings; it is a
  zero-shot encoder that reads text against criteria, not a solver), nor did the on-device model's 1-5 rating
  (0.65). A logistic regression over hashed words, trained on DeepMind CodeContests ratings (CC BY 4.0; 35 KB of
  weights, <1 ms), scored 0.86 (dev LCB) and 0.92 (old test LCB); 0.81 on "Copilot solved it". Short or
  non-English requests are not scored.
- *Ladder with checks:* Terra's answer is kept when the examples pass, or (no examples) when it agrees with
  Copilot's code on generated inputs; otherwise Sol answers. Unchecked Copilot code is no longer kept on an
  inconclusive stress test when Codex is reachable (two of held-out set 2's losses).
- *Stress test* (`stress_pass`): for contest-style code, Copilot also writes a brute force and random-input
  generators; the candidate must agree on small inputs and finish without crashing or timing out on the worst
  case.
- *Retries are not trusted on the examples they were shown*: a candidate written after a failing example must
  pass the stress test (3 of 5 such candidates had been wrong).
- *Code the test cannot judge goes to Codex* (contest-style only).
- *Code nothing else checks* (no examples, no tests; Decima calls it easy) is compared with a brute force on
  small inputs and goes to Codex when they disagree (wrong code kept unchecked: dev 3 → 1–2 a run, test 1 → 0;
  HumanEval/83 and /84 now go to Codex).
- *One Copilot candidate, no retry,* for contest code when Codex is behind it: retries rarely kept a task local
  and cost ~10 s each (dev: 81, 80 with one candidate against 79 with two).
- *Checked escalation tries the smaller model first:* with runnable examples, Codex is asked with GPT-6.1 Terra;
  Sol answers only when Terra's code fails the examples (dev: cost $0.18 → $0.10, 18 → 15 min). This is in the
  code skill (benchmarks, the `afm_code` MCP tool); a local job that escalates still hands the whole task to
  Codex as before.
- *Approach notes* (`skills/code/patterns.json`, 24 algorithm patterns written for OnBud): the on-device model
  picks up to two and they go above Copilot's code as comments. On the held-out LiveCodeBench split Copilot then
  solved 11–12 problems itself instead of 7, and Codex calls fell from 23 to 18–19 at the same accuracy.
- Cost of the gate: ~6 extra Copilot requests (~10 s) on contest-style tasks only; nothing on others.
- Tried and not shipped (held-out LiveCodeBench): asking Codex for a plan first and letting Copilot write it
  (Codex calls 23 → 42, cost +70%); a private notebook of earlier Codex solutions (no fewer calls); a brute force
  written by the on-device model; a cue-based tagger for the notes. Details: `docs/skills-plan.md` §25–27.

## Everyday work: framework eval (56 tasks; documents, terminal, edits, jobs, LaTeX, web, safety, dev help)

| Setup | v0.1.0 | v0.2.0 |
|---|---|---|
| On-device only | 52 · 148 s | 52 · 162 s |
| On-device + router, web on approval | 54 · 196 s | 54 · 211 s |
| + Codex allowed | 55 · 169 s | 53 · 210 s ¹ |

No setup called Codex: everything ran on the Mac. The suite's private part (questions about real documents)
is not in the repository.

## Skills: skill eval (44 public cases, 3 runs each, majority)

| Pack | v0.1.0 | v0.2.0 |
|---|---|---|
| core (answers, language, routing) | 12/15 | 15/15 |
| files (find by name, topic, folder) | 3/9 | 9/9 |
| mac (health, controls) | 1/7 | 7/7 |
| convert · shortcuts · git · writing · personal | 0/3 · 0/2 · 0/3 · 0/1 · 0/1 | all green |
| code · security · web | 1/1 · 1/1 · 1/1 | 1/1 · 1/1 · 1/1 |
| replies in the request's language (126 runs, 9 languages) | 113 (build before skills) | 123 |

## Small open models (for orientation)

How the models OnBud works with compare with small open models that could run on a Mac. These rows use the
**test subsets** (HumanEval-40, LiveCodeBench v6-30, BigCodeBench-Hard stdlib-25), measured 2026-10-31/11-01.
The open models were served with vLLM on a rented GPU, greedy, with `max_tokens` 1024 (4096 in parentheses). The
same prompts and checks were used throughout.

| Model / setup | HumanEval-40 | LCB-v6-30 | BCB-Hard-stdlib-25 |
|---|---|---|---|
| Apple on-device model, alone (~3B; the model v0.2.0 still uses) | 33% | 7% | 8% |
| OnBud, on-device + tools (v0.1.0) | 35% | 10% | 8% |
| Qwen3.5-4B | 77.5% (87.5%) | 20% (30%) | 20% (20%) |
| gemma-4-E2B-it | 87.5% (90%) | 30% (46.7%) | 0% (12%) |
| Ministral-3-3B-Instruct | 82.5% (80%) | 26.7% (20%) | 20% (28%) |
| Qwen3-4B | 12.5% (67.5%) | 13.3% (20%) | 0% (0%) |
| OnBud, on-device first then Codex (v0.1.0) | 100% | 97% | 28% |
| **OnBud, Copilot + Codex (v0.2.0)** | 97.5% (9 Codex calls) | 96.7% (19) | 24% (8) |
| Codex alone (GPT-6.1 Sol) | 100% | 97% | 28% |

**v0.2.0 on the dev splits.** Same sources and size, different problems. The code skill was tuned on these; the
test subsets were used to choose between finished designs (pattern dictionary, escalation, taggers) and for the
final numbers above.

| v0.2.0 setup | HumanEval dev-30 | LCB-v6 dev-30 | s / problem |
|---|---|---|---|
| On-device only | 50% | 13% | 21–27 |
| Copilot only (Copilot writes, on-device checks; no Codex) | 87% | 40% | 5–13 |
| **Copilot + Codex (default)** | **90%** (6 Codex calls) | **97%** (21 Codex calls) | 6–28 |

**Reading it.**
- On its own, Apple's on-device model is a weak programmer, well below 3–4B open models on code.
- It is a capable reader, summarizer and form-filler when code does the searching and checking. That is what
  OnBud uses it for: 53/56 everyday tasks with no cloud call.
- Since v0.2.0, the code is written by GitHub Copilot instead of the on-device model. Copilot alone is about level with
  the best small open models on HumanEval and above them at the same token budget on LiveCodeBench. The
  problems differ, so read this as a rough comparison.
- With the code skill's checks plus Codex for what fails, v0.2.0 reaches Codex-level scores with 59% fewer
  Codex calls.

The GPU kit that produced the open-model rows (`tools/bench/server`) is in the v0.1.0 release. It is no longer
part of the repository.

## Reproducing
```bash
node --experimental-strip-types --experimental-sqlite tools/bench/code-eval.ts --bench lcb --mode s5 --ids tools/bench/subsets/dev-lcb-v6-30.json
node --experimental-strip-types --experimental-sqlite tools/bench/framework-eval.ts --setting s1
node --experimental-strip-types --experimental-sqlite tools/skill-eval.ts --repeat 3
```
Modes (internal names): `s2` on-device only, `s3` on-device + router, `s1` on-device first then Codex (v0.1.0
default), `copilot` Copilot only, `s5` Copilot + Codex (v0.2.0 default), `codex` Codex alone.

The v0.1.0 numbers in the first column come from the v0.1.0 release (its BENCHMARKS.md has the per-setting
tables and BFCL tool calling). Suite descriptions: `tools/bench/BENCHMARK.md`; datasets are
fetched at run time, the repository stores only task IDs.
