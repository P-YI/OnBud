// The code skill's graph (skills/code, 2026-11-08): one place for how code is written, checked and escalated.
// A ladder of three writers, cheapest first; each answer must pass a check before it is kept, and a failed check
// moves the task one rung up:
//
//   triage ─▶ Copilot (free) ─▶ check ─▶ gate ─▶ keep
//      │        ▲                  └──────┴─ fail / inconclusive ─┐
//      │        └ easy contest code, any function code            ▼
//      └─ hard contest code ─────────────────────────────▶ cheap frontier tier ─▶ check ─▶ keep
//                                                                       └─ fail ─▶ strong frontier (Sol)
//
// - write: generators in codegen.ts (Copilot's editor-like completion, AFM's structured generation).
// - check: the task's own examples (never hidden tests) or, in local jobs, the project's checks.
// - gate (check "stress_pass"): for contest-style code, and for any candidate written after it saw a failing
//   example (its examples are no longer evidence: 3 of 5 such candidates were wrong, 2026-11-07), a brute force
//   and random inputs must agree with the candidate and the worst-case input must finish in time. It runs code,
//   so it can fail; a model's score (Decima's included) cannot be a gate: Decima's 0.07-0.29 did not separate
//   right from wrong Copilot code on LCB.
// - triage: contest-style code goes to Copilot only when the difficulty classifier (code-difficulty.ts) calls it
//   easy; on the dev logs Copilot solved 80% of easy contest problems and 2-6% of the others, so trying it on
//   those only cost time. Function code goes to Copilot first.
// - escalate: the cheap tier's answer is kept when the task's examples pass, or (no examples) when it agrees with
//   Copilot's code on generated inputs; otherwise the strong tier answers. Without a frontier the best local code
//   is kept.
// Used by the code benchmark (S5 = solveCode, S1 = solveAdaptive), and by local jobs (gateJobCode).
// - triage (firstWriter): who writes first — Copilot, or the frontier at once. One rule for local jobs (controller)
//   and the benchmark (solveCode); its inputs are policies/routing.yaml (copilot_mode, decima_code_hard_threshold).
// Options: ~/OnBud/config/skills.json "options": { "code": { ... } } (codeOptions); the benchmark sets them by flags.
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fill, type Filler } from "../frontier/copilot-ls.ts";
import { option } from "../skills/settings.ts";
import { algorithmic, copilotCandidate, formatGate, generate, solveCopilot, solveLocal, verifiable, type CodeTask, type LocalResult } from "./codegen.ts";
import { runPython } from "./sandbox.ts";
import { notesFor } from "./code-patterns.ts";
import { easyContest } from "./code-difficulty.ts";

// ---------------------------------------------------------------- options
/** Where the brute force comes from. "copilot" (default): the same model as the candidate. "afm": the on-device
 *  model; "both": AFM first, Copilot when AFM's fails the examples. Measured 2026-11-07 (LCB dev, 10 easy + the 5
 *  problems Copilot gets wrong): AFM's passed the examples on 6/14, never on a medium or hard problem — 0 catches,
 *  ~25 s more per problem, 2 false alarms with "both"; Copilot's caught 3721 and 3744 with 0 false alarms. */
export type Reference = "copilot" | "afm" | "both";
export interface CodeOptions {
  stress: boolean;               // the gate on (stress_pass)
  reference: Reference;
  escalateInconclusive: boolean; // contest code the gate cannot judge goes to the frontier (LCB 3786: +1 for ~3 calls / 81)
  patterns: "off" | "public";    // pattern-dictionary notes above Copilot's code on contest-style tasks (code-patterns.ts)
  cascade: boolean;              // escalation: the cheap frontier tier first, the strong tier only when its answer fails the check
  contestCandidates: number;     // Copilot candidates for contest code when a frontier is behind it (more: more local solves, more time)
}
export function codeOptions(over: Partial<CodeOptions> = {}): CodeOptions {
  const o = (k: keyof CodeOptions, d: any) => option("code", k, d);
  return {
    stress: o("stress", true),
    reference: o("reference", "copilot"),
    escalateInconclusive: o("escalateInconclusive", true),
    // measured on the held-out LCB test split (2026-11-07, docs/skills-plan.md §27): the notes cut Codex calls
    // at the same accuracy
    patterns: o("patterns", "public") === "off" ? "off" : "public",
    cascade: o("cascade", true),
    contestCandidates: Number(o("contestCandidates", 1)),
    ...over,
  };
}

