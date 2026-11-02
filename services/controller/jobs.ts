// Local coding/writing jobs: what AFM can do without Codex or the network, split into steps it can handle.
//   plan     AFM writes a to-do list (≤ 6 steps: create_file | edit_file | insert | run_tests) by guided
//            generation; paths are checked against the project; Decima flags risky plans
//   isolate  every job gets its own branch + git worktree (me-box: "one worktree per concurrent task");
//            git projects start from `git stash create` (uncommitted tracked changes included), other folders
//            from an APFS clone with a fresh git history, so every step is still a commit with a diff
//   execute  one step at a time: AFM writes a whole new file, or picks an anchor from a fixed list (enum of
//            real def/class/\section lines) and writes the block, or makes an exact search/replace edit;
//            LaTeX citations come from an enum of the project's .bib keys, so none can be invented;
//            then syntax check + tests/compile, one repair attempt with the error, commit, Decima "done?" score
//   journal  runtime/jobs/<id>/JOURNAL.md + job.json: plan, every diff, test output, Decima scores, failures —
//            enough for a frontier model to review, fix and finish the branch later
//   apply    nothing reaches the real project until the user approves; then the branch diff is applied
// The main checkout is never edited while a job runs.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { gatePath, redact } from "../security/gate.ts";
import { execCommand, type CommandResult } from "../context-builder/terminal.ts";
import { findMainTex, hasTeX, parseLatexLog, trialCompileCommand } from "../context-builder/latex.ts";
import { detectTestCommand, proposeEdit, syntaxCheck } from "./edit-loop.ts";
import type { DecimaClient } from "../laya-router/decima.ts";

const HOME = process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM");
const JOBS = join(HOME, "runtime", "jobs");
const TREES = join(HOME, "runtime", "worktrees");
const AUTHOR = ["-c", "user.name=OpenAFM local agent", "-c", "user.email=afm@localhost", "-c", "commit.gpgsign=false"];

export type StepAction = "create_file" | "edit_file" | "insert" | "run_tests" | "rename_symbol";
export interface JobStep {
  n: number; action: StepAction; path?: string; description: string; from?: string; to?: string;
  status: "pending" | "done" | "failed" | "skipped"; commit?: string; check?: string; decimaDone?: number; notes: string[];
}
export interface Job {
  id: string; root: string; request: string; createdAt: string; kind: "code" | "latex";
  workspace: { kind: "worktree" | "copy"; dir: string; work: string; branch: string; base: string; repoTop?: string };
  testCmd?: string; steps: JobStep[]; status: "planned" | "running" | "done" | "blocked" | "applied" | "discarded";
  offline: boolean; decimaPlanRisk?: number; summary?: string;
  owner?: "afm" | "frontier";      // who works on the branch (frontier: a Codex session runs in the worktree)
  frontierSession?: string;
  // How the controller routed the request (logged with the job's outcome, for threshold calibration).
  codeRoute?: { d?: number; threshold: number; algorithmic: boolean; newCode: boolean; tests: boolean };
}

// ---------------------------------------------------------------- small helpers
function git(args: string[], cwd: string, timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: homedir(), LANG: "en_US.UTF-8", GIT_TERMINAL_PROMPT: "0" } },
      (err: any, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: String(stdout ?? "") + String(stderr ?? "") }));
    child.stdin?.end();
  });
}
const now = () => new Date().toISOString();
const jobDir = (id: string) => join(JOBS, id);
export function saveJob(job: Job) { mkdirSync(jobDir(job.id), { recursive: true, mode: 0o700 }); writeFileSync(join(jobDir(job.id), "job.json"), JSON.stringify(job, null, 1), { mode: 0o600 }); }
export function loadJob(id: string): Job | undefined { try { return JSON.parse(readFileSync(join(jobDir(id), "job.json"), "utf8")); } catch { return undefined; } }
export function listJobs(root?: string): Job[] {
  if (!existsSync(JOBS)) return [];
  return readdirSync(JOBS).map(loadJob).filter((j): j is Job => !!j && (!root || j.root === root)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function journal(job: Job, md: string) { mkdirSync(jobDir(job.id), { recursive: true, mode: 0o700 }); appendFileSync(join(jobDir(job.id), "JOURNAL.md"), md.endsWith("\n") ? md : md + "\n", { mode: 0o600 }); }
export const journalPath = (id: string) => join(jobDir(id), "JOURNAL.md");

/** Project files (relative), bounded, without hidden/vendor folders and secrets. */
export function projectFiles(root: string, max = 200): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || ["node_modules", "__pycache__", "venv", "dist", "build", ".afm-build"].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 4) walk(r, depth + 1); }
      else if (gatePath(r, root, "read").verdict === "allow") out.push(r);
      if (out.length >= max) return;
    }
  };
  walk("", 0);
  return out;
}

const isTex = (p?: string) => !!p && /\.(tex|bib)$/i.test(p);
export function bibKeys(root: string): string[] {
  const keys: string[] = [];
  for (const f of projectFiles(root).filter((f) => f.endsWith(".bib"))) for (const m of readFileSync(join(root, f), "utf8").matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) keys.push(m[1]);
  return [...new Set(keys)].slice(0, 120);
}

// ---------------------------------------------------------------- anchors for "insert"
export interface Anchor { label: string; line: number /* 0-based index of the anchor line; -1 = top, lines.length = end */ }
/** Places a block can go, from the file's real structure (so AFM picks from a list instead of typing a location). */
export function anchorsFor(path: string, text: string): Anchor[] {
  const lines = text.split("\n");
  const out: Anchor[] = [];
  if (/\.tex$/i.test(path)) {
    lines.forEach((l, i) => {
      const m = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/.exec(l);
      if (m) out.push({ label: `${m[1]}: ${m[2].slice(0, 60)}`, line: i });
      if (/^\s*\\begin\{document\}/.test(l)) out.push({ label: "begin{document}", line: i });
      if (/^\s*\\(bibliography|printbibliography)\b/.test(l)) out.push({ label: "bibliography", line: i });
      if (/^\s*\\end\{document\}/.test(l)) out.push({ label: "end{document}", line: i });
    });
  } else {
    let lastImport = -1;
    lines.forEach((l, i) => {
      if (/^(import |from \S+ import |const .* = require\(|import .* from )/.test(l)) lastImport = i;
      const m = /^(?:async\s+)?(def|class)\s+(\w+)|^(?:export\s+)?(?:async\s+)?(function|class)\s+(\w+)/.exec(l);
      if (m) out.push({ label: `${m[1] ?? m[3]} ${m[2] ?? m[4]}`, line: i });
    });
    if (lastImport >= 0) out.unshift({ label: "imports", line: lastImport });
  }
  out.unshift({ label: "top of file", line: -1 });
  out.push({ label: "end of file", line: lines.length });
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.label) ? false : (seen.add(a.label), true))).slice(0, 60);
}

