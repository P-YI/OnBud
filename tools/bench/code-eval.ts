// Code-generation benchmarks for the framework settings (HumanEval, LiveCodeBench sample, BigCodeBench-Hard stdlib subset).
//   raw  one AFM call, greedy — the protocol of published pass@1 numbers (comparable to other models)
//   s2   AFM + local tools: run the examples given in the problem text (never the hidden tests), one repair with the error
//   s3   s2 + Decima: when Decima rates the problem frontier-level (≥ 0.6), allow a second repair
//   s1   s3 + Codex (GPT-6.1 Sol via the read-only hand-off agent) when the local self-check still fails
// Generated code runs only under sandbox-exec: no network, writes only inside a temp dir, 10 s timeout.
// usage: node --experimental-strip-types --experimental-sqlite tools/bench/code-eval.ts --bench humaneval --mode raw --n 20 [--offset 0]

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runPython, type Run } from "../../services/controller/sandbox.ts";
import { ApfelProvider } from "../../services/afm-adapter/apfel.ts";
import { DecimaClient, codeDifficulty } from "../../services/laya-router/decima.ts";
import { algorithmic, solveLocal, type CodeTask } from "../../services/controller/codegen.ts";

const args = process.argv.slice(2);
process.env.ONBUD_BENCH = "1";   // marks controller log records from this run as benchmark
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BENCH = opt("--bench", "humaneval"), MODE = opt("--mode", "raw"), N = Number(opt("--n", "1000")), OFFSET = Number(opt("--offset", "0"));
const IDS = opt("--ids", "");                       // subset file (tools/bench/subsets/*.json) — same ids for every setting
let codexBudget = Number(opt("--codex-budget", "60")); // hard cap on Codex calls per run (cost control)
const TAG = opt("--tag", "");
const UNVERIFIABLE = opt("--unverifiable", "decima");   // decima | escalate
const TEMP = Number(opt("--temp", "0"));                // AFM sampling temperature for raw/v1 generation (temperature check)
// OpenCode agent for Codex calls: codex-handoff (read-only tools, as in v1–v3) or codex-solve (no tools, short prompt).
// The lean agent for every setting (2026-11-07): the default used to depend on the tag ("v4…"), and runs tagged
// otherwise (v0.2.0's "v5") sent part of their calls through codex-handoff, inflating their cost.
const FRONTIER_AGENT = opt("--frontier-agent", "codex-solve");
// the code skill's cheap tier (checked before it is kept; the strong tier is FRONTIER_AGENT)
const CHEAP_AGENT = opt("--cheap-agent", "codex-solve-cheap");
// v4 S1: the first local attempt skips the approach/edge-case fields (dev: same 28/30, escalations 16.2 → 11.7 s);
// --plan keeps them (the "v4dev" run), --no-plan was the flag of the "v4npdev" run.
const NO_PLAN = TAG.startsWith("v4") && opt("--mode", "raw") === "s1" ? !args.includes("--plan") : args.includes("--no-plan");
let callTokens: { input: number; output: number; reasoning: number; cacheRead: number; agent?: string }[] = [];   // Codex usage, per problem
const DIR = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "bench", "code");
const afm = new ApfelProvider({ defaultTimeoutMs: 90_000 });
const decima = new DecimaClient({ mode: "advise" });

interface Problem { task?: () => CodeTask; key?: string; id: string; prompt: string; check: (code: string) => Promise<Run>; examples: (code: string) => Promise<Run> | undefined; entry?: string; lang: "py" }

// ---------------------------------------------------------------- sandboxed execution (services/controller/sandbox.ts)
const sandboxRun = runPython;
// LiveCodeBench's harness runs every solution after these imports.
const LCB_PREFIX = "from string import *\nfrom re import *\nfrom datetime import *\nfrom collections import *\nfrom heapq import *\nfrom bisect import *\nfrom copy import *\nfrom math import *\nfrom random import *\nfrom statistics import *\nfrom itertools import *\nfrom functools import *\nfrom operator import *\nfrom io import *\nfrom sys import *\nfrom json import *\nfrom builtins import *\nfrom typing import *\nimport string, re, datetime, collections, heapq, bisect, copy, math, random, statistics, itertools, functools, operator, io, sys, json\nsys.setrecursionlimit(50000)\n";