// ---------------------------------------------------------------- triage: who writes first
export type CopilotMode = "balanced" | "saver";
export interface Triage { mode: CopilotMode; hardAt: number }
let triageCache: Triage | undefined;
/** copilot_mode and decima_code_hard_threshold from policies/routing.yaml (the same values the controller uses). */
export async function policyTriage(): Promise<Triage> {
  if (!triageCache) { const { loadPolicy } = await import("../policy/policy.ts"); const p = loadPolicy(); triageCache = { mode: p.decision.copilotMode, hardAt: p.decision.decima.codeHardThreshold }; }
  return triageCache;
}
export type RouteReason = "decima_code_hard" | "algorithmic_code" | "hard_contest" | "unverifiable_code" | "local_job";
/** Copilot ("local") or the frontier first, when a frontier is reachable.
 *  - Decima-hard, contest-style, or new code nothing can check would go to the frontier;
 *  - with Copilot, such code that tests or examples can check is written locally first (the checks and the gate
 *    decide), except, in balanced mode, contest-style code the difficulty classifier does not call easy (`easy`);
 *  - new code nothing can check is written locally when the caller can cross-check it against the cheap frontier
 *    tier (`crossCheck`: the code skill), or, in saver mode, when Decima calls it easy;
 *  - saver keeps v0.1-style Copilot-first for everything checkable. `copilot` is asked only when it matters (it
 *    may start the language server). */
export async function firstWriter(r: { d?: number; algorithmic: boolean; newCode: boolean; checkable: boolean; easy?: boolean; crossCheck?: boolean; copilot: () => Promise<boolean> } & Triage): Promise<{ writer: "local" | "frontier"; reason: RouteReason; copilotTier?: boolean }> {
  const why: RouteReason | undefined = r.d !== undefined && r.d >= r.hardAt ? "decima_code_hard" : r.algorithmic ? "algorithmic_code" : r.newCode && !r.checkable ? "unverifiable_code" : undefined;
  if (!why) return { writer: "local", reason: "local_job" };
  if (r.mode === "balanced" && r.algorithmic && r.easy === false) return { writer: "frontier", reason: "hard_contest" };
  if (why !== "unverifiable_code" && r.checkable && (await r.copilot())) return { writer: "local", reason: why, copilotTier: true };
  if (why === "unverifiable_code" && r.crossCheck && (await r.copilot())) return { writer: "local", reason: why, copilotTier: true };
  if (why !== "decima_code_hard" && r.mode === "saver" && r.d !== undefined && r.d < r.hardAt && (await r.copilot())) return { writer: "local", reason: why, copilotTier: true };
  return { writer: "frontier", reason: why };
}

// ---------------------------------------------------------------- stress test
export interface StressResult { verdict: "pass" | "fail" | "inconclusive"; detail: string; counter?: string; compared: number; brute?: string; afmCalls?: number }
export interface StressOptions { n?: number; afm?: AFMProvider; reference?: Reference; brute?: string; worstCase?: boolean }
const norm = (o: string) => { const t = o.trim(); try { return JSON.stringify(JSON.parse(t.split("\n").pop() ?? "")); } catch { return t.replace(/[ \t]+$/gm, ""); } };
const isTimeout = (out: string) => /\[timeout\]|Timed out|killed/i.test(out);

/** A runnable program for one input: a stdin program as it is; a function called with one JSON value per line. */
function asProgram(task: CodeTask, code: string, input: string): { program: string; stdin?: string } {
  if (task.kind === "program" || !task.entry) return { program: code, stdin: input };
  const call = (task.invoke ?? "_f(*_a)").replace(/\b_f\b/, task.entry).replace(/\b_a\b/, "_args");
  return { program: `${code}\nimport json as _json\n_args=[_json.loads(x) for x in ${JSON.stringify(input)}.split("\\n") if x.strip()]\nprint(_json.dumps(${call}))\n` };
}

