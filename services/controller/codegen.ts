// Local code generation sized for the on-device model, with an uncertainty signal for routing.
// Used by the benchmark harness (S2/S3/S1) and available to local jobs. Built from failure *patterns*
// of the 2026-10-30 evaluation (docs/improvement-plan-2026-10-31.md), tuned on dev splits only.
//   1. approach-first generation: schema order approach → edge_cases → body (guided generation fills in order)
//   2. format gate: every candidate must compile and load; one fix attempt with the error
//   3. k candidates: greedy + temperature samples with varied instructions
//   4. selection: statement examples first, then agreement on AFM-proposed extra inputs (differential testing,
//      no oracle) — the size of the agreeing group is the confidence signal used for escalation
//   5. diagnosis-first repair with the failing example
import type { AFMProvider } from "../afm-adapter/provider.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { fill, type Filler } from "../frontier/copilot-ls.ts";

export interface Run { ok: boolean; out: string }
export interface CodeTask {
  prompt: string;
  kind: "function" | "program";
  entry?: string;               // function name (function tasks)
  invoke?: string;              // call template for differential runs, "_f(*_a)" with _f = entry; e.g. "Solution().foo(*_a)"
  examples?: (code: string) => Promise<Run> | undefined;   // statement examples (never hidden tests)
  hasExamples?: boolean;        // known up front: the statement has runnable examples
  exec: (program: string, stdin?: string) => Promise<Run>; // sandboxed runner supplied by the caller
}
export interface Candidate { code: string; examplesOk?: boolean; signature?: string; formatOk: boolean }
export interface LocalResult { code: string; candidates: number; examplesOk?: boolean; agreement: number; consensus: boolean; repairs: number; unverifiable: boolean; afmCalls: number }

const BODY = (withPlan: boolean) => ({
  type: "object" as const,
  properties: {
    ...(withPlan ? { approach: { type: "array" as const, items: { type: "string" as const }, description: "2-5 numbered steps of the algorithm" },
                     edge_cases: { type: "array" as const, items: { type: "string" as const }, description: "Inputs that need special care (empty, single item, duplicates, negatives, bounds)" } } : {}),
    imports: { type: "array" as const, items: { type: "string" as const }, description: "Import lines the code needs, or empty" },
    body: { type: "array" as const, items: { type: "string" as const }, description: "The code, one array item per source line with indentation" },
  },
  required: [...(withPlan ? ["approach", "edge_cases"] : []), "imports", "body"],
  additionalProperties: false,
});

const VARIANTS = [
  "Follow the approach exactly; handle every edge case you listed.",
  "Re-read the task statement carefully; prefer the simplest correct algorithm.",
  "Check the examples in the statement against your plan before writing code.",
  "Think about off-by-one errors and empty inputs before writing code.",
  "Use clear, straightforward Python; avoid clever shortcuts.",
];

/** Turn AFM's body lines into a full program for the task. */
export function assemble(task: CodeTask, j: any): string {
  const lines: string[] = j.body ?? [];
  const strip = (s: string) => s.replace(/^```\w*\n|\n?```\s*$/g, "");
  if (task.kind === "function" && task.entry && !new RegExp(`def\\s+${task.entry}\\b`).test(lines.join("\n"))) {
    const first = lines.find((l) => l.trim()) ?? "";
    const shift = /^\s/.test(first) ? "" : "    ";
    return `${(j.imports ?? []).join("\n")}\n${task.prompt}${lines.map((l) => (l.trim() ? shift + l : l)).join("\n")}\n`;
  }
  return strip(`${(j.imports ?? []).join("\n")}\n${lines.join("\n")}\n`);
}

export async function generate(afm: AFMProvider, task: CodeTask, i: number, extra = "", plan = true): Promise<{ code: string; ok: boolean }> {
  const how = task.kind === "function" ? "Complete the function: write its body (and helpers inside it if needed)." : "Write a complete Python program for the task.";
  const r = await afm.generate({
    system: `You are an expert Python programmer. ${how} First plan the approach and edge cases, then write the code. ${VARIANTS[i % VARIANTS.length]}`,
    user: task.prompt + extra, schema: BODY(plan), maxTokens: 1600, timeoutMs: 90_000, temperature: i === 0 ? 0 : 0.7,
  });
  if (!r.ok) return { code: "", ok: false };
  return { code: assemble(task, r.json), ok: true };
}