/** End (exclusive) of the block that starts at `line`: the next line at the same or a lower level. */
function blockEnd(path: string, lines: string[], line: number): number {
  if (line < 0) return 0;
  if (line >= lines.length) return lines.length;
  if (/\.tex$/i.test(path)) {
    const lvl = (l: string) => { const m = /^\s*\\(part|chapter|section|subsection|subsubsection)\b/.exec(l); return m ? ["part", "chapter", "section", "subsection", "subsubsection"].indexOf(m[1]) : 99; };
    const me = lvl(lines[line]);
    if (me === 99) return line + 1;
    for (let i = line + 1; i < lines.length; i++) if (lvl(lines[i]) <= me || /^\s*\\(end\{document\}|bibliography|printbibliography)\b/.test(lines[i])) return i;
    return lines.length;
  }
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[line]);
  if (!/^\s*(async\s+)?(def|class|function|export)/.test(lines[line])) return line + 1;
  let i = line + 1;
  while (i < lines.length && (lines[i].trim() === "" || indent(lines[i]) > base || /^\s*[)\]}]/.test(lines[i]))) i++;
  while (i > line + 1 && lines[i - 1].trim() === "") i--;
  return i;
}

export function insertAt(path: string, text: string, anchor: Anchor, position: "before" | "after", block: string): string {
  const lines = text.split("\n");
  let at: number;
  if (anchor.line < 0) at = 0;
  else if (anchor.line >= lines.length) at = lines.length;
  else if (position === "before") at = anchor.line;
  else at = anchor.label === "imports" || anchor.label === "begin{document}" ? anchor.line + 1 : blockEnd(path, lines, anchor.line);
  if (/^(end\{document\}|bibliography)$/.test(anchor.label)) at = anchor.line;   // never after \end{document}
  const pad = /\.py$/.test(path) ? ["", ""] : [""];
  const piece = [...(at > 0 && lines[at - 1]?.trim() ? pad : []), ...block.replace(/\s+$/, "").split("\n"), ...(lines[at]?.trim() ? pad : [])];
  return [...lines.slice(0, at), ...piece, ...lines.slice(at)].join("\n");
}