/** `f` over `xs`, at most `k` at a time (sandboxed runs are independent processes). */
async function pool<T, R>(xs: T[], k: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, xs.length) }, async () => { while (i < xs.length) { const j = i++; out[j] = await f(xs[j]); } }));
  return out;
}

/** AFM's brute force: plain, literal, exhaustive; kept only if it passes the statement's examples (two tries). */
export async function afmBrute(afm: AFMProvider, task: CodeTask): Promise<{ code?: string; afmCalls: number }> {
  const ask = "\n\nWrite a BRUTE-FORCE reference solution: the simplest obviously-correct method, trying every possibility and following every rule of the statement literally (order of events, ties, wrap-around, inclusive bounds). Inputs will be tiny, so speed does not matter. No clever optimisations.";
  let afmCalls = 0;
  for (let i = 0; i < 2; i++) {
    const g = await generate(afm, task, i, ask, true); afmCalls++;
    if (g.ok && g.code.trim() && (await verifiable(task, g.code)) === true) return { code: g.code, afmCalls };
  }
  return { afmCalls };
}

/** The candidate against a brute force on small random inputs, and alone on the worst-case input.
 *  Light version (2026-11-07): no medium inputs (they caught nothing the small ones missed), shorter completions,
 *  runs in parallel — ~6 Copilot requests, was ~10.
 *  The time-limit test runs even when no brute force passes the examples (LCB 3744). */