// ---------------------------------------------------------------- benchmarks
const jsonl = (f: string) => readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function doctestExamples(prompt: string, entry: string): string[] {
  const out: string[] = [];
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*>>>\s*(.+)$/.exec(lines[i]);
    if (m && m[1].includes(entry) && lines[i + 1] && !/^\s*>>>/.test(lines[i + 1]) && lines[i + 1].trim()) out.push(`assert ${m[1].trim()} == ${lines[i + 1].trim()}, ${JSON.stringify(m[1].trim())}`);
  }
  // Other example styles in problem statements: "f(x) ➞ y", "f(x) ==> y", "f(x) == y", "f(x) -> y", "f(x) should return y".
  const call = new RegExp(`(${entry}\\((?:[^()]|\\([^()]*\\))*\\))\\s*(?:➞|==>|=>|==|->|→|should (?:return|be)|returns?)\\s*([^\\n]+)`, "g");
  for (const m of prompt.matchAll(call)) {
    const lineStart = prompt.lastIndexOf("\n", m.index ?? 0) + 1;
    if (/^\s*def\s/.test(prompt.slice(lineStart, m.index)) || /\w\s*:\s*\w/.test(m[1]) || /:\s*$/.test(m[2])) continue;   // the signature line, not an example
    const want = m[2].trim().replace(/[.,;]$/, "").replace(/^(?:True|False)\b.*$/, (x) => x.split(/\s/)[0]);
    // Only plain literals as expected values (prose like "19 - 5 - 6 = 8" is not an example to assert).
    const literal = /^(-?\d+(\.\d+)?|True|False|None|'[^']*'|"[^"]*"|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})$/.test(want);
    if (want && literal && !out.some((o) => o.includes(m[1]))) out.push(`assert ${m[1]} == ${want}, ${JSON.stringify(m[1])}`);
  }
  return out.slice(0, 6);
}

// ml: the repository's own ML implementation tasks (make-ml-impl.py), in HumanEval format.
function humaneval(rows: any[] = jsonl("humaneval.jsonl")): Problem[] {
  return rows.map((p: any) => ({
    key: p.task_id, id: p.task_id, prompt: p.prompt, entry: p.entry_point, lang: "py",
    task: () => ({ prompt: p.prompt, kind: "function", entry: p.entry_point, hasExamples: doctestExamples(p.prompt, p.entry_point).length > 0, exec: (prog: string, stdin?: string) => sandboxRun(prog, stdin ?? ""),
      examples: (code: string) => { const ex = doctestExamples(p.prompt, p.entry_point); return ex.length ? sandboxRun(`${code}\n\n${ex.join("\n")}\n`) : undefined; } }),
    check: (code: string) => sandboxRun(`${code}\n\n${p.test}\n\ncheck(${p.entry_point})\n`),
    examples: (code: string) => { const ex = doctestExamples(p.prompt, p.entry_point); return ex.length ? sandboxRun(`${code}\n\n${ex.join("\n")}\n`) : undefined; },
  }));
}