// ---------------------------------------------------------------- LaTeX prose with safe citations
const texEscape = (s: string) => s.split(/(\$[^$]*\$)/).map((part, i) => (i % 2 ? part : part.replace(/(?<!\\)([%&#])/g, "\\$1").replace(/(?<![\\\w])_(?!\{)/g, "\\_"))).join("");
export function renderLatexBlock(j: { heading?: string; level?: string; paragraphs: { text: string; cite_keys?: string[] }[] }, keys: string[]): string {
  const ok = new Set(keys);
  const paras = (j.paragraphs ?? []).map((p) => {
    const text = texEscape(String(p.text ?? "").replace(/\\cite[a-z]*\{[^}]*\}/g, "").trim());   // citations only via cite_keys
    const cites = (p.cite_keys ?? []).filter((k) => ok.has(k));
    return cites.length ? text.replace(/\s*([.!?])?\s*$/, (_m, punct) => `~\\cite{${[...new Set(cites)].join(",")}}${punct ?? "."}`) : text;
  }).filter(Boolean);
  const head = j.heading?.trim() ? `\\${j.level === "subsection" ? "subsection" : "section"}{${texEscape(j.heading.trim())}}\n` : "";
  return head + paras.join("\n\n") + "\n";
}

function latexSchema(keys: string[], withHeading: boolean) {
  const para: any = { type: "object", properties: { text: { type: "string", description: "One paragraph of LaTeX prose. No \\cite commands; put citations in cite_keys" } }, required: ["text"], additionalProperties: false };
  if (keys.length) { para.properties.cite_keys = { type: "array", items: { type: "string", enum: keys }, description: "Keys from the bibliography that support this paragraph; empty if none fits" }; para.required.push("cite_keys"); }
  const props: any = {};
  if (withHeading) props.heading = { type: "string", description: "Section heading, or empty for none" };
  props.paragraphs = { type: "array", items: para, description: "1 to 5 paragraphs" };
  return { type: "object" as const, properties: props, required: Object.keys(props), additionalProperties: false };
}

/** Language of the paper's existing prose (Korean if Hangul dominates the .tex text, else English). */
export function docLanguage(work: string): string {
  const tex = projectFiles(work, 60).filter((f) => f.endsWith(".tex")).map((f) => { try { return readFileSync(join(work, f), "utf8"); } catch { return ""; } }).join("\n")
    .replace(/\\[A-Za-z]+(\[[^\]]*\])?(\{[^}]*\})?/g, " ");
  const hangul = (tex.match(/[\uac00-\ud7a3]/g) ?? []).length, latin = (tex.match(/[A-Za-z]/g) ?? []).length;
  return hangul > latin * 0.3 ? "Korean" : "English";
}

export const isTestPath = (p: string) => /(^|\/)(tests?\/|test_[^/]*\.py$|[^/]*_test\.py$|[^/]*\.(test|spec)\.[jt]sx?$)/.test(p);
function exampleTest(work: string): string {
  const t = projectFiles(work, 200).find((f) => isTestPath(f) && /\.(py|[jt]s)$/.test(f) && !/__init__/.test(f));
  try { return t ? `# ${t}\n${readFileSync(join(work, t), "utf8").slice(0, 1500)}` : ""; } catch { return ""; }
}
/** "Ran 3 tests" / "3 passed" → 3 (for the "did the new tests actually run?" check). */
export function testCount(out: string): number | undefined {
  const m = /Ran (\d+) tests?/.exec(out) ?? /(\d+) passed/.exec(out) ?? /# pass (\d+)/.exec(out) ?? /Tests:\s+(\d+) passed/.exec(out);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- workspace
async function makeWorkspace(id: string, root: string): Promise<Job["workspace"]> {
  const slug = `afm/${id}`;
  const top = await git(["rev-parse", "--show-toplevel"], root);
  mkdirSync(join(TREES, id), { recursive: true });
  if (top.code === 0) {
    const repoTop = top.out.trim();
    const stash = (await git(["stash", "create"], repoTop)).out.trim();     // a commit of the current tracked changes; touches nothing
    const base = stash || (await git(["rev-parse", "HEAD"], repoTop)).out.trim();
    const dir = join(TREES, id, basename(repoTop));
    const r = await git(["worktree", "add", "-q", "-b", slug, dir, base], repoTop);
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.out.slice(0, 200)}`);
    // git reports the real path (/private/var/… for /var/…); compare like with like.
    return { kind: "worktree", dir, work: join(dir, relative(realpathSync(repoTop), realpathSync(root))), branch: slug, base, repoTop };
  }
  // Not a git project: APFS clone + a fresh repository, so steps are still commits.
  const dir = join(TREES, id, basename(root));
  await new Promise<void>((res) => execFile("/bin/cp", ["-cR", root, dir], () => res()));
  if (!existsSync(dir)) cpSync(root, dir, { recursive: true });
  await git(["init", "-q", "-b", slug], dir);
  await git(["add", "-A"], dir);
  await git([...AUTHOR, "commit", "-q", "--allow-empty", "-m", "baseline (copy of the project folder)"], dir);
  const base = (await git(["rev-parse", "HEAD"], dir)).out.trim();
  return { kind: "copy", dir, work: dir, branch: slug, base };
}

function excludeBuild(ws: Job["workspace"]) {
  try {
    const info = ws.kind === "worktree" ? undefined : join(ws.dir, ".git", "info");
    if (info) { mkdirSync(info, { recursive: true }); appendFileSync(join(info, "exclude"), "\n.afm-build/\n__pycache__/\n"); }
  } catch { /* optional */ }
}

// ---------------------------------------------------------------- planning
const PLAN_SCHEMA = {
  type: "object" as const,
  properties: {
    steps: { type: "array" as const, description: "1 to 6 small steps, in order. Each step changes one file", items: {
      type: "object" as const, additionalProperties: false, required: ["action", "path", "description"],
      properties: {
        action: { type: "string" as const, enum: ["create_file", "edit_file", "insert", "run_tests"], description: "create_file: new file; edit_file: change existing lines; insert: add a new function/class/section into an existing file; run_tests: run the tests" },
        path: { type: "string" as const, description: "Project-relative file path (empty for run_tests)" },
        description: { type: "string" as const, description: "What exactly to write or change in this step, one or two sentences" },
      } } },
  },
  required: ["steps"], additionalProperties: false,
};

/** "rename slugify to make_slug" / "slugify를 make_slug로 이름 바꿔" → the two identifiers. */
export function renameRequest(prompt: string): { from: string; to: string } | undefined {
  const m = /rename\s+(?:the\s+)?(?:function|class|method|variable|symbol)?\s*`?([A-Za-z_]\w*)`?\s+(?:to|as)\s+`?([A-Za-z_]\w*)`?/i.exec(prompt)
    ?? /`?([A-Za-z_]\w*)`?\s*(?:함수|클래스|메서드|변수)?\s*(?:의\s*)?(?:이름을?|을|를)\s*`?([A-Za-z_]\w*)`?\s*(?:으로|로)\s*(?:이름을?\s*)?(?:바꾸|바꿔|변경)/.exec(prompt);
  return m && m[1] !== m[2] ? { from: m[1], to: m[2] } : undefined;
}

/** Mechanical rename across the project's code files (word boundaries; strings and comments included). */
export function renameSymbol(work: string, from: string, to: string): string[] {
  const changed: string[] = [];
  const re = new RegExp(`\\b${from}\\b`, "g");
  for (const f of projectFiles(work, 400).filter((f) => /\.(py|ts|tsx|js|jsx|mjs|go|rs|java|kt|rb|swift|c|cc|cpp|h|hpp|md|tex)$/.test(f))) {
    const t = readFileSync(join(work, f), "utf8");
    if (re.test(t)) { writeFileSync(join(work, f), t.replace(re, to)); changed.push(f); }
    re.lastIndex = 0;
  }
  return changed;
}

export async function planJob(afm: AFMProvider, a: { root: string; request: string; decima?: DecimaClient; offline: boolean; timeoutMs?: number }): Promise<{ ok: true; job: Job } | { ok: false; error: string }> {
  const files = projectFiles(a.root, 150);
  const kind: Job["kind"] = /(latex|\.tex|논문|섹션|section|paper|bib)/i.test(a.request) || files.some((f) => f.endsWith(".tex")) && !files.some((f) => /\.(py|ts|js)$/.test(f)) ? "latex" : "code";
  const testCmd = kind === "latex" ? (hasTeX() && findMainTex(a.root) ? trialCompileCommand(a.root, findMainTex(a.root)!) : undefined) : detectTestCommand(a.root);
  const user = [`REQUEST: ${redact(a.request).text}`, `PROJECT FILES:\n${files.join("\n") || "(empty)"}`, testCmd ? `CHECK COMMAND: ${testCmd}` : "No test command found.",
    kind === "latex" ? "This is a LaTeX paper: new sections usually go in their own .tex file plus an insert of \\input{...} into the main file." : "Prefer adding new code in new files or as new functions (insert) over rewriting existing code."].join("\n\n");
  const ren = renameRequest(a.request);
  if (ren) {
    const id0 = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6)}`;
    const steps0: JobStep[] = [{ n: 1, action: "rename_symbol", from: ren.from, to: ren.to, description: `Rename ${ren.from} → ${ren.to} in every code file (exact word match)`, status: "pending", notes: [] }];
    if (testCmd) steps0.push({ n: 2, action: "run_tests", description: "Run the checks", status: "pending", notes: [] });
    const job0: Job = { id: id0, root: a.root, request: redact(a.request).text, createdAt: now(), kind, workspace: { kind: "copy", dir: "", work: "", branch: `afm/${id0}`, base: "" }, testCmd, steps: steps0, status: "planned", offline: a.offline };
    saveJob(job0);
    journal(job0, `# Local job ${id0}\n\n- request: ${job0.request}\n- project: ${a.root}\n- plan: deterministic rename (no model needed)\n\n## Plan\n${steps0.map((s) => `${s.n}. **${s.action}** — ${s.description}`).join("\n")}\n`);
    return { ok: true, job: job0 };
  }
  const r = await afm.generate({ system: "You plan small, concrete steps that a small model can do one at a time. Each step touches exactly one file. Use only paths from PROJECT FILES for edit_file and insert. End with run_tests when a check command exists.",
    user, schema: PLAN_SCHEMA, maxTokens: 700, timeoutMs: a.timeoutMs ?? 60_000 });
  if (!r.ok) return { ok: false, error: `afm_${r.failure}` };
  const raw = ((r.json as any).steps ?? []) as { action: StepAction; path: string; description: string }[];
  const steps: JobStep[] = [];
  for (const s of raw.slice(0, 6)) {
    let path = s.action === "run_tests" ? undefined : String(s.path ?? "").trim().replace(/^\.?\//, "");
    if (path && (s.action === "edit_file" || s.action === "insert") && !files.includes(path)) {
      const byName = files.filter((f) => basename(f) === basename(path!));
      if (byName.length === 1) path = byName[0]; else continue;   // AFM invented a path: drop the step
    }
    // "Add a function/class/section" to an existing file is an insert, not a search/replace edit.
    const additive = /\b(add|adds|adding|insert|append|new|implement)\b|추가|새로|넣/i.test(s.description) && /\b(function|class|method|section|subsection|paragraph|test|helper)\b|함수|클래스|메서드|섹션|단락|문단|테스트/i.test(s.description);
    if (s.action === "edit_file" && additive) s.action = "insert";
    if (path && s.action === "create_file") {
      if (files.includes(path)) { s.action = "edit_file"; }
      if (gatePath(path, a.root, "write").verdict !== "allow" || path.includes("..")) continue;
    }
    steps.push({ n: steps.length + 1, action: s.action, path, description: String(s.description ?? "").slice(0, 400), status: "pending", notes: [] });
  }
  // Merge duplicates: one step per (action, file); at most two steps per file.
  const seenKey = new Set<string>(), perFile = new Map<string, number>();
  const kept: JobStep[] = [];
  for (const st of steps) {
    const k = `${st.action}:${st.path ?? ""}`;
    if (st.action !== "run_tests" && (seenKey.has(k) || (st.path && (perFile.get(st.path) ?? 0) >= 2))) continue;
    seenKey.add(k); if (st.path) perFile.set(st.path, (perFile.get(st.path) ?? 0) + 1);
    if (st.action !== "run_tests" || !kept.some((x) => x.action === "run_tests")) kept.push(st);
  }
  // Code first, then the tests that exercise it, then the check (AFM sometimes writes the test file first).
  const isTest = (x: JobStep) => x.action === "create_file" && isTestPath(x.path ?? "");
  steps.splice(0, steps.length, ...kept.filter((x) => x.action !== "run_tests" && !isTest(x)), ...kept.filter(isTest), ...kept.filter((x) => x.action === "run_tests"));
  steps.forEach((x, i) => (x.n = i + 1));
  if (testCmd && !steps.some((s) => s.action === "run_tests")) steps.push({ n: steps.length + 1, action: "run_tests", description: "Run the checks", status: "pending", notes: [] });
  if (!steps.some((s) => s.action !== "run_tests")) return { ok: false, error: "empty_plan" };
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6)}`;
  const job: Job = { id, root: a.root, request: redact(a.request).text, createdAt: now(), kind, workspace: { kind: "copy", dir: "", work: "", branch: `afm/${id}`, base: "" }, testCmd, steps, status: "planned", offline: a.offline };
  if (a.decima && (await a.decima.available())) {
    try {
      const d = await a.decima.route({ taskType: "multi_file_change", estimatedInputTokens: 0, filesTouched: steps.length, localAfmAvailable: true, prompt: `${a.request}\nPLAN:\n${steps.map((s) => `${s.n}. ${s.action} ${s.path ?? ""}: ${s.description}`).join("\n")}` }, ["LOCAL_AFM", "FRONTIER_GPT", "ASK_USER"]);
      job.decimaPlanRisk = d.destructive;
    } catch { /* advisory only */ }
  }
  saveJob(job);
  journal(job, `# Local job ${id}\n\n- request: ${job.request}\n- project: ${a.root}\n- kind: ${kind}, offline: ${a.offline}, check: ${testCmd ?? "none"}\n- created: ${job.createdAt}\n\n## Plan (AFM)\n${steps.map((s) => `${s.n}. **${s.action}** ${s.path ?? ""} — ${s.description}`).join("\n")}\n${job.decimaPlanRisk !== undefined ? `\nDecima: destructive=${job.decimaPlanRisk.toFixed(2)}\n` : ""}`);
  return { ok: true, job };
}

// ---------------------------------------------------------------- execution
async function check(job: Job, path?: string): Promise<{ ok: boolean; label: string; result?: CommandResult }> {
  const w = job.workspace.work;
  const syn = path && existsSync(join(w, path)) ? syntaxCheck(path) : undefined;
  if (syn) { const r = await execCommand(syn, w, { timeoutMs: 20_000, maxChars: 3000 }); if (r.exitCode !== 0) return { ok: false, label: "syntax", result: r }; }
  return { ok: true, label: syn ? "syntax ok" : "no syntax check" };
}
async function runChecks(job: Job): Promise<{ ok: boolean; label: string; result?: CommandResult }> {
  if (!job.testCmd) return { ok: true, label: "no tests" };
  const r = await execCommand(job.testCmd, job.workspace.work, { timeoutMs: 180_000, maxChars: 20_000 });
  if (r.exitCode === 0 && !r.timedOut) return { ok: true, label: /latexmk/.test(job.testCmd) ? "compile" : "tests", result: r };
  // Tests that already failed before the job are not this job's fault: pass if there are no NEW failures.
  const base: string[] | undefined = (job as any).baselineFailures;
  const now = failingTests(r.output);
  if (!r.timedOut && base?.length && now.size && [...now].every((t) => base.includes(t))) return { ok: true, label: `tests (only ${now.size} pre-existing failure${now.size > 1 ? "s" : ""})`, result: r };
  return { ok: false, label: /latexmk/.test(job.testCmd) ? "compile" : "tests", result: r };
}

/** Names of failing tests in unittest / pytest / node:test output. */
export function failingTests(out: string): Set<string> {
  const s = new Set<string>();
  for (const m of out.matchAll(/^(?:FAIL|ERROR): (\w+) \(([\w.]+)\)/gm)) s.add(`${m[2]}::${m[1]}`);
  for (const m of out.matchAll(/^FAILED (\S+)/gm)) s.add(m[1]);
  for (const m of out.matchAll(/^not ok \d+ - (.+)$/gm)) s.add(m[1].trim());
  return s;
}
const summarize = (job: Job, r?: CommandResult) => {
  if (!r) return "";
  if (/latexmk/.test(job.testCmd ?? "")) { const p = parseLatexLog(r.output); return [...p.errors.slice(0, 3).map((e) => `${e.file ?? ""}:${e.line ?? ""}: ${e.message}`), `[exit ${r.exitCode}]`].join("\n"); }
  return r.output.slice(-1800) + `\n[exit ${r.timedOut ? "timeout" : r.exitCode}]`;
};

function signatures(work: string, files: string[], max = 2500): string {
  const out: string[] = [];
  for (const f of files.filter((f) => /\.(py|ts|js|tex)$/.test(f)).slice(0, 8)) {
    try {
      const lines = readFileSync(join(work, f), "utf8").split("\n").filter((l) => /^(\s*(async\s+)?def |class |export |function |import |from )|^\s*\\(section|subsection|usepackage|input|newcommand)/.test(l));
      if (lines.length) out.push(`# ${f}\n${lines.slice(0, 25).join("\n")}`);
    } catch { /* skip */ }
    if (out.join("\n").length > max) break;
  }
  return out.join("\n\n").slice(0, max);
}

async function doStep(afm: AFMProvider, job: Job, step: JobStep, feedback?: string): Promise<{ ok: boolean; error?: string }> {
  const w = job.workspace.work;
  const plan = job.steps.map((s) => `${s.n}. ${s.action} ${s.path ?? ""}: ${s.description}`).join("\n");
  const ctx = `REQUEST: ${job.request}\nPLAN:\n${plan}\nCURRENT STEP ${step.n}: ${step.action} ${step.path ?? ""} — ${step.description}${feedback ? `\n\nPREVIOUS ATTEMPT FAILED:\n${feedback.slice(-1500)}` : ""}`;
  const keys = isTex(step.path) ? bibKeys(w) : [];
  const t = 75_000;
  const lang = isTex(step.path) ? docLanguage(w) : "";
  if (step.action === "create_file") {
    const abs = join(w, step.path!);
    if (isTex(step.path) && step.path!.endsWith(".tex")) {
      const r = await afm.generate({ system: `You write a LaTeX section for an academic paper in ${lang}: 2 to 4 substantial paragraphs, formal academic style. Use only facts from the request and plan; do not invent results or numbers.`, user: ctx + `\n\nPROJECT OUTLINE:\n${signatures(w, projectFiles(w, 60))}`, schema: latexSchema(keys, true), maxTokens: 1400, timeoutMs: t });
      if (!r.ok) return { ok: false, error: `afm_${r.failure}` };
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, renderLatexBlock(r.json as any, keys));
      return { ok: true };
    }
    const testFile = isTestPath(step.path!);
    const example = testFile ? exampleTest(w) : "";
    // Python tests: AFM writes the import and the assertions; the unittest structure is built here.
    if (testFile && step.path!.endsWith(".py")) {
      const r = await afm.generate({ system: "You write unit tests. Give the import line for the code under test and, for each test, a short snake_case name and assertion statements using self.assertEqual / self.assertTrue / self.assertFalse / self.assertRaises. Use only behaviour the request or the code clearly implies.",
        user: ctx + `\n\nEXISTING CODE (signatures):\n${signatures(w, projectFiles(w, 60))}${example ? `\n\nEXAMPLE TEST:\n${example}` : ""}`, maxTokens: 1200, timeoutMs: t,
        schema: { type: "object", properties: {
          // Restating the behaviour first (fields are generated in order) stops misreadings such as
          // "reverse the word order" tested as character reversal (own suite E1, 2026-10-31).
          behaviour: { type: "string", description: "In English: exactly what the code under test returns, with one worked example on an input that shows the behaviour (e.g. several words)" },
          import_line: { type: "string", description: "e.g. from stats import mean, median" },
          tests: { type: "array", description: "2 to 6 tests", items: { type: "object", properties: { name: { type: "string", description: "snake_case, without the test_ prefix" }, assertions: { type: "array", items: { type: "string" }, description: "Python statements, one per item, e.g. self.assertEqual(mean([1, 2, 3]), 2)" } }, required: ["name", "assertions"], additionalProperties: false } } },
          required: ["behaviour", "import_line", "tests"], additionalProperties: false } });
      if (!r.ok) return { ok: false, error: `afm_${r.failure}` };
      const j = r.json as any;
      const tests = (j.tests ?? []).filter((x: any) => (x.assertions ?? []).length);
      if (!tests.length || !/^\s*(from|import)\s/.test(j.import_line ?? "")) return { ok: false, error: "test_plan_incomplete" };
      j.import_line = resolveImport(w, j.import_line.trim());
      const cls = "Test" + basename(step.path!, ".py").replace(/^test_?/, "").replace(/(^|_)(\w)/g, (_m: string, _u: string, c: string) => c.toUpperCase());
      const body = tests.map((x: any) => `    def test_${String(x.name).replace(/^test_/, "").replace(/\W+/g, "_")}(self):\n${x.assertions.map((a: string) => `        ${a.trim()}`).join("\n")}`).join("\n\n");
      mkdirSync(dirname(join(w, step.path!)), { recursive: true });
      writeFileSync(join(w, step.path!), `import unittest\n${j.import_line.trim()}\n\n\nclass ${cls || "TestModule"}(unittest.TestCase):\n${body}\n\n\nif __name__ == "__main__":\n    unittest.main()\n`);
      step.notes.push(`${tests.length} tests`);
      return { ok: true };
    }
    const r = await afm.generate({ system: testFile
        ? "You write a unit test file. Import the functions under test from their module and check them with assertions in test_ methods (follow EXAMPLE TEST's framework and style). Never copy or re-implement the code under test. Output only the file content."
        : `You write one complete, working source file (${extname(step.path!) || "text"}). Keep it small and self-contained, with the imports it needs. Follow the style of the existing code. Output only the file content.`,
      user: ctx + `\n\nEXISTING CODE (signatures):\n${signatures(w, projectFiles(w, 60))}${example ? `\n\nEXAMPLE TEST:\n${example}` : ""}`, maxTokens: 1800, timeoutMs: t,
      // Lines as an array: inside one JSON string AFM sometimes drops the newlines of code.
      schema: { type: "object", properties: { lines: { type: "array", items: { type: "string" }, description: "The whole file, one item per line, with indentation" }, explanation: { type: "string", description: "One sentence" } }, required: ["lines", "explanation"], additionalProperties: false } });
    if (!r.ok) return { ok: false, error: `afm_${r.failure}` };
    const content = ((r.json as any).lines ?? []).join("\n").replace(/^```\w*\n|\n?```\s*$/g, "");
    if (!content.trim()) return { ok: false, error: "empty_file" };
    if (testFile && !/\bdef test_\w+|\b(it|test)\(\s*["'`]/.test(content)) return { ok: false, error: "test_file_has_no_tests (write test_ methods that import and assert on the code under test)" };
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content.endsWith("\n") ? content : content + "\n");
    step.notes.push((r.json as any).explanation ?? "");
    return { ok: true };
  }
  if (step.action === "insert") {
    const abs = join(w, step.path!);
    const text = readFileSync(abs, "utf8");
    const anchors = anchorsFor(step.path!, text);
    const tex = isTex(step.path);
    // A section written to its own file in this job is included with \input, not written twice.
    const inputs = tex ? job.steps.filter((s) => s.action === "create_file" && s.status === "done" && /\.tex$/.test(s.path ?? "") && s.path !== step.path)
      .map((s) => relative(dirname(step.path!), s.path!).replace(/\.tex$/, "")).filter((p) => !text.includes(`{${p}}`)) : [];
    if (inputs.length) {
      const r = await afm.generate({ system: "Pick where the new section file is included in the LaTeX document.", user: `${ctx}\n\nNEW FILES TO INCLUDE: ${inputs.join(", ")}\n\nFILE ${step.path} (first 4000 chars):\n${text.slice(0, 4000)}`, maxTokens: 80, timeoutMs: t,
        schema: { type: "object", properties: { anchor: { type: "string", enum: anchors.map((a) => a.label) }, position: { type: "string", enum: ["before", "after"] } }, required: ["anchor", "position"], additionalProperties: false } });
      if (!r.ok) return { ok: false, error: `afm_${r.failure}` };
      const j = r.json as any;
      const anchor = anchors.find((a) => a.label === j.anchor) ?? anchors.find((a) => a.label === "bibliography") ?? anchors[anchors.length - 1];
      writeFileSync(abs, insertAt(step.path!, text, anchor, j.position === "before" ? "before" : "after", inputs.map((p) => `\\input{${p}}`).join("\n")));
      step.notes.push(`\\input{${inputs.join("}, \\input{")}} ${j.position} "${anchor.label}"`);
      return { ok: true };
    }
    const contentSchema = tex ? latexSchema(keys, true).properties : { lines: { type: "array", items: { type: "string" }, description: "The code block to insert (complete function/class), one item per line, indented for its position" } };
    const r = await afm.generate({ system: tex ? `You add a section or paragraphs to a LaTeX paper, written in ${lang}. Pick where it goes from the anchors. Use only facts from the request; do not invent results.` : "You add new code (a function, class or small block) to an existing file. Pick where it goes from the anchors; reuse names that already exist.",
      user: `${ctx}\n\nFILE ${step.path} (first 6000 chars):\n${text.slice(0, 6000)}`, maxTokens: 1500, timeoutMs: t,
      schema: { type: "object", properties: { anchor: { type: "string", enum: anchors.map((a) => a.label), description: "Where to put the new block" }, position: { type: "string", enum: ["before", "after"] }, ...contentSchema },
        required: ["anchor", "position", ...Object.keys(contentSchema)], additionalProperties: false } });
    if (!r.ok) return { ok: false, error: `afm_${r.failure}` };
    const j = r.json as any;
    const anchor = anchors.find((a) => a.label === j.anchor) ?? anchors[anchors.length - 1];
    const block = tex ? renderLatexBlock(j, keys) : (j.lines ?? []).join("\n").replace(/^```\w*\n|\n?```\s*$/g, "");
    if (!block.trim()) return { ok: false, error: "empty_block" };
    writeFileSync(abs, insertAt(step.path!, text, anchor, j.position === "before" ? "before" : "after", block));
    step.notes.push(`inserted ${j.position} "${anchor.label}"`);
    return { ok: true };
  }
  if (step.action === "edit_file") {
    const p = await proposeEdit(afm, { root: w, path: step.path!, request: `${step.description} (overall request: ${job.request})`, system: "You make one minimal, exact edit to the file for the CURRENT STEP. Keep everything else unchanged.", feedback, timeoutMs: t });
    if (!p.ok) return { ok: false, error: p.error };
    const abs = join(w, step.path!);
    const cur = readFileSync(abs, "utf8");
    const { applyEdit } = await import("./edit-loop.ts");
    const ap = applyEdit(cur, p.edit.oldText, p.edit.newText);
    if (!ap.ok) return { ok: false, error: ap.error };
    writeFileSync(abs, ap.text);
    step.notes.push(p.edit.explanation);
    return { ok: true };
  }
  if (step.action === "rename_symbol" && step.from && step.to) {
    const changed = renameSymbol(w, step.from, step.to);
    if (!changed.length) return { ok: false, error: `no_occurrences_of_${step.from}` };
    step.notes.push(`renamed in ${changed.join(", ")}`);
    return { ok: true };
  }
  return { ok: true };   // run_tests is handled by the caller
}

async function commitStep(job: Job, step: JobStep, failing: boolean): Promise<string | undefined> {
  const ws = job.workspace;
  await git(["add", "-A", "--", ".", ":!.afm-build"], ws.dir);
  const msg = `${failing ? "[FAILING] " : ""}step ${step.n}: ${step.action} ${step.path ?? ""} — ${step.description}`.slice(0, 200);
  const c = await git([...AUTHOR, "commit", "-q", "--allow-empty", "-m", msg, "-m", `OpenAFM local job ${job.id}; journal: ${journalPath(job.id)}`], ws.dir);
  return c.code === 0 ? (await git(["rev-parse", "--short", "HEAD"], ws.dir)).out.trim() : undefined;
}

/** Run all pending steps. `onProgress` streams one line per step to the chat. */
export async function runJob(afm: AFMProvider, job: Job, opts: { decima?: DecimaClient; onProgress?: (line: string) => void } = {}): Promise<Job> {
  const say = (l: string) => opts.onProgress?.(l);
  if (!job.workspace.dir) {
    job.workspace = await makeWorkspace(job.id, job.root);
    excludeBuild(job.workspace);
    if (job.testCmd && !/latexmk/.test(job.testCmd)) {
      const b = await execCommand(job.testCmd, job.workspace.work, { timeoutMs: 180_000, maxChars: 20_000 });
      (job as any).baselineTests = testCount(b.output);
      (job as any).baselineFailures = b.exitCode === 0 ? [] : [...failingTests(b.output)];
    }
    journal(job, `\n## Workspace\n- ${job.workspace.kind}: \`${job.workspace.dir}\`\n- branch: \`${job.workspace.branch}\` from \`${job.workspace.base.slice(0, 10)}\`${job.workspace.kind === "worktree" ? " (includes uncommitted tracked changes; untracked files are not included)" : ""}\n`);
  }
  job.status = "running"; saveJob(job);
  for (const step of job.steps.filter((s) => s.status === "pending")) {
    say(`${step.n}/${job.steps.length} ${step.action} ${step.path ?? ""} …`);
    let res = step.action === "run_tests" ? { ok: true } : await doStep(afm, job, step);
    if (!res.ok && step.action === "edit_file" && /old_text_not_(found|unique)/.test(res.error ?? "")) {
      step.notes.push(`edit failed (${res.error}); retried as insert`);
      step.action = "insert";
      res = await doStep(afm, job, step);
    }
    let chk = res.ok ? (step.action === "run_tests" ? await runChecks(job) : await check(job, step.path)) : { ok: false, label: res.error ?? "failed" };
    // Last edit-type step before tests: also run the tests now, so the repair sees their output.
    if (res.ok && chk.ok && step.action !== "run_tests" && job.testCmd && !job.steps.some((s) => s.n > step.n && s.action !== "run_tests")) {
      const t = await runChecks(job);
      if (!t.ok) chk = t;
    }
    if (!chk.ok && step.action !== "run_tests") {
      // One repair attempt with the error output (AFM sees what went wrong).
      const fb = `${chk.label}: ${summarize(job, chk.result) || res.error || ""}`;
      step.notes.push(`attempt 1 failed — ${fb.slice(0, 300)}`);
      // Start the retry from the original file, not from the failed attempt.
      if (step.action === "create_file") rmSync(join(job.workspace.work, step.path!), { force: true });
      else if (step.path) await git(["checkout", "--", step.path], job.workspace.work);
      // A new test that fails may be wrong itself: AFM decides whether the test or the code is wrong
      // (it sees the failing assertion with actual values); only the wrong side is changed.
      let target = step;
      if (isTestPath(step.path ?? "") && step.action === "create_file") {
        const codeStep = [...job.steps].reverse().find((x) => x.n < step.n && x.status === "done" && x.path && !isTestPath(x.path) && x.action !== "run_tests");
        const verdict = codeStep ? await afm.generate({ system: "A newly written unit test fails. Decide whether the TEST expectation is wrong or the CODE is wrong, using the request as the specification.",
          user: `REQUEST: ${job.request}\n\nFAILURE:\n${fb.slice(-1500)}`, maxTokens: 200, timeoutMs: 45_000,
          schema: { type: "object", properties: { reason: { type: "string" }, wrong: { type: "string", enum: ["test", "code"] } }, required: ["reason", "wrong"], additionalProperties: false } }) : undefined;
        if (verdict?.ok && (verdict.json as any).wrong === "code" && codeStep) target = codeStep;
        step.notes.push(`arbitration: ${verdict?.ok ? (verdict.json as any).wrong : "n/a"} is wrong`);
        if (target !== step) { await git(["checkout", "--", codeStep!.path!], job.workspace.work).catch(() => {}); }
      }
      if (target === step) res = await doStep(afm, job, step, `${fb}\nIf an assertion expects a value that contradicts the request, fix the assertion; tests must follow the specified behaviour.`);
      else {
        // keep the new test file, fix the code it exercises
        const p = await proposeEdit(afm, { root: job.workspace.work, path: target.path!, request: `${target.description} (overall request: ${job.request})`, system: "Fix the code so the failing test passes, with a minimal edit.", feedback: fb, timeoutMs: 75_000 });
        if (p.ok) { const { applyEdit } = await import("./edit-loop.ts"); const cur = readFileSync(join(job.workspace.work, target.path!), "utf8"); const ap = applyEdit(cur, p.edit.oldText, p.edit.newText); if (ap.ok) writeFileSync(join(job.workspace.work, target.path!), ap.text); }
        res = { ok: true };
      }
      chk = res.ok ? await check(job, step.path) : { ok: false, label: res.error ?? "failed" };
      if (res.ok && chk.ok && job.testCmd && !job.steps.some((s) => s.n > step.n && s.action !== "run_tests")) { const t = await runChecks(job); if (!t.ok) chk = t; }
    }
    if (step.action === "run_tests" && chk.ok && chk.result && job.steps.some((s) => s.action === "create_file" && isTestPath(s.path ?? "") && s.status === "done")) {
      const after = testCount(chk.result.output), before = (job as any).baselineTests;
      if (after !== undefined && before !== undefined && after <= before) { chk = { ...chk, ok: false, label: `tests ran but the new tests were not collected (${before} → ${after})` }; }
    }
    const diff = (await git(["diff", "--no-color", "-U2", "HEAD", "--", ".", ":!.afm-build"], job.workspace.dir)).out;
    step.status = chk.ok ? "done" : "failed";
    step.check = chk.label;
    step.commit = await commitStep(job, step, !chk.ok);
    if (opts.decima && step.action !== "run_tests" && (await opts.decima.available())) {
      try {
        const d = await opts.decima.route({ taskType: "small_edit", estimatedInputTokens: 0, filesTouched: 1, localAfmAvailable: true, prompt: `STEP: ${step.description}\nRESULT CHECK: ${chk.label}\nDIFF:\n${diff.slice(0, 2500)}` }, ["LOCAL_AFM", "FRONTIER_GPT"]);
        step.decimaDone = d.probabilities?.LOCAL_AFM;   // "a small local change suffices" ≈ the step looks complete
      } catch { /* advisory */ }
    }
    journal(job, `\n## Step ${step.n}: ${step.action} ${step.path ?? ""} — ${step.status.toUpperCase()}\n${step.description}\n\n- check: ${chk.label}${step.commit ? `\n- commit: ${step.commit}` : ""}${step.decimaDone !== undefined ? `\n- Decima local-sufficient score: ${step.decimaDone.toFixed(2)} (uncalibrated)` : ""}${step.notes.length ? `\n- notes: ${step.notes.join(" | ")}` : ""}\n\n\`\`\`diff\n${redact(diff).text.slice(0, 6000)}\n\`\`\`\n${chk.result ? `\n\`\`\`\n${summarize(job, chk.result)}\n\`\`\`\n` : ""}`);
    say(`${step.n}/${job.steps.length} ${step.status === "done" ? "✓" : "✗"} ${step.action} ${step.path ?? ""} (${chk.label})`);
    if (step.status === "failed") { job.status = "blocked"; break; }
  }
  if (job.status === "running") job.status = "done";
  const stat = (await git(["diff", "--stat", job.workspace.base, "HEAD", "--", ".", ":!.afm-build"], job.workspace.dir)).out.trim();
  job.summary = stat;
  journal(job, `\n## Result: ${job.status}\n\`\`\`\n${stat}\n\`\`\`\nFor review: \`git -C ${job.workspace.dir} log --oneline ${job.workspace.base.slice(0, 10)}..HEAD\`\n`);
  saveJob(job);
  return job;
}

/** Commit whatever is uncommitted in the worktree (a frontier agent may leave changes unstaged). */
export async function snapshotJob(job: Job, label = "snapshot of uncommitted changes"): Promise<boolean> {
  if (!job.workspace.dir || !existsSync(job.workspace.dir)) return false;
  await git(["add", "-A", "--", ".", ":!.afm-build"], job.workspace.dir);
  const st = await git(["diff", "--cached", "--quiet"], job.workspace.dir);
  if (st.code === 0) return false;
  await git([...AUTHOR, "commit", "-q", "-m", `${job.owner === "frontier" ? "[frontier] " : ""}${label}`], job.workspace.dir);
  return true;
}

/** A branch + worktree for a frontier agent (Codex) to work in; no AFM plan. */
export async function createFrontierJob(root: string, request: string): Promise<Job> {
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6)}`;
  const kind: Job["kind"] = /(latex|\.tex|논문|섹션|section|paper)/i.test(request) ? "latex" : "code";
  const testCmd = kind === "latex" ? (hasTeX() && findMainTex(root) ? trialCompileCommand(root, findMainTex(root)!) : undefined) : detectTestCommand(root);
  const job: Job = { id, root, request: redact(request).text, createdAt: now(), kind, workspace: await makeWorkspace(id, root), testCmd, steps: [], status: "running", offline: false, owner: "frontier" };
  excludeBuild(job.workspace);
  saveJob(job);
  journal(job, `# Frontier job ${id}\n\n- request: ${job.request}\n- project: ${root}\n- worktree: \`${job.workspace.dir}\` (branch \`${job.workspace.branch}\`)\n- worker: Codex in its own OpenCode session; the main checkout is untouched until applied\n`);
  return job;
}

export interface JobComparison { id: string; owner: string; status: string; tests?: { ok: boolean; count?: number; tail: string }; stat: string; files: number; added: number; removed: number }

/** Compare jobs: snapshot, diff size, and the same check command run in each worktree. */
export async function compareJobs(jobs: Job[]): Promise<JobComparison[]> {
  const out: JobComparison[] = [];
  for (const j of jobs) {
    await snapshotJob(j);
    const stat = (await git(["diff", "--shortstat", j.workspace.base, "HEAD", "--", ".", ":!.afm-build"], j.workspace.dir)).out.trim();
    const n = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    let tests: JobComparison["tests"];
    if (j.testCmd) {
      const r = await execCommand(j.testCmd, j.workspace.work, { timeoutMs: 180_000, maxChars: 4000 });
      tests = { ok: r.exitCode === 0 && !r.timedOut, count: testCount(r.output), tail: summarize(j, r).slice(-600) };
    }
    out.push({ id: j.id, owner: j.owner ?? "afm", status: j.status, tests, stat, files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?/), removed: n(/(\d+) deletions?/) });
  }
  return out;
}