export async function stressTest(ls: Filler, task: CodeTask, code: string, o: StressOptions = {}): Promise<StressResult> {
  const n = o.n ?? 12, ref: Reference = o.afm ? (o.reference ?? "copilot") : "copilot";
  let afmCalls = 0, brute = o.brute, source = "given";
  if (!brute && ref !== "copilot" && o.afm) { const b = await afmBrute(o.afm, task); afmCalls += b.afmCalls; brute = b.code; source = "afm"; }
  if (!brute && ref !== "afm") {
    const b = await copilotCandidate(ls, task, undefined, "brute", { rounds: 4 });
    if (b && b.code.trim() !== code.trim() && (await verifiable(task, b.code)) !== false) { brute = b.code; source = "copilot"; }
  }
  const cm = task.prompt.trim().slice(0, 2500).split("\n").map((l) => `# ${l}`.trimEnd()).join("\n");
  const fmt = task.kind === "program" || !task.entry ? "in exactly the input format of the statement (what the program reads from standard input)" : `as one JSON value per line, one line per argument of ${task.entry}`;
  const suffix = `\n\n\nif __name__ == "__main__":\n    import sys\n    print(gen(random.Random(int(sys.stdin.read().strip() or 0))), end="")\n`;
  // one file per generator: a combined file (gen_small + gen_large, 2026-11-07) varied the small inputs less and
  // missed LCB 3721 (events out of timestamp order)
  const SIZES = { small: "Keep it tiny (at most 6 items, values at most 10) so a brute force finishes at once. Vary the structure: unsorted orders, ties, duplicates, equal timestamps, boundary values.",
    large: "Return the WORST-CASE input the constraints allow: maximum sizes AND extreme values (largest numbers, widest ranges), the input that makes a slow algorithm slowest. It is a time-limit test." } as const;
  const generator = async (size: keyof typeof SIZES) => {
    const head = `${cm}\n# Test input generator for the problem above.\n# gen(rng) returns ONE random valid input as a string, ${fmt}.\n# ${SIZES[size]}\nimport random\nimport json\n\n\ndef gen(rng):\n    `;
    const g = await fill(ls, join(tmpdir(), "onbud-copilot", `${task.entry ?? "main"}_gen_${size}.py`), "python", head, suffix, size === "small" ? 6 : 4);
    return g.text.trim() ? head + g.text + suffix : undefined;
  };
  const base = { afmCalls, brute };
  const inputs = async (size: keyof typeof SIZES, want: number, maxLen: number) => {
    const gen = await generator(size);
    if (!gen) return [];
    return [...new Set((await pool([...Array(want * 2).keys()], 4, (i) => task.exec(gen, String(i)))).filter((r) => r.ok && r.out.trim() && r.out.length < maxLen).map((r) => r.out))].slice(0, want);
  };
  let compared = 0;
  if (brute) {
    const small = await inputs("small", n, 4000);
    if (!small.length) return { verdict: "inconclusive", detail: "no generator", compared: 0, ...base };
    // two pairs at a time (four processes): generated code has no memory cap in the sandbox (one LCB solution
    // reached 2.8 GB), so the concurrency stays low; the worst-case runs below go one at a time
    const runs = await pool(small, 2, async (input) => {
      const b = asProgram(task, brute!, input), c = asProgram(task, code, input);
      const [rb, rc] = await Promise.all([task.exec(b.program, b.stdin), task.exec(c.program, c.stdin)]);
      return { input, rb, rc };
    });
    for (const { input, rb, rc } of runs) {
      if (!rb.ok) continue;   // the brute force cannot take this input (error or too slow): not evidence
      compared++;
      if (!rc.ok || norm(rc.out) !== norm(rb.out))
        return { verdict: "fail", detail: `differs from the ${source} brute force on input ${compared}`, compared, ...base, counter: `input:\n${input.slice(0, 300)}\nexpected (brute force): ${norm(rb.out).slice(0, 200)}\ngot: ${rc.ok ? norm(rc.out).slice(0, 200) : rc.out.slice(-200)}` };
    }
  }
  // worst case: the candidate alone on two of the largest inputs the constraints allow; a timeout or a crash
  // fails it, the output is not judged. Crashes counted since 2026-11-07: LCB 3696's code passed the small
  // inputs and raised on long ones (int() of a 4,301-digit string) — found reviewing held-out failures.
  for (const r of o.worstCase === false ? [] : await pool(await inputs("large", 2, 5_000_000), 1, async (big) => { const c = asProgram(task, code, big); return { big, rc: await task.exec(c.program, c.stdin) }; })) {
    if (r.rc.ok) continue;
    if (isTimeout(r.rc.out)) return { verdict: "fail", detail: "too slow on the largest input", compared, ...base, counter: `On the largest input the constraints allow (${r.big.length} characters) the program timed out: it needs a faster algorithm.` };
    const err = r.rc.out.trim().split("\n").filter((l) => /Error|Exception/.test(l)).pop() ?? "it crashed";
    return { verdict: "fail", detail: "crashes on the largest input", compared, ...base, counter: `On the largest input the constraints allow (${r.big.length} characters) the program crashed: ${err.slice(0, 200)}` };
  }
  if (compared >= 5) return { verdict: "pass", detail: `${compared} random inputs agree with the ${source} brute force`, compared, ...base };
  return { verdict: "inconclusive", detail: brute ? `only ${compared} comparable inputs` : "no brute force that passes the examples (time limit checked)", compared, ...base };
}

// ---------------------------------------------------------------- gate (check "stress_pass")
export interface GateResult extends StressResult { keep: boolean; ran: boolean }
/** Whether a candidate is kept. `leaked`: it was written after seeing a failing example. `unverified`: nothing
 *  checked it (no examples, no tests): it is compared with a brute force on small inputs only (no constraints to
 *  build a worst case from) and kept unless they disagree. `fallback`: the caller can escalate (a frontier is
 *  available); without one, inconclusive code is kept. */
export async function gate(ls: Filler, task: CodeTask, code: string, ctx: { leaked: boolean; fallback: boolean; unverified?: boolean; afm?: AFMProvider; brute?: string; opts?: CodeOptions }): Promise<GateResult> {
  const opts = ctx.opts ?? codeOptions();
  const contest = algorithmic(task);
  if (!opts.stress || (!contest && !ctx.leaked && !ctx.unverified)) return { keep: true, ran: false, verdict: "pass", detail: "not gated", compared: 0 };
  const st = await stressTest(ls, task, code, { afm: ctx.afm, reference: opts.reference, brute: ctx.brute, worstCase: contest || ctx.leaked });
  const keep = st.verdict === "pass" || (st.verdict === "inconclusive" && !(ctx.fallback && (ctx.leaked || (contest && opts.escalateInconclusive))));
  return { ...st, keep, ran: true };
}