function lcbRunner(p: any, tests: any[]): (code: string) => Promise<Run> {
  const functional = p.metadata?.func_name;
  return async (code: string) => {
    for (const t of tests.slice(0, 30)) {
      if (functional) {
        const call = `\nimport json\n_args=[json.loads(x) for x in ${JSON.stringify(t.input)}.split("\\n") if x.strip()]\n_r=Solution().${p.metadata.func_name}(*_args)\nprint(json.dumps(_r))\n`;
        const r = await sandboxRun(LCB_PREFIX + code + call);
        const parse = (x: string) => { try { return JSON.stringify(JSON.parse(x)); } catch { return `!${x}`; } };
        if (!r.ok || parse(r.out.trim().split("\n").pop() || "null") !== parse(String(t.output).trim())) return { ok: false, out: `input ${String(t.input).slice(0, 200)}\nexpected ${String(t.output).slice(0, 200)}\ngot ${r.out.slice(-400)}` };
      } else {
        const r = await sandboxRun(LCB_PREFIX + code, t.input);
        if (!r.ok || r.out.trim() !== String(t.output).trim()) return { ok: false, out: `input ${String(t.input).slice(0, 200)}\nexpected ${String(t.output).slice(0, 200)}\ngot ${r.out.slice(-400)}` };
      }
    }
    return { ok: true, out: "all tests passed" };
  };
}
function lcb(): Problem[] {
  return jsonl("lcb.jsonl").map((p: any) => ({
    key: p.id, id: `${p.id} (${p.difficulty})`, lang: "py",
    task: () => ({ prompt: `${p.content}\n\n${p.starter ? `Starter code:\n${p.starter}` : "Read from standard input and write to standard output."}`,
      kind: p.metadata?.func_name ? "function" : "program", entry: p.metadata?.func_name, invoke: "Solution()._f(*_a)", hasExamples: p.public.length > 0,
      exec: (prog: string, stdin?: string) => sandboxRun(LCB_PREFIX + prog, stdin ?? ""), examples: (code: string) => lcbRunner(p, p.public)(code) }),
    prompt: `${p.content}\n\n${p.starter ? `Starter code:\n${p.starter}` : "Read from standard input and write to standard output."}`,
    check: lcbRunner(p, [...p.public, ...p.private]),
    examples: (code: string) => lcbRunner(p, p.public)(code),
  }));
}