/** Combined diff of several jobs for a judge (Decima state / frontier review prompt). */
export async function jobDiffs(jobs: Job[], maxEach = 2500): Promise<string> {
  const parts: string[] = [];
  for (const j of jobs) parts.push(`### ${j.id} (${j.owner ?? "afm"})\n${(await git(["diff", "--no-color", "-U1", j.workspace.base, "HEAD", "--", ".", ":!.afm-build"], j.workspace.dir)).out.slice(0, maxEach)}`);
  return redact(parts.join("\n\n")).text;
}

/** Apply the job's changes to the real project (after the user approved). */
export async function applyJob(job: Job): Promise<{ ok: boolean; files: string[]; error?: string }> {
  const ws = job.workspace;
  await snapshotJob(job);
  const patch = (await git(["diff", "--binary", ws.base, "HEAD", "--", ".", ":!.afm-build"], ws.dir)).out;
  if (!patch.trim()) return { ok: false, files: [], error: "no_changes" };
  const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  for (const f of files) {
    const rel = ws.kind === "worktree" ? relative(realpathSync(job.root), join(realpathSync(ws.repoTop!), f)) : f;
    if (gatePath(rel, job.root, "write").verdict !== "allow") return { ok: false, files, error: `blocked:${f}` };
  }
  const pf = join(jobDir(job.id), "changes.patch");
  writeFileSync(pf, patch, { mode: 0o600 });
  const target = ws.kind === "worktree" ? ws.repoTop! : job.root;
  const chk = await git(["apply", "--check", "--whitespace=nowarn", pf], target);
  if (chk.code !== 0) return { ok: false, files, error: `does_not_apply: ${chk.out.slice(0, 200)}` };
  const r = await git(["apply", "--whitespace=nowarn", pf], target);
  if (r.code !== 0) return { ok: false, files, error: r.out.slice(0, 200) };
  job.status = "applied"; saveJob(job);
  journal(job, `\n## Applied to ${job.root} at ${now()}\n${files.map((f) => `- ${f}`).join("\n")}\n`);
  return { ok: true, files };
}