// ---------------------------------------------------------------- S5: Copilot writes, AFM orchestrates, Codex escalates
export interface CodeResult {
  code: string; route: "copilot" | "copilot-unverified" | "codex-first" | "escalated"; tier?: Tier;
  codex: boolean; examplesOk?: boolean; stress?: string; repairs: number; candidates: number; afmCalls: number; trace: string[];
  notes?: string[];             // pattern ids whose notes Copilot saw
}
/** The frontier's tiers: "cheap" (agent codex-solve-cheap, default GPT-6.1 Terra) and "strong" (codex-solve, default
 *  GPT-6.1 Sol); the models are chosen in Spotlight > Backend > Routing. */
export type Tier = "cheap" | "strong";
/** The S5 graph. `frontier` returns the frontier's code for a tier, or undefined when there is none (offline,
 *  budget spent); `difficulty` is Decima's code-difficulty score (triage only). */
export async function solveCode(task: CodeTask, o: { copilot: Filler; afm?: AFMProvider; difficulty?: number; frontier?: (tier: Tier) => Promise<string | undefined>; opts?: CodeOptions; triage?: Triage }): Promise<CodeResult> {
  const opts = o.opts ?? codeOptions(), d = o.difficulty, trace: string[] = [];
  const fb = !!o.frontier, contest = algorithmic(task), hasExamples = !!task.examples && task.hasExamples !== false;
  let notesInfo: string[] | undefined, afmCalls = 0;
  // escalation up the ladder: the cheap tier's answer is kept when the examples pass, or, with no examples, when it
  // agrees with the local candidate on generated inputs (the stress test with the cheap answer as the reference);
  // otherwise the strong tier answers. With neither check the cheap tier is skipped (its answer could not be judged).
  const escalate = async (route: CodeResult["route"], local: string, rest: Partial<CodeResult>): Promise<CodeResult | undefined> => {
    const done = (code: string, tier: Tier): CodeResult => { trace.push(`escalate:${route} ${tier}`); return { code: code || local, route, tier, codex: true, repairs: 0, candidates: 0, afmCalls, trace, notes: notesInfo, ...rest }; };
    if (opts.cascade && (hasExamples || local.trim())) {
      const cheap = await o.frontier?.("cheap");
      if (cheap === undefined) return undefined;
      if (cheap && hasExamples && (await verifiable(task, cheap)) === true) return done(cheap, "cheap");
      if (cheap && !hasExamples) {
        const x = await stressTest(o.copilot, task, local, { brute: cheap, worstCase: false });
        trace.push(`cross-check:${x.verdict} ${x.detail}`);
        if (x.verdict === "pass") return done(cheap, "cheap");
      } else trace.push(cheap ? "cheap:examples failed" : "cheap:no answer");
    }
    // an empty answer (the frontier failed: usage limit, network) is no escalation: the local code stays, unmarked
    const code = await o.frontier?.("strong");
    return code ? done(code, "strong") : undefined;
  };
  // triage: the same rule as local jobs (a benchmark task is new code; its examples are what can check it)
  if (fb) {
    const easy = contest ? easyContest(task.prompt) : undefined;
    if (easy !== undefined) trace.push(`difficulty:${easy ? "easy" : "not easy"}`);
    const t = await firstWriter({ d, algorithmic: contest, newCode: true, checkable: task.hasExamples !== false, easy, crossCheck: opts.cascade, copilot: async () => true, ...(o.triage ?? (await policyTriage())) });
    if (t.writer === "frontier") { trace.push(`triage:frontier ${t.reason}`); const r = await escalate("codex-first", "", {}); if (r) return r; }
  }
  let notes: string | undefined;
  if (opts.patterns !== "off" && contest && o.afm) {
    const n = await notesFor(o.afm, task.prompt);
    afmCalls += n.afmCalls; notes = n.text || undefined; notesInfo = n.ids;
    trace.push(`notes:${n.ids.join("+") || "none"}`);
  }
  // contest code with a frontier behind it: fewer Copilot candidates (contestCandidates, default 1). A retry must
  // pass the gate anyway (it saw the example), and on the dev runs of 2026-11-06/07 the extra candidates kept a few
  // percent of these tasks local at ~10 s each
  const w = await solveCopilot(o.copilot, task, o.afm, undefined, notes, contest && fb ? Math.max(1, opts.contestCandidates) : 3);
  let cp = w.candidate, ok = w.examplesOk, stress: string | undefined;
  afmCalls += w.afmCalls;
  trace.push(`write:${w.candidates} sample(s) examples=${ok}`);
  if (ok !== false && cp) {
    // unchecked code (no examples) is compared with a brute force too, when a frontier can take what fails
    const unverified = ok === undefined;
    const g = unverified && !fb ? undefined : await gate(o.copilot, task, cp.code, { leaked: w.repairs > 0, fallback: fb, unverified, afm: o.afm, opts });
    afmCalls += g?.afmCalls ?? 0;
    if (g?.ran) { stress = g.verdict; trace.push(`gate:${g.verdict} ${g.detail}`); }
    if (g?.verdict === "fail" && !fb) {
      // repair (no frontier to take it over): once, with the counterexample; it saw the failure, so only a gate
      // pass keeps it. With a frontier the failure goes there at once: in S5 runs the repair rarely held
      // (3721 fixed once; 3744's repair passed the gate and still failed the hidden tests)
      const retry = await copilotCandidate(o.copilot, task, g.counter);
      const g2 = retry && (await verifiable(task, retry.code)) === true ? await gate(o.copilot, task, retry.code, { leaked: true, fallback: fb, afm: o.afm, brute: g.brute, opts }) : undefined;
      if (g2) afmCalls += g2.afmCalls ?? 0;
      trace.push(`repair:${g2 ? g2.verdict : "no candidate"}`);
      if (g2?.keep) { cp = retry; stress = `fixed:${g2.verdict}`; } else ok = false;
    } else if (g && !g.keep) ok = false;
  }
  const rest = { examplesOk: ok, stress, repairs: w.repairs, candidates: w.candidates, afmCalls, notes: notesInfo };
  if (ok === true && cp) { cp.accept(); return { code: cp.code, route: "copilot", codex: false, trace, ...rest }; }
  if (ok === undefined && cp && !(fb && opts.cascade && stress !== "pass")) { trace.push("keep:unverified"); return { code: cp.code, route: "copilot-unverified", codex: false, trace, ...rest }; }
  return (await escalate("escalated", cp?.code ?? "", rest)) ?? { code: cp?.code ?? "", route: "copilot", codex: false, trace, ...rest };
}