/** Compile + load check (no tests): catches syntax/indent/import/name slips. */
export async function formatGate(task: CodeTask, code: string): Promise<Run> {
  const probe = task.kind === "function" && task.entry ? `${code}\n\n_ = ${task.entry}\n` : `import ast\nast.parse(${JSON.stringify(code)})\n`;
  return task.exec(probe);
}

/** AFM proposes extra inputs (inputs only — no expected outputs, so no oracle is needed). */
async function extraInputs(afm: AFMProvider, task: CodeTask, n = 6): Promise<string[]> {
  const what = task.kind === "function"
    ? "Python argument tuples for calling the function, e.g. \"([1, 2, 3], 2)\" — include edge cases"
    : "Complete standard-input texts for the program, small sizes — include edge cases";
  const r = await afm.generate({ system: `Propose ${n} diverse, valid test inputs for the task (inputs only, no outputs). Each item: ${what}.`, user: task.prompt, maxTokens: 700, timeoutMs: 60_000,
    schema: { type: "object", properties: { inputs: { type: "array", items: { type: "string" } } }, required: ["inputs"], additionalProperties: false } });
  return r.ok ? ((r.json as any).inputs ?? []).filter((s: string) => typeof s === "string" && s.trim()).slice(0, n) : [];
}

/** Output signature of a candidate on the extra inputs (errors included), used to find agreeing candidates. */
async function signature(task: CodeTask, code: string, inputs: string[]): Promise<string> {
  if (!inputs.length) return "";
  if (task.kind === "function" && task.entry) {
    const call = (task.invoke ?? "_f(*_a)").replace("_f", task.entry);
    const prog = `${code}\n\nimport sys\nsys.setrecursionlimit(10000)\nfor _src in ${JSON.stringify(inputs)}:\n    try:\n        _a = eval(_src)\n        _a = _a if isinstance(_a, tuple) else (_a,)\n        print(repr(${call})[:300])\n    except Exception as _e:\n        print("ERR:" + type(_e).__name__)\n`;
    const r = await task.exec(prog);
    return r.out.trim();
  }
  const outs: string[] = [];
  for (const inp of inputs) { const r = await task.exec(code, inp.endsWith("\n") ? inp : inp + "\n"); outs.push(r.ok ? r.out.trim().slice(0, 300) : "ERR"); }
  return outs.join("\n---\n");
}

async function repair(afm: AFMProvider, task: CodeTask, code: string, feedback: string): Promise<string> {
  const r = await afm.generate({
    system: "You fix Python code. First diagnose the bug from the failing example (what the code does vs what is expected), then give the corrected code.",
    user: `${task.prompt}\n\nCURRENT CODE:\n${code}\n\nFAILING EXAMPLE:\n${feedback.slice(-1500)}`, maxTokens: 1600, timeoutMs: 90_000,
    schema: { type: "object", properties: { diagnosis: { type: "string" }, ...BODY(false).properties }, required: ["diagnosis", "imports", "body"], additionalProperties: false },
  });
  return r.ok ? assemble(task, r.json) : code;
}

export interface LocalOptions { k?: number; repairs?: number; seed?: Candidate[]; afmCalls?: number }

export async function solveLocal(afm: AFMProvider, task: CodeTask, o: LocalOptions = {}): Promise<LocalResult> {
  const k = o.k ?? 3;
  let afmCalls = o.afmCalls ?? 0;
  const cands: Candidate[] = [...(o.seed ?? [])];
  for (let i = cands.length; i < k; i++) {
    let g = await generate(afm, task, i); afmCalls++;
    if (!g.ok || !g.code.trim()) continue;
    let f = await formatGate(task, g.code);
    if (!f.ok) { const g2 = await generate(afm, task, i, `\n\nYOUR PREVIOUS CODE FAILED TO LOAD:\n${f.out.slice(-800)}\nFix it.`); afmCalls++; if (g2.ok) { g = g2; f = await formatGate(task, g.code); } }
    cands.push({ code: g.code, formatOk: f.ok });
  }
  if (!cands.length) return { code: "", candidates: 0, agreement: 0, consensus: false, repairs: 0, unverifiable: true, afmCalls };
  const usable = cands.filter((c) => c.formatOk).length ? cands.filter((c) => c.formatOk) : cands;
  for (const c of usable) { const ex = task.examples?.(c.code); if (ex) c.examplesOk = (await ex).ok; }
  const unverifiable = usable.every((c) => c.examplesOk === undefined);
  const inputs = await extraInputs(afm, task); afmCalls++;
  for (const c of usable) c.signature = await signature(task, c.code, inputs);
  const groups = new Map<string, number>();
  for (const c of usable) if (c.signature) groups.set(c.signature, (groups.get(c.signature) ?? 0) + 1);
  const support = (c: Candidate) => (c.signature ? groups.get(c.signature) ?? 1 : 1);
  usable.sort((a, b) => Number(!!b.examplesOk) - Number(!!a.examplesOk) || support(b) - support(a));
  let best = usable[0];
  let repairs = 0;
  // Diagnosis-first repair when no candidate passes the statement's examples.
  for (; repairs < (o.repairs ?? 1) && best.examplesOk === false; repairs++) {
    const fb = (await task.examples!(best.code))!.out;
    const fixed = await repair(afm, task, best.code, fb); afmCalls++;
    const ok = (await task.examples!(fixed))?.ok;
    if (ok) best = { code: fixed, formatOk: true, examplesOk: true, signature: await signature(task, fixed, inputs) };
  }
  const agreement = best.signature ? (groups.get(best.signature) ?? 1) / usable.length : 1 / usable.length;
  const consensus = (best.examplesOk !== false) && agreement >= 2 / 3 && usable.length >= 2;
  return { code: best.code, candidates: usable.length, examplesOk: best.examplesOk, agreement, consensus, repairs, unverifiable, afmCalls };
}