/** Remove the worktree/copy (the journal and job record stay). */
export async function discardJob(job: Job): Promise<void> {
  const ws = job.workspace;
  if (ws.kind === "worktree" && ws.repoTop) { await git(["worktree", "remove", "--force", ws.dir], ws.repoTop); await git(["branch", "-D", ws.branch], ws.repoTop); rmSync(dirname(ws.dir), { recursive: true, force: true }); }
  else if (ws.dir) rmSync(dirname(ws.dir), { recursive: true, force: true });
  job.status = job.status === "applied" ? "applied" : "discarded"; saveJob(job);
}

/** Prompt for a frontier agent to review/finish a job later. */
export function reviewPrompt(job: Job, ko: boolean): string {
  return [
    ko ? "아래는 인터넷 없이 로컬 AFM이 진행한 작업이에요. 브랜치 전체를 검토하고, 테스트를 돌려서 버그가 있으면 고치고, 남은 단계를 마무리해 주세요. 메인 체크아웃은 사용자가 반영을 승인할 때까지 건드리지 마세요." :
      "Below is work an on-device model did offline. Review the whole branch, run the tests, fix bugs and finish the remaining steps. Do not touch the main checkout until the user approves applying it.",
    `- request: ${job.request}`, `- worktree: ${job.workspace.dir}`, `- branch: ${job.workspace.branch} (base ${job.workspace.base.slice(0, 10)})`, `- journal: ${journalPath(job.id)}`, `- check command: ${job.testCmd ?? "none"}`,
    `- steps: ${job.steps.map((s) => `${s.n}.${s.status}`).join(" ")}`,
  ].join("\n");
}