// ---------------------------------------------------------------- S1: AFM first, Copilot, then the caller's frontier
export interface AdaptiveResult extends LocalResult { stage: "first" | "extra" | "copilot"; genMs?: number; checkMs?: number; stress?: string }
/** One AFM attempt (format gate + examples); for contest code the gate too. When it fails, Copilot's loop; when
 *  that fails and `extra` is allowed, more AFM candidates and one repair (the v2 pipeline, seeded).
 *  fast (online, a frontier fallback exists): no format-fix retry, a failed load escalates at once. */
export async function solveAdaptive(afm: AFMProvider, task: CodeTask, o: { extra: boolean; fast?: boolean; plan?: boolean; copilot?: Filler; fallback?: boolean; opts?: CodeOptions }): Promise<AdaptiveResult> {
  const opts = o.opts ?? codeOptions(), fallback = o.fallback ?? true;
  let afmCalls = 1;
  const t0 = Date.now();
  let g = await generate(afm, task, 0, "", o.plan ?? true);
  let genMs = Date.now() - t0;
  if (!g.ok || !g.code.trim()) return { code: "", candidates: 0, agreement: 0, consensus: false, repairs: 0, unverifiable: true, afmCalls, stage: "first", genMs };
  let f = await formatGate(task, g.code);
  if (!f.ok && !o.fast) { const t1 = Date.now(); const g2 = await generate(afm, task, 0, `\n\nYOUR PREVIOUS CODE FAILED TO LOAD:\n${f.out.slice(-800)}\nFix it.`, o.plan ?? true); genMs += Date.now() - t1; afmCalls++; if (g2.ok) { g = g2; f = await formatGate(task, g.code); } }
  const t2 = Date.now();
  const examplesOk = f.ok ? await verifiable(task, g.code) : (task.examples?.(g.code) ? false : undefined);
  const checkMs = Date.now() - t2;
  // the gate needs Copilot for the generators, so local-only settings (S2/S3) are unchanged
  let firstOk = examplesOk, brute: string | undefined, stress: string | undefined, counter: string | undefined;
  if (examplesOk === true && o.copilot) {
    const st = await gate(o.copilot, task, g.code, { leaked: false, fallback, afm, opts });
    afmCalls += st.afmCalls ?? 0; brute = st.brute;
    if (st.ran) stress = `afm:${st.verdict}`;
    if (!st.keep) { firstOk = false; counter = st.counter; }
  }
  const first: AdaptiveResult = { code: g.code, candidates: 1, examplesOk: firstOk, agreement: 1, consensus: false, repairs: 0, unverifiable: examplesOk === undefined, afmCalls, stage: "first", genMs, checkMs, stress };
  if (firstOk === false && o.copilot) {
    const t3 = Date.now();
    const w = await solveCopilot(o.copilot, task, afm, counter);
    first.afmCalls += w.afmCalls;
    const cp = w.candidate;
    if (cp && w.examplesOk === true) {
      const st = await gate(o.copilot, task, cp.code, { leaked: w.repairs > 0 || !!counter, fallback, afm, brute, opts });
      first.afmCalls += st.afmCalls ?? 0;
      if (st.ran) first.stress = `${stress ? stress + "," : ""}copilot:${st.verdict}`;
      if (st.keep) { cp.accept(); return { ...first, code: cp.code, examplesOk: true, candidates: 1 + w.candidates, repairs: w.repairs, stage: "copilot", genMs: genMs + (Date.now() - t3) }; }
    }
  }
  if (firstOk !== false || !o.extra) return first;
  const r = await solveLocal(afm, task, { k: 3, repairs: 1, seed: [{ code: g.code, formatOk: f.ok }], afmCalls });
  return { ...r, stage: "extra", genMs, checkMs };
}