// ---------------------------------------------------------------- v3: adaptive effort
// v2 spent 5-8 AFM calls on every task. Dev splits showed the extra work pays off only for function tasks
// with runnable examples (HumanEval dev 17% -> 50%); on contest-style problems (LCB dev 6/30 either way),
// tasks without examples, and tasks Decima rates hard (local 2/18) it only added 60-90 s. v3 makes one attempt
// first and adds candidates only where they helped.

/** Contest-style or algorithmic code: one test for a benchmark task (stdin program, LeetCode class, a
 *  "Constraints:" section) and for a free-text request ("shortest path", "O(n log n)", "백준"). The local
 *  model's measured weak spot (LCB 0/20 medium and hard), and where passing the examples is weakest evidence. */
const ALGO_WORDS = /(알고리즘|algorithm|시간\s?복잡도|time complexity|O\([^)]*n[^)]*\)|동적\s?계획|dynamic programming|\bDP\b|최단\s?경로|shortest path|그래프 (탐색|알고리즘)|graph (search|traversal)|이진\s?탐색|binary search|백트래킹|backtracking|코딩\s?테스트|leetcode|백준|competitive programming|constraints?:)/i;
export function algorithmic(task: { prompt: string; kind?: CodeTask["kind"]; invoke?: string }): boolean {
  return task.kind === "program" || /Solution\(\)/.test(task.invoke ?? "") || /^\s*Constraints?\s*:?\s*$/im.test(task.prompt) || ALGO_WORDS.test(task.prompt);
}

/** New code requested from a description (a function, class or module to write), as opposed to edits. */
export function newCodeRequest(prompt: string): boolean {
  return /((함수|클래스|메서드|모듈|function|class|method|module).{0,30}(구현|작성|만들|implement|write|create)|\b(implement|write|create|add)\s+(an?\s+|the\s+)?(new\s+)?(function|class|method|module)|구현해\s?(줘|주세요))/i.test(prompt);
}

export async function verifiable(task: CodeTask, code: string): Promise<boolean | undefined> {
  const ex = task.examples?.(code);
  return ex ? (await ex).ok : undefined;
}

/** Copilot's code for a task: a function body after the given signature and docstring, or a whole program after the
 *  statement written as comments (how Copilot is used in an editor). */