function bcbHard(): Problem[] {
  const std = new Set(["os", "sys", "re", "json", "math", "random", "collections", "itertools", "functools", "datetime", "time", "string", "csv", "io", "hashlib", "base64", "subprocess", "shutil", "glob", "pathlib", "statistics", "heapq", "bisect", "struct", "zlib", "gzip", "zipfile", "tarfile", "tempfile", "textwrap", "unicodedata", "operator", "typing", "copy", "enum", "uuid", "socket", "ftplib", "smtplib", "email", "urllib", "http", "html", "xml", "sqlite3", "logging", "codecs", "binascii", "secrets", "decimal", "fractions", "array", "queue", "threading", "multiprocessing", "ast", "inspect", "types", "pickle", "difflib", "calendar", "locale", "platform", "getpass", "configparser", "argparse", "ssl", "select", "signal", "errno", "ctypes", "fnmatch", "mimetypes", "wave", "cmath", "pprint", "traceback", "warnings", "weakref", "contextlib", "abc", "dataclasses", "numbers", "hmac", "ipaddress", "smtpd", "telnetlib", "cgi", "imaplib", "poplib", "nntplib", "webbrowser", "shlex", "unittest"]);
  const libsOf = (s: any) => (Array.isArray(s) ? s : JSON.parse(String(s).replace(/'/g, '"')));
  const stdAll = new Set(readFileSync(new URL("./stdlib-modules.txt", import.meta.url), "utf8").split(/\s+/).filter(Boolean));
  return jsonl(BENCH === "bcb-full" ? "bcb-full.jsonl" : "bcb-hard.jsonl").filter((p: any) => libsOf(p.libs).every((l: string) => stdAll.has(l) || std.has(l))).map((p: any) => ({
    key: p.task_id, id: p.task_id, prompt: p.complete_prompt, entry: p.entry_point, lang: "py",
    task: () => ({ prompt: p.complete_prompt, kind: "function", entry: p.entry_point, hasExamples: false, exec: (prog: string, stdin?: string) => sandboxRun(prog, stdin ?? "", 30_000), examples: () => undefined }),
    check: (code: string) => sandboxRun(`${code}\n\n${p.test}\n\nimport unittest\nunittest.main(argv=["x"], exit=True)\n`, "", 30_000),
    examples: () => undefined,
  }));
}

// ---------------------------------------------------------------- generation
// Code as an array of lines: inside one JSON string AFM sometimes drops the newlines (a whole function on one line).
const CODE_SCHEMA = { type: "object" as const, properties: { lines: { type: "array" as const, items: { type: "string" as const }, description: "The complete Python code, one array item per source line, with its indentation" } }, required: ["lines"], additionalProperties: false };
const strip = (s: string) => s.replace(/^```\w*\n|\n?```\s*$/g, "");
// Function tasks (HumanEval, BigCodeBench): the official protocol is prompt + completion, so AFM writes only the
// body lines (plus helper code after it if needed) and the prompt's signature/docstring stays untouched.
const BODY_SCHEMA = { type: "object" as const, properties: {
  imports: { type: "array" as const, items: { type: "string" as const }, description: "Extra import lines needed by the body, or empty" },
  body: { type: "array" as const, items: { type: "string" as const }, description: "The function body: every line of the implementation, each indented by 4 spaces. At least 2 lines" } },
  required: ["imports", "body"], additionalProperties: false };
async function generate(p: Problem, feedback?: string, previous?: string): Promise<string> {
  const fix = `${previous ? `\n\nYOUR PREVIOUS CODE:\n${previous}` : ""}${feedback ? `\n\nIT FAILED ON THE EXAMPLES:\n${feedback.slice(-1500)}\nFix it.` : ""}`;
  if (p.entry) {
    const r = await afm.generate({ system: "You are an expert Python programmer. Complete the function: write its body so it is correct for every case described.", user: p.prompt + fix, schema: BODY_SCHEMA, maxTokens: 1500, timeoutMs: 90_000, temperature: TEMP });
    if (!r.ok) return "";
    const j = r.json as any;
    // Indent the whole body consistently: if AFM wrote it from column 0, shift every line by 4 spaces.
    const lines: string[] = j.body ?? [];
    const first = lines.find((l) => l.trim()) ?? "";
    const shift = /^\s/.test(first) ? "" : "    ";
    const body = lines.map((l) => (l.trim() ? shift + l : l)).join("\n");
    return `${(j.imports ?? []).join("\n")}\n${p.prompt}${body}\n`;
  }
  const r = await afm.generate({ system: "You are an expert Python programmer. Write a correct, complete program for the task. Output only code.",
    user: p.prompt + fix, schema: CODE_SCHEMA, maxTokens: 1500, timeoutMs: 90_000, temperature: TEMP });
  if (!r.ok) return "";
  return sanitize(strip(((r.json as any).lines ?? []).join("\n")));
}

/** EvalPlus-style clean-up: drop docstrings/doctest lines the model copied (often unbalanced), keep code. */
export function sanitize(code: string): string {
  let c = code.replace(/("""|\'\'\')[\s\S]*?\1/g, "");
  const odd = c.match(/"""|\'\'\'/g);
  if (odd && odd.length % 2) { const i = c.lastIndexOf(odd[odd.length - 1]); const nl = c.indexOf("\n", i); c = c.slice(0, i) + (nl >= 0 ? c.slice(nl) : ""); }
  return c.split("\n").filter((l) => !/^\s*>>>/.test(l)).join("\n");
}

async function frontier(p: Problem, tier: "cheap" | "strong" = "strong"): Promise<string> {
  const { OpenCodeFrontier } = await import("../../services/controller/frontier-opencode.ts");
  const agent = tier === "cheap" ? CHEAP_AGENT : FRONTIER_AGENT;
  const f = new OpenCodeFrontier({ agent });
  // codex-lead (experiment): afm_code needs a folder inside the home folder
  const lead = agent === "codex-lead";
  const dir = lead ? (mkdirSync(join(homedir(), "OnBud", "runtime", "tmp"), { recursive: true }), mkdtempSync(join(homedir(), "OnBud", "runtime", "tmp", "lead-"))) : mkdtempSync(join(tmpdir(), "afm-eval-codex-"));
  const r = await f.run(`Write complete Python code for this task. Reply with only one python code block.${lead ? `\nFolder for afm_code: ${dir} (path: solution.py)` : ""}\n\n${p.prompt}`, dir);
  rmSync(dir, { recursive: true, force: true });
  if (r.tokens) callTokens.push({ ...r.tokens, agent });
  const m = /```(?:python)?\n([\s\S]*?)```/.exec(r.text ?? "");
  const code = m ? m[1] : r.text ?? "";
  return p.entry && code && !new RegExp(`def\\s+${p.entry}\\b`).test(code) ? p.prompt + code : code;
}

// v2 (codegen): s2 = k candidates + format gate + differential selection + diagnosis repair;
// s3 = s2 + Decima code-difficulty (hard → more candidates and repairs); s1 = route by difficulty / consensus to Codex.
const V2 = TAG.startsWith("v2");
const HARD_T = Number(opt("--hard-threshold", "0.2"));   // dev-calibrated: d ≥ 0.2 solved locally 1/9
async function solveV2(p: Problem): Promise<{ code: string; repairs: number; decima?: number; codex: boolean; extra?: any }> {
  const task = p.task!();
  const d = MODE === "s2" ? undefined : await codeDifficulty(decima, task.prompt);
  const hard = (d ?? 0) >= HARD_T;
  if (MODE === "s1" && hard && codexBudget-- > 0) return { code: await frontier(p), repairs: 0, decima: d, codex: true, extra: { route: "codex-first" } };
  const r = await solveLocal(afm, task, { k: MODE === "s3" && hard ? 5 : 3, repairs: MODE === "s3" && hard ? 2 : 1 });
  // Dev calibration (2026-10-31): keeping only answers that pass the statement examples was right 18/21 times;
  // agreement alone on unverifiable tasks was not (2/7), so those escalate.
  const accept = r.examplesOk === true;
  if (MODE === "s1" && !accept && codexBudget-- > 0) return { code: (await frontier(p)) || r.code, repairs: r.repairs, decima: d, codex: true, extra: { route: "escalated", agreement: r.agreement, examplesOk: r.examplesOk } };
  return { code: r.code, repairs: r.repairs, decima: d, codex: false, extra: { route: "local", agreement: r.agreement, examplesOk: r.examplesOk, consensus: r.consensus, afmCalls: r.afmCalls } };
}

// v3 (adaptive effort, tuned on dev): one local attempt first; extra candidates only for non-algorithmic function
// tasks (s3: and Decima not hard); s1 sends algorithmic, unverifiable and Decima-hard tasks to Codex first and
// keeps a local answer only when it passes the statement's examples.
const V3 = TAG.startsWith("v3");
// v4 = v3 + faster escalation in s1 (no format-fix retry; optionally no plan fields) + the lean Codex agent.
const V4 = TAG.startsWith("v4");
// --copilot: GitHub Copilot's inline completion (official language server, signed in) as the middle tier: tried when
// AFM's code fails the examples, before Codex; in s1, algorithmic/hard tasks with examples are no longer sent to Codex
// first. Counted in the result (stage "copilot").
const WANT_COPILOT = args.includes("--copilot") || MODE === "copilot" || MODE === "s5";
const COPILOT = WANT_COPILOT ? await (await import("../../services/frontier/copilot-ls.ts")).copilotFiller() : undefined;
if (WANT_COPILOT && !COPILOT) { console.error("--copilot: the language server is not installed or not signed in"); process.exit(2); }
async function solveV3(p: Problem): Promise<{ code: string; repairs: number; decima?: number; codex: boolean; extra?: any }> {
  const task = p.task!();
  const t0 = Date.now();
  const d = MODE === "s2" ? undefined : await codeDifficulty(decima, task.prompt);
  const triageMs = Date.now() - t0;
  const hard = (d ?? 0) >= HARD_T, algo = algorithmic(task);
  if (MODE === "s1" && (algo || hard || !task.hasExamples) && !(COPILOT && task.hasExamples) && codexBudget-- > 0)
    return { code: await frontier(p), repairs: 0, decima: d, codex: true, extra: { route: "codex-first", why: algo ? "algorithmic" : hard ? "decima-hard" : "unverifiable", triageMs } };
  const r = await solveAdaptive(afm, task, { extra: MODE !== "s1" && !algo && !hard, fast: V4 && MODE === "s1", plan: !(V4 && MODE === "s1" && NO_PLAN), copilot: COPILOT, fallback: MODE === "s1", opts: CODE_OPTS });
  const times = { triageMs, genMs: r.genMs, checkMs: r.checkMs };
  if (MODE === "s1" && r.examplesOk !== true && codexBudget-- > 0)
    return { code: (await frontier(p)) || r.code, repairs: r.repairs, decima: d, codex: true, extra: { route: "escalated", stage: r.stage, examplesOk: r.examplesOk, afmCalls: r.afmCalls, stress: r.stress, ...times } };
  return { code: r.code, repairs: r.repairs, decima: d, codex: false, extra: { route: "local", stage: r.stage, examplesOk: r.examplesOk, afmCalls: r.afmCalls, stress: r.stress, ...times } };
}

// S5 (2026-11-03): Copilot is AFM's code-writing tool. Copilot writes the code (inline completion, unlimited); the
// statement's examples check it, and bounded retries carry the failure as a comment; Codex takes what still fails.
// Who writes first follows policies/routing.yaml (copilot_mode, decima_code_hard_threshold), as in local jobs;
// --copilot-mode balanced|saver overrides it.
//   copilot  Copilot alone (no Codex), Decima score recorded: for the routing analysis
//   s5       the tier above
// The S5 graph lives in the code skill (services/controller/code-skill.ts solveCode); these flags set its options.
const { codeOptions, policyTriage, solveCode, solveAdaptive } = await import("../../services/controller/code-skill.ts");
const CODE_OPTS = codeOptions({
  ...(args.includes("--no-stress") ? { stress: false } : {}),
  ...(args.includes("--stress-ref") ? { reference: opt("--stress-ref", "copilot") as any } : {}),
  ...(args.includes("--keep-inconclusive") ? { escalateInconclusive: false } : {}),
  ...(args.includes("--no-patterns") ? { patterns: "off" as const } : {}),
  ...(args.includes("--no-cascade") ? { cascade: false } : {}),
  ...(args.includes("--contest-candidates") ? { contestCandidates: Number(opt("--contest-candidates", "1")) } : {}),
});
const TRIAGE = { ...(await policyTriage()), ...(args.includes("--copilot-mode") ? { mode: opt("--copilot-mode", "saver") as "balanced" | "saver" } : {}), hardAt: HARD_T };
async function solveS5(p: Problem): Promise<{ code: string; repairs: number; decima?: number; codex: boolean; extra?: any }> {
  const task = p.task!();
  const t0 = Date.now();
  const d = await codeDifficulty(decima, task.prompt);
  // copilot mode: no frontier (Copilot alone); s5: Codex while the run's budget lasts
  const frontierFn = MODE === "s5" ? async (tier: "cheap" | "strong") => (codexBudget-- > 0 ? await frontier(p, tier) : undefined) : undefined;
  const r = await solveCode(task, { copilot: COPILOT!, afm, difficulty: d, frontier: frontierFn, opts: CODE_OPTS, triage: TRIAGE });
  if (process.env.ONBUD_STRESS_DEBUG) console.error(`${p.id}: ${r.trace.join(" → ")}`);
  return { code: r.code, repairs: r.repairs, decima: d, codex: r.codex, extra: { route: r.route, examplesOk: r.examplesOk, stress: r.stress, copilotCandidates: r.candidates, afmCalls: r.afmCalls, copilotMs: Date.now() - t0, notes: r.notes, tier: r.tier, trace: r.trace } };
}

async function solve(p: Problem): Promise<{ code: string; repairs: number; decima?: number; codex: boolean; extra?: any }> {
  if ((MODE === "copilot" || MODE === "s5") && p.task) return solveS5(p);
  if ((V3 || V4) && ["s2", "s3", "s1"].includes(MODE) && p.task) return solveV3(p);
  if (V2 && ["s2", "s3", "s1"].includes(MODE) && p.task) return solveV2(p);
  if (MODE === "codex") { if (codexBudget-- <= 0) return { code: "", repairs: 0, codex: false }; return { code: await frontier(p), repairs: 0, codex: true }; }
  let code = await generate(p);
  if (MODE === "raw") return { code, repairs: 0, codex: false };
  let budget = 1, decimaFrontier: number | undefined;
  if ((MODE === "s3" || MODE === "s1") && (await decima.available())) {
    try { const d = await decima.route({ taskType: "small_edit", estimatedInputTokens: 0, filesTouched: 1, localAfmAvailable: true, prompt: p.prompt.slice(0, 1800) }, ["LOCAL_AFM", "FRONTIER_GPT"]); decimaFrontier = d.probabilities?.FRONTIER_GPT; if ((decimaFrontier ?? 0) >= 0.6) budget = 2; } catch { /* advisory */ }
  }
  let repairs = 0;
  for (; repairs < budget; repairs++) {
    const ex = p.examples(code);
    if (!ex) break;
    const r = await ex;
    if (r.ok) break;
    code = (await generate(p, r.out, code)) || code;
  }
  if (MODE === "s1") {
    const ex = p.examples(code);
    // Unverifiable (no runnable examples): by default only Decima's frontier score decides; with
    // --unverifiable escalate, anything that cannot be self-checked goes to Codex.
    const stillFailing = ex ? !(await ex).ok : (decimaFrontier ?? 0) >= 0.6 || UNVERIFIABLE === "escalate";
    if (stillFailing && codexBudget-- > 0) return { code: (await frontier(p)) || code, repairs, decima: decimaFrontier, codex: true };
  }
  return { code, repairs, decima: decimaFrontier, codex: false };
}

// ---------------------------------------------------------------- main
// ml / mlh: the main ML set and its held-out part (written before the numeric kit was measured).
const ML = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const all = BENCH === "humaneval" ? humaneval() : BENCH === "ml" ? humaneval(ML("./ml-impl.jsonl")) : BENCH === "mlh" ? humaneval(ML("./ml-impl-holdout.jsonl")) : BENCH === "lcb" ? lcb() : bcbHard();   // bcb-full = dev source
const subset = IDS ? new Set<string>(JSON.parse(readFileSync(IDS, "utf8")).ids) : undefined;
const items = (subset ? all.filter((p) => subset.has(p.key ?? p.id)) : all).slice(OFFSET, OFFSET + N);
const out = join(DIR, `results-${BENCH}-${MODE}${TAG ? `-${TAG}` : ""}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.jsonl`);
let pass = 0, ms = 0, codex = 0;
for (const p of items) {
  const t0 = Date.now();
  callTokens = [];
  const cs0 = { ...((COPILOT as any)?.stats ?? { requests: 0, throttled: 0 }) };
  const s = await solve(p);
  const cs1 = (COPILOT as any)?.stats;
  const cpReq = cs1 ? { copilotReq: cs1.requests - cs0.requests, copilotThrottled: cs1.throttled - cs0.throttled } : {};
  const r = s.code ? await p.check(s.code) : { ok: false, out: "no code" };
  const dt = Date.now() - t0; ms += dt; if (r.ok) pass++; if (s.codex) codex++;
  appendFileSync(out, JSON.stringify({ id: p.id, mode: MODE, pass: r.ok, ms: dt, repairs: s.repairs, decima_frontier: s.decima, codex: s.codex, codexCalls: callTokens.length, ...(s.extra ?? {}), ...cpReq, ...(callTokens.length ? { ctokCalls: callTokens, ctok: callTokens.reduce((a, t) => ({ input: a.input + t.input, output: a.output + t.output, reasoning: a.reasoning + t.reasoning, cacheRead: a.cacheRead + t.cacheRead })) } : {}), ...(TEMP ? { temp: TEMP } : {}), error: r.ok ? undefined : r.out.slice(-500) }) + "\n");
  console.log(`${r.ok ? "PASS" : "FAIL"} ${(dt / 1000).toFixed(1)}s r=${s.repairs}${s.codex ? " codex" : ""}${s.decima !== undefined ? ` d=${s.decima.toFixed(2)}` : ""}  ${p.id}`);
}
console.log(`${BENCH} ${MODE}: ${pass}/${items.length} pass@1 = ${(100 * pass / Math.max(1, items.length)).toFixed(1)}%  avg ${(ms / Math.max(1, items.length) / 1000).toFixed(1)}s  codex ${codex}${existsSync(out) ? `\nwritten ${out}` : ""}`);
(COPILOT as { stop?: () => void } | undefined)?.stop?.();   // the language server would keep the process alive