// ---------------------------------------------------------------- local jobs: the gate on a code step
/** The gate for a Python function a local job's Copilot step wrote: the request is the statement, the function's
 *  signature and docstring the starter code, and the file (with the project on its import path) the candidate.
 *  Gated: contest-style requests, code written after a failed check (leaked), and new code in a project with no
 *  tests (unverified). Returns undefined when not gated. */
export async function gateJobCode(ls: Filler, a: { request: string; work: string; abs: string; fn: string; leaked: boolean; fallback: boolean; unverified?: boolean; opts?: CodeOptions }): Promise<GateResult | undefined> {
  const opts = a.opts ?? codeOptions();
  if (!opts.stress || !a.abs.endsWith(".py") || !(a.leaked || a.unverified || algorithmic({ prompt: a.request }))) return undefined;
  const text = readFileSync(a.abs, "utf8");
  const def = new RegExp(`^def ${a.fn}\\b[^\\n]*\\n(?:[ \\t]+("""|''')[\\s\\S]*?\\1[ \\t]*\\n)?`, "m").exec(text);
  if (!def) return undefined;
  const pre = `import sys\nsys.path.insert(0, ${JSON.stringify(a.work)})\n`;
  const task: CodeTask = { prompt: `${a.request}\n\n${def[0]}`, kind: "function", entry: a.fn, exec: (prog, stdin) => runPython(pre + prog, stdin ?? "") };
  // the module as a library: its main block would read input or run the program on every call
  const code = text.replace(/^if\s+__name__\s*==\s*["']__main__["']\s*:/m, "if False:");
  // a file that does not load on its own (a package-relative import, a missing dependency) cannot be run by the
  // gate: not gated, rather than failed
  if (!(await task.exec(code)).ok) return undefined;
  return gate(ls, task, code, { leaked: a.leaked, fallback: a.fallback, unverified: a.unverified, opts: { ...opts, escalateInconclusive: false } });
}