export async function copilotCandidate(ls: Filler, task: CodeTask, hint?: string, style?: "brute", o: { rounds?: number; approach?: string } = {}): Promise<{ code: string; accept: () => void } | undefined> {
  const path = join(tmpdir(), "onbud-copilot", `${task.entry ?? "main"}${style ? "_brute" : ""}.py`);
  const cm = (t: string) => t.split("\n").map((l) => `# ${l}`.trimEnd()).join("\n") + "\n";
  // hint: why the previous code failed, as comments above the code (what a user would leave for Copilot); for the
  // stress test's reference, a note asking for the plainest correct version.
  // Keep the input and expected output at the start of feedback, not just the tail of a traceback.
  const note = (hint ? "# A previous version failed:\n" + cm(hint.trim().slice(0, 2400)) : "")
    + (o.approach ? "# Approach to check against the statement (not a specification):\n" + cm(o.approach) : "")
    + (style === "brute" ? "# Brute force: the simplest correct solution, trying every possibility. Inputs will be tiny; speed does not matter.\n" : "");
  // The file as a user would have it open: the statement as comments, then the code to continue — the given
  // signature (a prompt that is code already, or the code after the statement), or for a program a main() that
  // reads standard input, called below the cursor.
  const lines = task.prompt.replace(/\s*$/, "").split("\n");
  const codeAt = /^\s*(def |class |from |import |@|"""|#)/.test(lines.find((l) => l.trim()) ?? "") ? 0 : lines.findIndex((l) => /^(class |def |from |import |@)/.test(l));
  let head: string, suffix = "\n";
  if (task.kind === "function" && codeAt >= 0) {
    const prose = lines.slice(0, codeAt).join("\n").replace(/\n*Starter code:\s*$/i, "").trim();
    const code = lines.slice(codeAt).join("\n");
    const last = lines.at(-1)!;
    head = (prose ? cm(prose) + "\n" : "") + note + code + "\n" + (/:\s*$/.test(last) ? (/^\s*/.exec(last)![0] + "    ") : "");
  } else {
    head = cm(task.prompt.trim()) + note + "\nimport sys\n\n\ndef main():\n    ";
    suffix = "\n\n\nif __name__ == \"__main__\":\n    main()\n";
  }
  const r = await fill(ls, path, "python", head, suffix, o.rounds ?? (task.kind === "function" ? 4 : 8));
  if (!r.text.trim()) return undefined;
  const code = head + r.text + (suffix.trim() ? suffix : "");
  return { code: note ? code.replace(note, "") : code, accept: () => r.items.forEach((it) => ls.accept(it)) };
}

/** More writing effort only after a failed example. The first completion stays unchanged for simple functions;
 *  the last attempt gets an independent local reading of the statement, not another code-writing model. */
/** notes: approach notes from the pattern dictionary (code-patterns.ts), above the code of every sample. */
export async function solveCopilot(ls: Filler, task: CodeTask, afm?: AFMProvider, initialHint?: string, notes?: string, maxCandidates = 3): Promise<{
  candidate?: Awaited<ReturnType<typeof copilotCandidate>>; examplesOk?: boolean;
  repairs: number; candidates: number; afmCalls: number; requests: number;
}> {
  let requests = 0, candidates = 0, repairs = 0, afmCalls = 0;
  // Bound actual inline requests, including continuation chunks and empty suggestions, across all samples.
  const bounded: Filler = {
    complete: async (...args) => requests < 10 ? (requests++, ls.complete(...args)) : undefined,
    accept: (item) => ls.accept(item), close: (path) => ls.close(path),
  };
  let candidate: Awaited<ReturnType<typeof copilotCandidate>>, examplesOk: boolean | undefined, feedback = "";
  for (let i = 0; i < maxCandidates && requests < 10; i++) {
    let approach: string | undefined;
    if (i === 2 && afm) {
      afmCalls++;
      const r = await afm.generate({
        system: "Plan a Python solution from the statement. Do not write code. State the algorithm, the invariant that makes it correct, and its time complexity within the constraints. Read the rules literally; check the public example but do not special-case it. The previous attempt may have used the wrong algorithm.",
        user: `${task.prompt}\n\nPrevious attempt's example feedback:\n${feedback.slice(0, 2400)}`,
        schema: { type: "object", properties: { approach: { type: "string" }, invariant: { type: "string" }, complexity: { type: "string" } }, required: ["approach", "invariant", "complexity"], additionalProperties: false },
        maxTokens: 450, timeoutMs: 60_000,
      });
      if (r.ok) approach = ["approach", "invariant", "complexity"].map((k) => (r.json as any)?.[k]).filter((s) => typeof s === "string").join("\n").slice(0, 2400);
    }
    const hint = i === 0 ? initialHint : `${feedback}\nRe-read the statement and derive a correct algorithm before implementing. Check the input above gives the expected output; do not patch only that example.`;
    const cp = await copilotCandidate(bounded, task, hint, undefined, { approach: [notes, approach].filter(Boolean).join("\n\n") || undefined });
    candidates++; repairs = i;
    const ex = cp ? await task.examples?.(cp.code) : undefined;
    if (cp && ex?.ok !== false) return { candidate: cp, examplesOk: ex?.ok, repairs, candidates, afmCalls, requests };
    if (!candidate && cp) { candidate = cp; examplesOk = ex?.ok; }
    feedback = ex?.out ?? "No implementation was completed. Write the complete solution.";
  }
  return { candidate, examplesOk, repairs, candidates, afmCalls, requests };
}

// The stress test, the gate policy and the adaptive/S5 graphs that use these generators: code-skill.ts.