/** AFM often writes `from text import f` for code in src/text.py. If the module does not exist but a project file
 *  defines every imported name, import from that file's dotted path (as the tests are run from the project root). */
export function resolveImport(work: string, line: string): string {
  const m = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(line.trim());
  if (!m) return line;
  const [, mod, rest] = m;
  const asPath = mod.replace(/\./g, "/");
  if (existsSync(join(work, `${asPath}.py`)) || existsSync(join(work, asPath, "__init__.py"))) return line;
  const names = rest.replace(/[()]/g, "").split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
  const defines = (f: string) => { const t = readFileSync(join(work, f), "utf8"); return names.every((n) => new RegExp(`^(def|class|async def)\\s+${n}\\b|^${n}\\s*=`, "m").test(t)); };
  const hit = projectFiles(work, 400).filter((f) => f.endsWith(".py") && !isTestPath(f)).sort((a, b) => Number(!a.endsWith(`/${asPath.split("/").pop()}.py`)) - Number(!b.endsWith(`/${asPath.split("/").pop()}.py`))).find(defines);
  return hit ? `from ${hit.replace(/\.py$/, "").replace(/\//g, ".")} import ${rest}` : line;
}

export function renderJob(job: Job, ko: boolean): string {
  const icon = (s: JobStep["status"]) => (s === "done" ? "✅" : s === "failed" ? "❌" : s === "skipped" ? "⏭" : "⬜");
  const lines = job.steps.map((s) => `${icon(s.status)} ${s.n}. **${s.action}** ${s.path ? `\`${s.path}\`` : ""} — ${s.description}${s.check ? ` _(${s.check})_` : ""}`);
  return lines.join("\n");
}

export const jobsRoot = () => TREES;
export const jobIdFrom = (s: string) => /\b(\d{8}-[0-9a-f]{6})\b/.exec(s)?.[1];
export const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
