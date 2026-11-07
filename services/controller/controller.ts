// Adaptive controller: deterministic code, not a model.
//   redact → inspect → (document overview fast path) → AFM triage (schema) → rules router
//   → memory recall + seed evidence → bounded guided tool loop → schema answer → citation check
//   → answer, or escalation capsule (frontier only when allowed).
// AFM chooses read-only tools through two-step guided generation; the controller executes them
// through the security gate and feeds bounded, redacted observations back in a task capsule.
// Every task, decision, model call and tool call is recorded in SQLite telemetry (Phase 3).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AFMProvider, AFMRequest, AFMResult } from "../afm-adapter/provider.ts";
import { selectTool, type ToolSpec } from "../afm-adapter/tools.ts";
import { renderCapsule, estimateTokens, type Capsule } from "../context-builder/capsule.ts";
import { gitDiff, gitStatus, listDir, readSnippet, searchCode, spotlightFind } from "../context-builder/retrieval.ts";
import { humanSize, kindOf, letterFacts, PDFTEXT_MISSING, readDocument } from "../context-builder/documents.ts";
import { classifyCommand, execCommand, renderResult } from "../context-builder/terminal.ts";
import { RulesDecisionProvider, type Action, type DecisionProvider, type TaskType } from "../laya-router/decision.ts";
import { DecimaClient, DecimaDecisionProvider, codeDifficulty } from "../laya-router/decima.ts";
import { applyJob, compareJobs, discardJob, journalPath, jobDiffs, jobIdFrom, listJobs, loadJob, planJob, projectFiles, renameRequest, renderJob, runJob, saveJob, type Job } from "./jobs.ts";
import { algorithmic, newCodeRequest } from "./codegen.ts";
import { frontierReachable } from "./frontier-opencode.ts";
import { helpLanguage, helpTopic, isHelpRequest, renderHelp, unknownGitCommand } from "./help.ts";
import { gateCommand, redact } from "../security/gate.ts";
import { loadPolicy, systemFor, type Policy } from "../policy/policy.ts";
import { NullTelemetry, projectHash, type OutcomeClass, type TelemetrySink } from "../telemetry/telemetry.ts";
import { MemoryStore, renderMemory } from "../memory/memory.ts";
import { contractMode, fitLanguage, languageOf, requestLanguage } from "../skills/language.ts";
import { entriesOf, pickSkill, routerMode } from "../skills/router.ts";
import { enabled } from "../skills/settings.ts";
import { loadRegistry } from "../skills/registry.ts";

// the pack that owns a local skill (for the per-skill switch)
let packOf: Map<string, string> | undefined;
const skillOf = (ls: string) => (packOf ??= new Map(loadRegistry().skills.flatMap((s) => Object.keys(s.entries ?? {}).map((e) => [e, s.id] as [string, string])))).get(ls) ?? "core";
import { buildInventory, hasHangul, isInventoryRequest, renderInventory } from "./inventory.ts";
import { findByName, findFiles, findFrame, isFindRequest, kindFromPrompt, nameTerms, renderFound, type FindFrame } from "../context-builder/finder.ts";
import { checkReferences, compileLatex, csvToLatexTable, findMainTex, fixUndefinedMacro, hasTeX, maskLatex, unmaskLatex, isLatexProject, renderLatexReport, trialCompileCommand } from "../context-builder/latex.ts";
import { fetchPage, isWebRequest, kindFor, webSearch, type WebKind } from "../context-builder/websearch.ts";
import { isLongRunning, listSessions, readSession, renderSessions, stopSession } from "../context-builder/sessions.ts";
import { detectTestCommand, diffOf, proposeEdit, sha, trialEdit, renderTrial, type EditProposal, type TrialResult } from "./edit-loop.ts";
import { detectLocalSkill, NO_ROOT, NOT_DELEGATED, WRITES_FILES, routedSkillApplies, runLocalSkill, type LocalSkill } from "./local-skills.ts";
import { frameQuestion, ignoredLine, relevantLines, translationWords, typeMismatch, type Frame } from "./question-frame.ts";
import { toEnglish } from "../context-builder/translate.ts";
import { copilotFiller } from "../frontier/copilot-ls.ts";
import { firstWriter } from "./code-skill.ts";
import { easyContest } from "./code-difficulty.ts";
import { housekeeping } from "../maintenance/housekeeping.ts";

export interface FrontierProvider {
  readonly name: string;
  run(prompt: string, root: string): Promise<{ ok: boolean; text: string; detail?: string }>;
}

export interface Task {
  prompt: string;
  root?: string;             // project folder; undefined → chat only, no file access
  allowFrontier?: boolean;   // frontier calls consume subscription/API usage: off unless asked
  history?: string;          // short, already-redacted prior conversation (chat front-ends)
  frontEnd?: string;         // cli | opencode | test — for telemetry only
  onStep?: (step: Step) => void;   // live progress (the launcher shows each step while the request runs)
  readOnly?: boolean;        // delegated by another agent (MCP afm_task): no apps opened, no local jobs started
}

export type Status = "answered_local" | "answered_frontier" | "escalation_required" | "ask_user" | "failed";

export interface Step { kind: string; detail: string; ms?: number }

export interface Outcome {
  taskId: string;
  status: Status;
  outcomeClass: OutcomeClass;
  answer?: string;
  isProposal?: boolean;       // AFM edit suggestions are never applied automatically
  route: Action;
  reasonCode: string;
  taskType: TaskType;
  capsuleTokens?: number;
  steps: Step[];
  capsule?: string;           // handed to the frontier / user on escalation
  policyVersion: string;
  policyHash: string;
  skill?: string;
  unverifiedPaths?: string[];
  pendingCommand?: string;    // a command AFM wants to run that needs the user's approval
  background?: boolean;       // …and it is long-running: run it in a tmux session
  pendingEdit?: { edit: EditProposal; testCmd?: string };   // AFM edit waiting for "try it in a sandbox + test"
  revealPaths?: string[];     // find-files results the user can reveal in Finder by number
  pendingWeb?: { query: string; kind: WebKind };   // web search waiting for the user's OK (the query leaves the Mac)
  pendingJob?: { id: string; action: "run" | "apply" | "discard" | "review" | "compare"; ids?: string[] };   // local job waiting for the user
}

/** Jobs (branch + worktree) only for code or LaTeX work: the project has such files, or the request names one. */
export function hasWorkTarget(root: string, prompt: string): boolean {
  if (/\.(py|ts|tsx|js|jsx|mjs|go|rs|java|kt|rb|swift|c|cc|cpp|h|hpp|sh|tex|bib|sql|ipynb)\b/i.test(prompt)) return true;
  try { return projectFiles(root, 300).some((f) => /\.(py|ts|tsx|js|jsx|mjs|go|rs|java|kt|rb|swift|c|cc|cpp|h|hpp|sh|tex|bib|sql)$/.test(f)); } catch { return false; }
}

/** Requests that need new files, inserted sections/functions or several files: a local job (to-do list). */
export function isJobRequest(prompt: string): boolean {
  const p = prompt.toLowerCase();
  // Questions about how to do something are answered, not executed ("초록 작성법 알려줘", "how do I add a file?").
  if (/(방법|작성법|어떻게|하는 법|설명해|알려\s?줘|뭐야|무엇|뭔지|명령어|what is|what's|how (do|to|can|should)|explain|why|\?$)/i.test(p) && !/(만들어\s?줘|써\s?줘|넣어\s?줘|추가해\s?줘|작성해\s?줘|구현해\s?줘|추가해\s?줄래|만들어\s?줄래|please (create|write|add)|^(create|write|add|implement|insert)\b)/i.test(p)) return false;
  return /(새\s?(파일|모듈|스크립트)|파일을?\s?(새로\s?)?(만들|생성)|create (a )?(new )?(file|module|script)|new (file|module|script)|add (a )?(new )?(module|file))/i.test(p)
    || /((섹션|절|단락|문단|챕터|장|section|paragraph|chapter|related work|introduction|abstract|conclusion|서론|결론|관련 연구|초록).{0,20}(써|작성|추가|넣어|끼워|draft|write|add|insert))/i.test(p)
    || /((함수|클래스|메서드|function|class|method).{0,20}(추가|넣어|만들어|작성|구현|채워|완성|add|insert|create|write|implement|fill in|complete))/i.test(p)
    || /(여러 파일|multiple files|across (the )?files|기능(을)? (추가|구현)|implement (a |the )?feature|add (a |the )?feature)/i.test(p)
    || /((로컬|오프라인|afm)(로|으로|만으로)\s?(작업|진행|구현|만들|해))/i.test(p);
}

export interface Budget { maxRounds: number; maxToolCalls: number; capsuleTokens: number; afmTimeoutMs: number }
export const DEFAULT_BUDGET: Budget = { maxRounds: 4, maxToolCalls: 6, capsuleTokens: 5500, afmTimeoutMs: 30_000 };

const CONTROLLER_VERSION = "controller-v0.5";   // v0.5: local skills (dev assist, text tools); v0.4: v3 job routing, code_route logs
const LOG_DIR = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "logs");

function logEvent(e: Record<string, unknown>) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    // bench: set by the benchmark harnesses, so calibration from "real requests" can leave those runs out.
    appendFileSync(join(LOG_DIR, "controller.jsonl"), JSON.stringify({ ts: new Date().toISOString(), controller: CONTROLLER_VERSION, ...(process.env.ONBUD_BENCH ? { bench: true } : {}), ...e }) + "\n");
  } catch { /* never let logging break a task */ }
}

const TOOLS: ToolSpec[] = [
  { name: "list_dir", description: "List the files and folders inside one directory, with file type and size.",
    args: { type: "object", properties: { path: { type: "string", description: "Directory relative to the open folder, e.g. docs or . for the top level" } }, required: ["path"] } },
  { name: "read_document", description: "Read the text of one document: PDF, Word, PowerPoint, Excel, Markdown or text file.",
    args: { type: "object", properties: { path: { type: "string", description: "File path relative to the open folder, e.g. paper.pdf" } }, required: ["path"] } },
  { name: "search_code", description: "Find lines in project files that contain an exact text, such as a function or variable name.",
    args: { type: "object", properties: {
      pattern: { type: "string", description: "One identifier or literal that appears in code, e.g. f1_macro or apfel.token — not a sentence" },
      glob: { type: "string", description: "File pattern such as *.py, or * for all files" } }, required: ["pattern", "glob"] } },
  { name: "read_file", description: "Read specific lines of one code or text file.",
    args: { type: "object", properties: {
      path: { type: "string", description: "Project-relative path, e.g. src/app.py" },
      start_line: { type: "integer", description: "First line, 1-based" },
      end_line: { type: "integer", description: "Last line, at most 80 lines after start_line" } }, required: ["path", "start_line", "end_line"] } },
  { name: "find_files", description: "Find files anywhere under the open folder by name or topic (Spotlight).",
    args: { type: "object", properties: { query: { type: "string", description: "File name or topic words" } }, required: ["query"] } },
  { name: "run_command", description: "Run one shell command in the open folder and see its output. Read-only commands run immediately; anything that changes files or runs programs is shown to the user for approval first.",
    args: { type: "object", properties: {
      command: { type: "string", description: "One shell command line. Examples: count Python files → find . -name '*.py' | wc -l ; current branch → git branch --show-current ; recent commits → git log --oneline -5 ; largest files → ls -lS | head -5 ; lines in a file → wc -l path" },
      purpose: { type: "string", description: "Why this command is needed, in a few words" } }, required: ["command", "purpose"] } },
  { name: "ask_user", description: "Ask the user one question when a required detail is missing or ambiguous (e.g. which file, which value). Use instead of guessing.",
    args: { type: "object", properties: { question: { type: "string", description: "One short, specific question in the user's language" } }, required: ["question"] } },
  { name: "git_diff", description: "Show uncommitted changes, optionally for one file.",
    args: { type: "object", properties: { path: { type: "string", description: "Project-relative path, or empty for all files" } }, required: ["path"] } },
];

const TRIAGE_SCHEMA = JSON.parse(readFileSync(new URL("../../policies/schemas/task-triage.schema.json", import.meta.url), "utf8"));

const ANSWER_SCHEMA = {
  type: "object" as const,
  properties: {
    answer: { type: "string" as const, description: "The answer. Cite only file paths that appear in EVIDENCE, with line numbers when available" },
    needs_escalation: { type: "boolean" as const, description: "true only if the evidence is insufficient or the task needs multi-file reasoning or design" },
    assumptions: { type: "array" as const, items: { type: "string" as const }, description: "Unverified assumptions, empty if none" },
  },
  required: ["answer", "needs_escalation", "assumptions"],
  additionalProperties: false,
};

/** Guided generation fills properties in order (Apple, WWDC25/26), so the schema itself can make AFM
 *  ground before answering: first copy short supporting quotes from EVIDENCE, then answer, then pick
 *  cited files from an enum of paths that really are in EVIDENCE (constrained decoding cannot invent one).
 *  ONBUD_ANSWER_SCHEMA=v1 restores the plain schema for A/B checks. */
export function answerSchema(evidencePaths: string[]) {
  if (process.env.ONBUD_ANSWER_SCHEMA === "v1") return ANSWER_SCHEMA;
  const props: Record<string, any> = {
    quotes: { type: "array", items: { type: "string" }, description: "1 to 3 short phrases copied exactly from EVIDENCE that the answer relies on; empty if EVIDENCE has nothing relevant" },
    answer: ANSWER_SCHEMA.properties.answer,
  };
  if (evidencePaths.length) props.cited_files = { type: "array", items: { type: "string", enum: evidencePaths.slice(0, 30) }, description: "Files from EVIDENCE the answer is based on; empty if none" };
  props.needs_escalation = ANSWER_SCHEMA.properties.needs_escalation;
  props.assumptions = ANSWER_SCHEMA.properties.assumptions;
  return { type: "object" as const, properties: props, required: Object.keys(props), additionalProperties: false };
}

/** Paths that appear in the capsule evidence: block labels ("file x", "document x") and search hits ("x:12:"). */
export function evidencePaths(evidence: { label: string; body: string }[]): string[] {
  const out = new Set<string>();
  for (const e of evidence) {
    const m = /^(?:file|document|letter structure of) (.+)$/.exec(e.label);
    if (m) out.add(m[1]);
    for (const h of e.body.matchAll(/^([^\s:]+\.[A-Za-z0-9]{1,6}):\d+:/gm)) out.add(h[1]);
  }
  return [...out];
}

/** Share of quotes that really occur in the evidence (whitespace/case-insensitive). */
export function quotesGrounded(quotes: string[] | undefined, evidenceText: string): number {
  const q = (quotes ?? []).map((x) => x.trim()).filter((x) => x.length >= 3);
  if (!q.length) return 1;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  const ev = norm(evidenceText);
  return q.filter((x) => ev.includes(norm(x))).length / q.length;
}

const DOC_EXT = "pdf|docx?|pptx|xlsx|rtf|odt|key|pages|numbers|hwp|csv|tex|bib";
const FILE_REF = new RegExp(`(?:^|[\\s\`'"(])((?:[\\w.-]+\\/)*[\\w.\\[\\]-]+\\.(?:py|ts|tsx|js|jsx|mjs|md|json|ya?ml|toml|txt|log|sh|swift|go|rs|java|kt|c|cc|cpp|h|hpp|rb|sql|ipynb|cfg|ini|png|jpe?g|heic|heif|tiff?|gif|bmp|webp|html?|zip|${DOC_EXT}))(?::(\\d+))?(?![\\w])`, "gi");   // lookahead: "data.csv" must not match as "data.c"
const IDENT = /`([^`\n]{2,60})`|\b([A-Za-z_][A-Za-z0-9]*_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+)\b/g;

/** Files named by an absolute or ~/ path that exist inside the home folder (no project folder open). Used only for
 *  the convert skill, which writes new files next to its inputs; nothing else reads files outside a project. */
export function homeFiles(prompt: string): { path: string }[] {
  const home = homedir(), out: string[] = [];
  const re = /(?:^|[\s`'"(“‘])((?:~\/|\/)[^\s`'"”’)]+?\.(?:png|jpe?g|heic|heif|tiff?|gif|bmp|webp|pdf|txt|rtf|html?|docx?|odt))(?=$|[\s`'"”’),.!?]|[가-힣])/gi;
  for (const m of prompt.matchAll(re)) {
    const abs = resolve(m[1].startsWith("~/") ? join(home, m[1].slice(2)) : m[1]).normalize("NFC");
    if (!abs.startsWith(home + "/") || out.includes(abs)) continue;
    try { if (statSync(abs).isFile()) out.push(abs); } catch { /* missing */ }
  }
  return out.map((path) => ({ path }));
}

export function mentionedFiles(prompt: string, root: string): { path: string; line?: number }[] {
  const out = new Map<string, number | undefined>();
  for (const m of prompt.matchAll(FILE_REF)) {
    if (existsSync(resolve(root, m[1]))) out.set(m[1], m[2] ? Number(m[2]) : undefined);
  }
  for (const p of spacedPaths(prompt, root)) if (![...out.keys()].some((k) => resolve(root, k) === resolve(root, p))) out.set(p, undefined);
  // A name written without its extension that is exactly a top-level file's name ("the README" → README.md): only
  // when no file was named otherwise, and only names of 4+ characters, so ordinary words rarely match.
  if (!out.size) {
    let top: string[] = [];
    try { top = readdirSync(root).filter((n) => !n.startsWith(".") && /\.[A-Za-z0-9]{1,5}$/.test(n)); } catch { /* no folder */ }
    for (const w of prompt.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? []) {
      const hit = top.filter((n) => n.replace(/\.[^.]+$/, "") === w || n.replace(/\.[^.]+$/, "").toLowerCase() === w.toLowerCase() && w === w.toUpperCase());
      if (hit.length === 1 && statSync(resolve(root, hit[0])).isFile()) out.set(hit[0], undefined);
    }
  }
  return [...out].map(([path, line]) => ({ path, line }));
}

/** Paths written with spaces, Hangul, brackets or commas ("연구 자료/약제급여목록_(2025.6.1.)(21,983).xlsx", absolute,
 *  ~/… or relative): for each document extension, the longest text before it that names an existing file inside the
 *  root. Files outside the root are not read. */
export function spacedPaths(prompt: string, root: string): string[] {
  const out: string[] = [];
  const R = resolve(root).normalize("NFC");
  for (const m of prompt.matchAll(new RegExp(`\\.(?:${DOC_EXT}|txt|md|log|json|tsv|xlsm)(?![A-Za-z0-9])`, "gi"))) {
    const end = m.index! + m[0].length;
    for (let i = Math.max(0, end - 400); i < m.index!; i++) {
      if (i > 0 && !/[\s`'"“‘(]/.test(prompt[i - 1])) continue;
      let s = prompt.slice(i, end).replace(/^[`'"“‘(]+/, "");
      if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
      const abs = (isAbsolute(s) ? s : resolve(root, s)).normalize("NFC");
      if (!abs.startsWith(R + "/")) continue;
      try { if (!statSync(abs).isFile()) continue; } catch { continue; }
      out.push(relative(R, abs));
      break;
    }
  }
  return out;
}

const NAME_STOP_KO = new Set(["자료", "최종", "파일", "문서", "수정", "사본", "복사", "초안", "완료", "공개용"]);
const NAME_STOP = new Set(["the", "and", "for", "final", "accepted", "camera", "copy", "draft", "file", "document", "pdf", "doc", "docx", "pptx", "new", "old", "ver", "version", "v1", "v2", "v3"]);

/** Documents named loosely ("Award Letter 문서" → "Workshop Award Letter.pdf"): file-name words found in
 *  the request. Returns the single best match, or nothing when two files match equally well. */
export function namedDocuments(prompt: string, root: string): { path: string }[] {
  const p = prompt.toLowerCase().normalize("NFC");
  const pre = p.split(/[^\p{L}\p{N}]+/u).flatMap((w) => /[\uac00-\ud7a3]/.test(w) ? [...w].map((_, k) => [...w].slice(0, k + 1).join("")).filter((x) => [...x].length >= 3) : [...w].length >= 5 ? [w] : []);
  const scored: { path: string; score: number }[] = [];
  const visit = (rel: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(resolve(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 2) visit(r, depth + 1); continue; }
      if (!["pdf", "word", "slides", "sheet", "text"].includes(kindOf(e.name))) continue;
      // Two-character words ("Q3", "리뷰") count only as whole words at a word start, never inside another word.
      const toks = e.name.normalize("NFC").toLowerCase().replace(/\.[^.]+$/, "").split(/[^\p{L}\p{N}]+/u).filter((t) => [...t].length >= 2 && !NAME_STOP.has(t) && !NAME_STOP_KO.has(t) && !/^\d+$/.test(t));
      const said = (t: string) => ([...t].length >= 3 ? p.includes(t) : new RegExp(`(^|[^\\p{L}\\p{N}])${t}(?![a-z0-9])`, "u").test(p));
      // Also a request word inside a long file-name word ("약제급여목록" in "약제급여목록및급여상한금액표"):
      // Korean words by prefixes of 3+ syllables (particles stripped), Latin words of 5+ letters.
      const hit = toks.filter((t) => said(t) || pre.some((w) => t.includes(w)));
      // Korean words are short but specific; a two-syllable one is strong only next to another hit.
      const strong = (t: string) => [...t].length >= 6 || (/[\uac00-\ud7a3]/.test(t) && [...t].length >= 3);
      const wantKind = kindFromPrompt(prompt);
      const score = hit.length + hit.reduce((n, t) => n + (strong(t) ? 0.5 : 0), 0) + (wantKind !== "any" && kindOf(e.name) === wantKind ? 0.25 : 0);
      if (hit.length >= 2 || (hit.length === 1 && strong(hit[0]))) scored.push({ path: r, score });
    }
  };
  visit("", 0);
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return [];
  return [{ path: scored[0].path }];
}

export function identifiers(prompt: string): string[] {
  const s = new Set<string>();
  for (const m of prompt.matchAll(IDENT)) {
    const v = (m[1] ?? m[2]).trim();
    if (!FILE_REF.test(` ${v}`) && !/\s/.test(v)) s.add(v);
    FILE_REF.lastIndex = 0;
  }
  return [...s].slice(0, 3);
}

/** Paths the answer cites that do not exist and were not in the evidence (fm-guide: "constrained
 *  decoding enforces structure, never truth" — so check cited files deterministically). */
export function unverifiedPaths(answer: string, root: string, evidence: string): string[] {
  const bad = new Set<string>();
  for (const m of answer.matchAll(FILE_REF)) {
    const p = m[1];
    if (existsSync(resolve(root, p)) || evidence.includes(p) || evidence.includes(basename(p))) continue;
    bad.add(p);
  }
  FILE_REF.lastIndex = 0;
  return [...bad];
}

// ---- terminal-style intents: run safe read-only commands up front instead of hoping AFM picks them.
// Mini terminal tasks showed AFM picking the first listed tool with invented paths and miscounting
// lines itself; deterministic seeds give it exact facts (counts, sizes, git state) to answer from.
const EXCLUDE_GIT = "-not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.build/*'";
const KNOWN_EXT = new Set(["py", "ts", "tsx", "js", "jsx", "md", "json", "yaml", "yml", "swift", "rs", "go", "java", "kt", "rb", "sh", "pdf", "csv", "tex", "ipynb", "html", "css", "txt", "docx", "pptx", "xlsx", "c", "cpp", "h"]);
export function intentSeeds(prompt: string, files: { path: string }[], root?: string): { label: string; command: string }[] {
  const p = prompt.toLowerCase();
  // A folder named in the request ("services 폴더에", "in docs/") scopes the counts; a Korean particle after the
  // name is stripped. Only real folders inside the root, as a plain relative path.
  const dir = root ? prompt.normalize("NFC").split(/[\s,?!'"`]+/).map((w) => w.replace(/[\uac00-\ud7a3]+$/, "").replace(/\/+$/, ""))
    .find((w) => /^[\w.-]+(\/[\w.-]+)*$/.test(w) && !w.startsWith(".") && (() => { try { return statSync(join(root, w)).isDirectory(); } catch { return false; } })()) : undefined;
  const at = dir ? `./${dir}` : ".";
  const seeds: { label: string; command: string }[] = [];
  if (/\b(git|branch|commit|commits|log|history|diff|staged|uncommitted)\b|브랜치|커밋|변경\s?사항|이력/.test(p)) {
    seeds.push({ label: "git state", command: "git branch --show-current; git status --short | head -20; git log --oneline -8" });
  }
  // A named language/extension gets its own exact count (AFM once answered the total instead of the .py count).
  const LANG_EXT: Record<string, string> = { python: "py", typescript: "ts", javascript: "js", markdown: "md", swift: "swift", rust: "rs", golang: "go", java: "java", kotlin: "kt", ruby: "rb", shell: "sh", pdf: "pdf", csv: "csv", json: "json", yaml: "yaml", latex: "tex", notebook: "ipynb", 파이썬: "py", 타입스크립트: "ts", 자바스크립트: "js", 마크다운: "md" };
  const exts = new Set<string>();
  for (const [w, e] of Object.entries(LANG_EXT)) if (p.includes(w)) exts.add(e);
  for (const m of p.matchAll(/(?:^|\s)\*?\.([a-z0-9]{1,6})\b(?=\s|$|\s?(files?|파일))/g)) exts.add(m[1]);
  // A bare known extension before "파일"/"files" ("ts 파일이 몇 개") counts too.
  for (const m of p.matchAll(/(?:^|\s)([a-z0-9]{1,6})\s?(?:files?|파일)/g)) if (KNOWN_EXT.has(m[1])) exts.add(m[1]);
  if (/(how many|count|number of|몇\s?개|개수|갯수)/.test(p) && !files.length) {
    for (const e of [...exts].slice(0, 3)) seeds.push({ label: `count of .${e} files in ${at} (including subfolders)`, command: `find ${at} -type f -name '*.${e}' ${EXCLUDE_GIT} | wc -l` });
    seeds.push({ label: `files by extension in ${at}`, command: `find ${at} -type f ${EXCLUDE_GIT} | sed -n 's/.*\\.\\([A-Za-z0-9]*\\)$/\\1/p' | sort | uniq -c | sort -rn | head -15; echo total files: $(find ${at} -type f ${EXCLUDE_GIT} | wc -l)` });
  }
  if (/(largest|biggest|smallest|size|disk|용량|크기|큰 파일|작은 파일)/.test(p)) {
    seeds.push({ label: "largest files (KB)", command: `find . -type f ${EXCLUDE_GIT} -print0 | xargs -0 du -k 2>/dev/null | sort -rn | head -10` });
  }
  if (/(lines?|줄|라인|행)/.test(p)) {
    for (const f of files.slice(0, 3)) seeds.push({ label: `line count ${f.path}`, command: `wc -l < '${f.path.replace(/'/g, "")}'` });
  }
  if (/(structure|tree|layout|what('?s| is) (in|inside)|폴더 구조|구조)/.test(p) && !seeds.length) {
    seeds.push({ label: "folder tree", command: `find . -maxdepth 2 ${EXCLUDE_GIT} | sort | head -60` });
  }
  return seeds;
}

/** A shell command typed as the whole message: one line whose first word is an installed program (or a path to
 *  one), with no Korean, no question mark and no conversational words ("make me a sandwich" is not a command). */
const CMD_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".opencode", "bin"), join(homedir(), ".local", "bin"), join(homedir(), ".cargo", "bin")];
export function typedCommand(prompt: string): string | undefined {
  const t = prompt.trim().replace(/^\$\s+/, "");
  if (!t || t.includes("\n") || t.length > 200 || /[\uac00-\ud7a3?]/.test(t) || /\s(me|my|you|your|please|how|why|what|which|can|could|should|would|i|we|is|are)\b/i.test(` ${t}`)) return undefined;
  const head = /^([A-Za-z0-9_.~/-]+)(\s|$)/.exec(t)?.[1];
  if (!head || /^(open|say|yes|no|true|false|test|time|which|find|help|hi|hello|ok|okay)$/i.test(head)) return undefined;
  const found = head.includes("/") ? existsSync(head.replace(/^~(?=\/)/, homedir())) : CMD_DIRS.some((d) => existsSync(join(d, head)));
  return found ? t : undefined;
}

/** BFCL "missing parameter": an action on a file with no file named → ask instead of guessing a target. */
export function missingTarget(prompt: string, files: { path: string }[]): string | undefined {
  if (files.length || identifiers(prompt).length || prompt.length > 80) return undefined;
  const p = prompt.toLowerCase();
  const rename = /\brename\b|이름.*(바꿔|변경)/.test(p);
  if (!rename && !/\b(move|delete|remove|edit|modify|fix|update)\b|옮겨|이동|삭제|지워|고쳐|수정/.test(p)) return undefined;
  if (/\b(folder|directory|dir)\s+\S+|\S+\s+(폴더|디렉토리)/.test(p) && !/(the|that|this|그|이)\s*(folder|폴더)/.test(p)) return undefined;
  const ko = /[\uac00-\ud7a3]/.test(prompt);
  return ko
    ? `어떤 파일을 대상으로 할까요? 파일 경로${rename ? "와 새 이름" : ""}을 알려 주세요.`
    : `Which file do you mean? Please give the path${rename ? " and the new name" : ""}.`;
}

// "which file defines X", "where is X set", "어느 파일에서 X를 정의", "X는 어디서 설정돼"
const LOCATE = /\b(which|what) (file|files|module|config)\b|\bwhere (is|are|do|does)\b.{0,60}\b(defined|set|configured|declared|implemented|stored)\b|(어느|어떤|무슨)\s?(파일|모듈|설정)|어디(에|서)\s?(정의|설정|선언|구현)/i;
const STOPW = new Set(["which", "what", "where", "file", "files", "module", "defines", "define", "defined", "sets", "set", "configured", "declared", "implemented", "stored", "does", "the", "this", "that", "with", "from", "into", "have", "there", "about", "어느", "어떤", "파일", "정의", "설정", "어디", "있어", "하는", "되어", "돼"]);
/** Content words of a request, longest first; a plural "s" dropped ("thresholds" → "threshold"). */
export function contentTerms(prompt: string): string[] {
  const words = (prompt.match(/[A-Za-z][A-Za-z0-9_-]{3,}|[가-힣]{2,}/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOPW.has(w));
  return [...new Set(words.map((w) => (/[a-z]{4,}s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w)))].sort((a, b) => b.length - a.length);
}
/** Existing folders the request names by path ("policies/skills", "src"), inside the project. */
export function namedDirs(prompt: string, root: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+)\/?(?=[\s`'").,?!]|$)/g)) {
    const rel = m[1].replace(/\.$/, "");
    if (!rel || rel.startsWith(".") || rel.length < 2) continue;
    try { if (statSync(resolve(root, rel)).isDirectory() && resolve(root, rel).startsWith(resolve(root) + "/")) out.push(rel); } catch { /* not a folder */ }
  }
  return [...new Set(out)];
}
function listing(root: string, rel: string): string {
  try {
    return readdirSync(resolve(root, rel), { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).slice(0, 60)
      .map((e) => e.isDirectory() ? `${e.name}/` : `${e.name} (${humanSize(statSync(resolve(root, rel, e.name)).size)})`).join("\n");
  } catch { return "(unreadable)"; }
}

/** Does the request need the open folder at all? (math, general knowledge → answer directly) */
export function needsProject(prompt: string, files: { path: string }[]): boolean {
  if (files.length || identifiers(prompt).length) return true;
  return /(file|folder|directory|dir\b|code|repo|project|function|class|test|bug|error|git|branch|commit|build|run|install|read|open|rename|delete|move|파일|폴더|디렉토리|코드|함수|클래스|테스트|버그|에러|오류|브랜치|커밋|빌드|실행|설치|읽어|열어|이름|삭제|이동|여기|이 프로젝트)/i.test(prompt);
}

/** At most 5 tools per request (fm-guide/OpenAppleModels: long tool menus degrade selection). */
export function toolsFor(prompt: string, taskType: TaskType, all: ToolSpec[]): ToolSpec[] {
  const p = prompt.toLowerCase();
  const pick = (...names: string[]) => names.map((n) => all.find((t) => t.name === n)!).filter(Boolean);
  if (taskType === "document_question") return pick("read_document", "list_dir", "find_files", "ask_user");
  if (/\b(git|branch|commit|diff|log)\b|브랜치|커밋/.test(p)) return pick("run_command", "git_diff", "read_file", "ask_user");
  if (/(run|test|build|install|execute|실행|테스트|빌드|설치)/.test(p)) return pick("run_command", "list_dir", "read_file", "ask_user");
  if (/(defin|function|class|method|where is|implement|정의|함수|클래스|메서드|구현)/.test(p) || identifiers(prompt).length) return pick("search_code", "read_file", "list_dir", "ask_user");
  return pick("list_dir", "read_file", "run_command", "search_code", "ask_user");
}

export interface ControllerDeps {
  afm: AFMProvider;
  decision?: DecisionProvider;
  frontier?: FrontierProvider;
  budget?: Partial<Budget>;
  policy?: Policy;
  telemetry?: TelemetrySink;
  memory?: MemoryStore;
  db?: DatabaseSync;          // document text cache
}

export class Controller {
  private hkDb?: DatabaseSync;   // housekeeping: log rotation and document-cache pruning, at most once a day
  private afm: AFMProvider;
  private decision: DecisionProvider;
  private frontier?: FrontierProvider;
  private budget: Budget;
  private policy: Policy;
  private tel: TelemetrySink;
  private memory?: MemoryStore;
  private db?: DatabaseSync;
  decimaClient?: DecimaClient;

  constructor(deps: ControllerDeps) {
    this.policy = deps.policy ?? loadPolicy();
    this.hkDb = deps.db;
    this.afm = deps.afm;
    const rules = new RulesDecisionProvider(this.policy.rules);
    const dc = { ...this.policy.decision.decima, ...(process.env.ONBUD_DECIMA_MODE ? { mode: process.env.ONBUD_DECIMA_MODE as any } : {}) };
    if (dc.mode !== "off") this.decimaClient = new DecimaClient(dc);
    this.decision = deps.decision ?? (dc.mode === "off" ? rules : new DecimaDecisionProvider(rules, this.decimaClient!, (meta, base, d) => {
      // Shadow/advice record: what the rules chose vs Decima's pick, for the rules-vs-Decima comparison.
      const ok = !("error" in d);
      this.tel.decision({ taskId: (meta as any).taskId ?? "unknown", provider: `decima-${dc.mode}`, candidates: [], action: ok ? (d.route as Action) : base.action,
        reasonCode: ok ? `decima_${d.route}${d.route === base.action ? "_agrees" : "_differs"}` : `decima_error:${d.error}`, afmAvailable: meta.localAfmAvailable,
        rawScores: ok ? { ...(d.probabilities ?? {}), confidence: d.confidence ?? 0, secret: d.secret ?? 0, destructive: d.destructive ?? 0, ms: d.ms } : undefined, riskSignals: [] });
    }));
    this.frontier = deps.frontier;
    this.tel = deps.telemetry ?? new NullTelemetry();
    this.memory = process.env.ONBUD_MEMORY === "off" ? undefined : deps.memory;   // benchmark settings run without memory
    this.db = deps.db;
    const a = this.policy.afm;
    this.budget = { ...DEFAULT_BUDGET, maxRounds: a.maxRounds, maxToolCalls: a.maxToolCalls, capsuleTokens: a.maxInputTokens, afmTimeoutMs: a.timeoutMs, ...deps.budget };
  }

  /** AFM provider wrapper that records every call in telemetry with its purpose. */
  private tracked(taskId: string): AFMProvider {
    const inner = this.afm;
    const tel = this.tel;
    const purposeOf = (r: AFMRequest) =>
      r.user.startsWith("Triage this request:") ? "triage"
        : r.schema?.properties?.action ? "select_tool"
        : r.system.startsWith("Fill in the arguments") ? "tool_args"
        : r.schema?.properties?.needs_escalation ? "answer"
        : r.system.startsWith("You describe one file") ? "describe_file" : "other";
    return {
      name: inner.name,
      health: () => inner.health(),
      async generate(req: AFMRequest): Promise<AFMResult> {
        const r = await inner.generate(req);
        tel.modelCall({ taskId, provider: inner.name, model: "apple-foundationmodel", purpose: purposeOf(req), ok: r.ok, failure: r.failure,
          promptTokens: r.usage?.prompt, completionTokens: r.usage?.completion, latencyMs: r.latencyMs, costType: "local" });
        return r;
      },
    };
  }

  /** One request: the routing below, then the reply-language contract (services/skills/language.ts) on whatever
   *  answer came back. ONBUD_LANG_CONTRACT: on (default) translates, shadow logs a mismatch, off skips it. */
  async handle(task: Task): Promise<Outcome> {
    const o = await this.route(task);
    const mode = contractMode();
    if (mode === "off" || !o.answer || (o.status !== "answered_local" && o.status !== "ask_user")) return o;
    const { text: prompt } = redact(task.prompt);
    const want = requestLanguage(prompt), got = languageOf(o.answer);
    if (!got || got === want) return o;
    logEvent({ taskId: o.taskId, event: "lang_mismatch", want, got, mode, reasonCode: o.reasonCode });
    if (mode === "shadow") { o.steps.push({ kind: "lang_check", detail: `mismatch ${got}→${want} (shadow)` }); return o; }
    const t0 = Date.now();
    const fit = await fitLanguage(this.tracked(o.taskId), o.answer, want, this.budget.afmTimeoutMs);
    o.steps.push({ kind: "lang_check", detail: `${got}→${want}: ${fit.why}`, ms: Date.now() - t0 });
    if (fit.text) o.answer = fit.text;
    return o;
  }

  private async route(task: Task): Promise<Outcome> {
    housekeeping(this.hkDb);   // returns at once unless a day has passed (state file); never throws
    const taskId = randomUUID();
    const t0 = Date.now();
    const steps: Step[] = [];
    if (task.onStep) { const push = steps.push.bind(steps); steps.push = (...s: Step[]) => { s.forEach((x) => task.onStep!(x)); return push(...s); }; }
    const root = task.root ? resolve(task.root) : undefined;
    const proj = projectHash(root);
    const afm = this.tracked(taskId);
    const { text: prompt, found: secrets } = redact(task.prompt);
    if (secrets.length) steps.push({ kind: "redact", detail: secrets.join(",") });
    this.tel.startTask({ taskId, root, frontEnd: task.frontEnd ?? "unknown", complexityTokens: estimateTokens(prompt) });
    const pv = { policyVersion: this.policy.version, policyHash: this.policy.hash };
    // the request's own words decide (a Korean folder name in an English request is not Korean), with the
    // contract on; otherwise any Hangul, as before
    const ko = contractMode() === "on" ? requestLanguage(prompt) === "ko" : hasHangul(prompt);

    let route: Action = "LOCAL_AFM";
    let reasonCode = "";
    let taskType: TaskType = "other";
    let skill: string | undefined;
    const finish = (o: Partial<Outcome> & { status: Status; outcomeClass: OutcomeClass }): Outcome => {
      const out: Outcome = { taskId, route, reasonCode, taskType, steps, skill, ...pv, ...o } as Outcome;
      this.tel.endTask({ taskId, taskType: out.taskType, ...pv, skill: out.skill, status: out.status, outcomeClass: out.outcomeClass,
        reasonCode: out.reasonCode, capsuleTokens: out.capsuleTokens, latencyMs: Date.now() - t0 });
      logEvent({ taskId, event: "outcome", status: out.status, outcomeClass: out.outcomeClass, route: out.route, reasonCode: out.reasonCode, capsuleTokens: out.capsuleTokens, nSteps: steps.length });
      return out;
    };

    // 1. Deterministic inspection
    let files = root ? mentionedFiles(prompt, root) : [];
    // No project folder: a conversion of files named by absolute or ~/ paths still runs (and only that skill).
    if (!root) { const hf = homeFiles(prompt); if (hf.length && detectLocalSkill(prompt, hf) === "convert") files = hf; }
    if (root && !files.length && /(문서|파일|논문|편지|서신|슬라이드|발표|보고서|원고|증명서|엑셀|시트|스프레드시트|목록|명단|파워포인트|프레젠테이션|document|file|paper|letter|slides|report|pdf|excel|sheet|spreadsheet|xlsx|csv|pptx?|presentation|deck)/i.test(prompt)) files = namedDocuments(prompt, root);
    const spans = [...prompt.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const dangerous = spans.find((s) => gateCommand(s, root ?? homedir()).verdict === "deny");
    const health = await afm.health();

    // 1-skills. Local developer/text skills (commit message, change summary, release notes, error triage, action-item
    // table, translation, docstrings, privacy scan, CSV↔JSON): code gathers and checks, AFM fills a small schema.
    // Skills need the project folder, except the Mac health check, the security check (system and home parts only
    // when no project is open) and opening a terminal (in the home folder).
    const lsAny = !dangerous && health.ok ? detectLocalSkill(prompt, files) : undefined;
    const ls = lsAny && (root || NO_ROOT.has(lsAny)) && !(task.readOnly && NOT_DELEGATED.has(lsAny)) ? lsAny : undefined;
    if (task.readOnly && lsAny && NOT_DELEGATED.has(lsAny))
      return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "read_only_app",
        answer: "A delegated AFM task does not open apps or terminal windows; ask the user to do it, or do it with your own tools." });
    // Delegated work (afm_task) never starts a local job: that changes a worktree and runs for minutes.
    const noJob = () => finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "read_only_job",
      answer: "This needs a multi-step change (a local job), which a delegated AFM task does not run. Do it with your own tools." });
    // the skill run, shared by a rule match here and a router pick before the generic path (P3)
    const runSkill = async (ls: LocalSkill, routed = false): Promise<Outcome | undefined> => {
      const before = { taskType, reasonCode, skill };
      taskType = ls === "docstrings" ? "small_edit" : "other";
      reasonCode = `local_${ls}`;
      skill = ls;
      steps.push({ kind: "skill", detail: routed ? `${ls} (router)` : ls });   // shown live by the launcher before the skill runs
      const ts = Date.now();
      const r = await runLocalSkill(ls, { afm, root: root ?? "", prompt, files, ko, history: task.history, decima: this.decimaClient, timeoutMs: this.budget.afmTimeoutMs });
      steps.push({ kind: `skill_${ls}`, detail: r.detail, ms: Date.now() - ts });
      // Declined (e.g. no word of the request is in the sheet): not this skill after all, route as usual.
      if (r.declined) ({ taskType, reasonCode, skill } = before);
      else {
        this.tel.decision({ taskId, provider: "rules", candidates: ["LOCAL_AFM", "FRONTIER_GPT", "ASK_USER"], action: "LOCAL_AFM", reasonCode, afmAvailable: health.ok, riskSignals: [] });
        this.tel.verification({ taskId, kind: `skill_${ls}`, passed: r.verified, detail: r.detail });
        if (r.pendingEdit) return finish({ status: "answered_local", outcomeClass: "local_unverified", isProposal: true, answer: r.answer, pendingEdit: { ...r.pendingEdit, testCmd: r.pendingEdit.testCmd ?? detectTestCommand(root!) } });
        if (r.pendingCommand) return finish({ status: "ask_user", outcomeClass: "asked_user", answer: r.answer, pendingCommand: r.pendingCommand });
        return finish({ status: "answered_local", outcomeClass: r.verified ? "local_verified" : "local_unverified", answer: r.answer });
      }
      return undefined;
    };
    // a skill the user turned off (config/skills.json) answers how to turn it on, for rule stages too
    const disabled = (id: string) => finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "skill_disabled",
      answer: ko ? `이 기능(${id})은 꺼져 있어요. OnBud 설정 > Skills에서 켜거나 \`~/OnBud/config/skills.json\`을 바꿔 주세요.`
        : `This skill (${id}) is turned off. Turn it on in OnBud Settings > Skills, or in \`~/OnBud/config/skills.json\`.` });
    if (ls && !enabled(skillOf(ls))) return disabled(skillOf(ls));
    if (ls) { const out = await runSkill(ls); if (out) return out; }

    // 1b. Document/folder overview: deterministic pipeline, AFM only describes single files.
    if (!dangerous && isInventoryRequest(prompt)) {
      taskType = "document_overview";
      reasonCode = "local_document_overview";
      skill = "doc-inventory";
      this.tel.decision({ taskId, provider: "rules", candidates: ["LOCAL_AFM", "FRONTIER_GPT", "ASK_USER"], action: "LOCAL_AFM", reasonCode, afmAvailable: health.ok, riskSignals: [] });
      if (!root) {
        return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "needs_project_folder",
          answer: ko
            ? "폴더 안의 문서를 보려면 그 폴더를 열어 주세요. OpenCode 데스크톱에서는 그 폴더를 프로젝트로 열고, CLI에서는 `cd <폴더> && opencode`로 실행하면 돼요. 홈 폴더 전체는 개인정보 보호를 위해 검색하지 않아요."
            : "Open that folder first: in the OpenCode desktop app open it as the project, or run `cd <folder> && opencode`. The whole home folder is not searched, for privacy." });
      }
      const ts = Date.now();
      const inv = await buildInventory(root, prompt, {
        afm: health.ok ? afm : { name: "none", health: async () => ({ ok: false }), generate: async () => ({ ok: false, failure: "unavailable", latencyMs: 0 }) },
        db: this.db, memory: this.memory, projectHash: proj, timeoutMs: this.budget.afmTimeoutMs,
        onCall: (purpose, ok, ms, failure) => steps.push({ kind: purpose, detail: ok ? "ok" : `failed:${failure}`, ms }),
      });
      this.tel.toolCall({ taskId, tool: "inventory", ok: true, durationMs: Date.now() - ts, resultChars: inv.items.length });
      steps.push({ kind: "inventory", detail: `${inv.items.length} files in ${inv.dir}`, ms: Date.now() - ts });
      this.tel.verification({ taskId, kind: "inventory_paths_exist", passed: true, detail: "rendered from directory listing" });
      return finish({ status: "answered_local", outcomeClass: "local_verified", answer: renderInventory(inv) });
    }

    // 1a. Command help (catalogue, Korean/English); a git command outside it is explained by AFM.
    if (!dangerous && isHelpRequest(prompt)) {
      reasonCode = "local_help";
      const lang = helpLanguage(prompt);
      const unknown = unknownGitCommand(prompt);
      if (unknown && health.ok) {
        const r = await afm.generate({ system: `Explain the git command briefly in ${lang === "ko" ? "Korean" : "English"}: what it does, one typical example, and a safety note if it can lose work or rewrite history.`,
          user: unknown, maxTokens: 400, timeoutMs: this.budget.afmTimeoutMs, schema: { type: "object", properties: { explanation: { type: "string" } }, required: ["explanation"], additionalProperties: false } });
        if (r.ok) return finish({ status: "answered_local", outcomeClass: "local_unverified", answer: `**${unknown}**\n\n${(r.json as any).explanation}\n\n_${lang === "ko" ? "AFM 설명이에요. 정확한 옵션은 `git help " + unknown.slice(4) + "`로 확인하세요." : "Explained by the on-device model; see `git help " + unknown.slice(4) + "` for exact options."}_` });
      }
      return finish({ status: "answered_local", outcomeClass: "local_verified", answer: renderHelp(helpTopic(prompt), lang) });
    }

    // 1b'. Web search: AFM writes the query, the user approves it, then search + read top pages.
    if (!dangerous && isWebRequest(prompt) && !enabled("web")) return disabled("web");
    if (!dangerous && isWebRequest(prompt) && process.env.ONBUD_WEB === "off") {
      reasonCode = "web_disabled";
      return finish({ status: "escalation_required", outcomeClass: "escalation_pending", answer: ko ? "웹 검색이 꺼져 있어요(오프라인 설정)." : "Web search is turned off in this setting." });
    }
    if (!dangerous && isWebRequest(prompt)) {
      taskType = "other";
      reasonCode = "web_search_needs_approval";
      let query = prompt.replace(/(웹에서|웹 검색(해줘|해 줘)?|인터넷(에서)?|온라인(에서)?|검색해\s?(줘|봐)|찾아\s?(줘|봐)|알려\s?줘|search (the )?web( for)?|look up)/gi, " ").replace(/\s+/g, " ").trim();
      if (health.ok) {
        const qg = await afm.generate({ system: "Write one concise web search query (3-8 words) for the user's request. Keep names, versions and technical terms exactly; use English for technical topics unless the topic is Korea-specific. Never include file contents, paths or personal data.",
          user: prompt, maxTokens: 60, timeoutMs: this.budget.afmTimeoutMs,
          schema: { type: "object", properties: { query: { type: "string", description: "The search query" } }, required: ["query"], additionalProperties: false } });
        steps.push({ kind: "web_query", detail: qg.ok ? "ok" : `failed:${qg.failure}`, ms: qg.latencyMs });
        if (qg.ok && String((qg.json as any).query ?? "").trim().length >= 3) query = String((qg.json as any).query).trim();
      }
      query = redact(query).text.slice(0, 200);
      const kind = kindFor(prompt);
      const where = kind === "papers" ? "arXiv" : kind === "encyclopedia" ? "Wikipedia" : (ko ? "검색 엔진(SearXNG가 켜져 있으면 SearXNG, 아니면 DuckDuckGo)" : "a search engine (SearXNG if running, else DuckDuckGo)");
      return finish({ status: "ask_user", outcomeClass: "asked_user", pendingWeb: { query, kind },
        answer: ko ? `다음 검색어로 웹 검색을 할까요? 검색어는 ${where}로 전송되고, 결과 페이지 몇 개를 읽어서 답해요.\n\n\`${query}\`\n\n(\`예\` / \`아니요\`, 검색어를 바꾸려면 새 검색어를 보내 주세요)`
          : `Search the web for this? The query goes to ${where}; I then read the top pages and answer.\n\n\`${query}\`\n\n(\`yes\` / \`no\`, or send a different query)` });
    }

    // 1c. Find files/folders by name across this Mac (Spotlight + hidden folders). Stays on-device:
    // never handed to Codex, not stored in memory; telemetry records only the count.
    if (!dangerous && isFindRequest(prompt) && !enabled("files")) return disabled("files");
    if (!dangerous && isFindRequest(prompt)) {
      taskType = "other";
      reasonCode = "local_find_files";
      this.tel.decision({ taskId, provider: "rules", candidates: ["LOCAL_AFM", "ASK_USER"], action: "LOCAL_AFM", reasonCode, afmAvailable: health.ok, riskSignals: ["private_paths"] });
      // P2: a topic ("the paper about X") is searched in titles and text as well as in names; ONBUD_FIND_TOPIC=off
      // keeps the name search only
      const frame = process.env.ONBUD_FIND_TOPIC === "off" ? { names: nameTerms(prompt), content: false } as FindFrame : findFrame(prompt);
      let terms = frame.names;
      if (!terms.length && health.ok) {
        const k = await afm.generate({ system: "Extract the file or folder name the user is looking for. Keep names exactly as written (any language); drop words like file, folder, find, where.",
          user: prompt, maxTokens: 80, timeoutMs: this.budget.afmTimeoutMs,
          schema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "1 to 3 name fragments to search for" } }, required: ["names"], additionalProperties: false } });
        steps.push({ kind: "find_terms", detail: k.ok ? "ok" : `failed:${k.failure}`, ms: k.latencyMs });
        if (k.ok) terms = ((k.json as any).names as string[]).map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 3);
      }
      if (!terms.length) {
        return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "find_needs_name",
          answer: ko ? "어떤 이름의 파일이나 폴더를 찾을까요? 이름 일부라도 알려 주세요." : "Which file or folder name should I look for? Part of the name is enough." });
      }
      const ts = Date.now();
      const found = frame.topic ? await findFiles({ ...frame, names: terms }, { project: root, kind: kindFromPrompt(prompt), max: 12 })
        : await findByName(terms, { project: root, kind: kindFromPrompt(prompt), max: 12 });
      this.tel.toolCall({ taskId, tool: "find_by_name", ok: true, durationMs: Date.now() - ts, resultChars: found.length });
      steps.push({ kind: "find", detail: `${found.length} results`, ms: Date.now() - ts });
      return finish({ status: "answered_local", outcomeClass: "local_verified", answer: renderFound(found, terms, ko), revealPaths: found.map((f) => f.path) });
    }

    // A LaTeX compile request in a folder with no LaTeX project: say so, instead of a generic answer that invented a
    // main file (skill eval writing-latex-no-main).
    if (root && !dangerous && /(latex|레이텍|\.tex\b)/i.test(prompt) && /(컴파일|빌드|compile|build|typeset)/i.test(prompt) && !isLatexProject(root)) {
      reasonCode = "latex_no_main";
      return finish({ status: "ask_user", outcomeClass: "asked_user", answer: ko
        ? "이 폴더에는 LaTeX 문서(main .tex)가 없어요. 논문 폴더를 열고 다시 요청해 주세요."
        : "There is no LaTeX document (main .tex) in this folder. Open the paper's folder and ask again." });
    }
    // 1c'. LaTeX papers (offline): compile + log summary, reference checks, CSV → table; errors get an AFM fix
    // proposal that is tried by compiling a sandbox clone (edit→test loop with latexmk as the test).
    if (!dangerous && root && isLatexProject(root) && !enabled("writing")) return disabled("writing");
    if (root && !dangerous && hasTeX() && isLatexProject(root)) {
      const texNamed = files.find((f) => /\.tex$/.test(f.path))?.path;
      const wantsCompile = /(컴파일|빌드|compile|build|pdf\s?(로|를)?\s?(만들|생성|뽑)|typeset)/i.test(prompt);
      const wantsRefs = /(인용|참조|레퍼런스|\bbib|citation|reference|\\ref|\\cite|label)/i.test(prompt) && /(확인|체크|점검|검사|빠진|누락|check|verify|missing)/i.test(prompt);
      const csv = files.find((f) => /\.(csv|tsv)$/.test(f.path));
      if (csv && /(표|table|tabular)/i.test(prompt)) {
        reasonCode = "local_latex_table";
        const table = csvToLatexTable(readFileSync(resolve(root, csv.path), "utf8").split("\n").slice(0, 60).join("\n"), "", `tab:${basename(csv.path).replace(/\.\w+$/, "").replace(/[^A-Za-z0-9]+/g, "-")}`);
        return finish({ status: "answered_local", outcomeClass: "local_verified", answer: (ko ? `\`${csv.path}\`로 만든 표예요 (booktabs, 숫자 열은 오른쪽 정렬):` : `Table from \`${csv.path}\` (booktabs, numeric columns right-aligned):`) + "\n\n```latex\n" + table + "\n```" });
      }
      if (wantsCompile || wantsRefs) {
        const main = findMainTex(root, texNamed);
        if (!main) return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "latex_no_main", answer: ko ? "\\documentclass와 \\begin{document}가 있는 메인 .tex 파일을 찾지 못했어요. 파일 이름을 알려 주세요." : "No main .tex (with \\documentclass and \\begin{document}) found. Which file is it?" });
        const refs = checkReferences(root);
        if (!wantsCompile) {
          reasonCode = "local_latex_refs";
          const r = [
            refs.missingCites.length ? `- ${ko ? ".bib에 없는 인용 키" : "Cite keys missing from .bib"}: ${refs.missingCites.map((k) => `\`${k}\``).join(", ")}` : "",
            refs.undefinedRefs.length ? `- ${ko ? "label 없는 \\ref" : "\\ref without \\label"}: ${refs.undefinedRefs.map((k) => `\`${k}\``).join(", ")}` : "",
            refs.duplicateLabels.length ? `- ${ko ? "중복 label" : "Duplicate labels"}: ${refs.duplicateLabels.map((k) => `\`${k}\``).join(", ")}` : "",
            refs.unusedBib.length ? `- ${ko ? "인용되지 않은 .bib 항목" : "Unused .bib entries"} (${refs.unusedBib.length}): ${refs.unusedBib.slice(0, 10).map((k) => `\`${k}\``).join(", ")}` : "",
          ].filter(Boolean);
          return finish({ status: "answered_local", outcomeClass: "local_verified", answer: r.length ? r.join("\n") : (ko ? "인용·참조 문제를 찾지 못했어요." : "No citation or reference problems found.") });
        }
        reasonCode = "local_latex_compile";
        const ts = Date.now();
        const rep = await compileLatex(root, main);
        this.tel.toolCall({ taskId, tool: "latex_compile", ok: rep.ok, durationMs: Date.now() - ts, resultChars: rep.errors.length });
        let answer = renderLatexReport(rep, root, main, ko, refs);
        const first = rep.errors.find((e) => e.file && e.line && /\.tex$/.test(e.file));
        if (!rep.ok && first && health.ok) {
          const errFile = existsSync(resolve(root, first.file!)) ? first.file! : (existsSync(resolve(root, dirname(main), first.file!)) ? join(dirname(main), first.file!) : undefined);
          if (errFile) {
            // One line, not retyped text: a deterministic macro fix, else AFM returns the corrected line.
            const content = readFileSync(resolve(root, errFile), "utf8");
            const lines = content.split("\n");
            const lineText = lines[first.line! - 1] ?? "";
            let fixed: string | undefined;
            let why = "";
            const macro = /Undefined control sequence/i.test(first.message) ? fixUndefinedMacro(root, lineText) : undefined;
            if (macro) { fixed = macro.fixed; why = ko ? `알 수 없는 명령 \`\\${macro.from}\`을 가장 가까운 명령 \`\\${macro.to}\`로 바꿨어요.` : `Replaced the unknown \`\\${macro.from}\` with the closest known \`\\${macro.to}\`.`; }
            else {
              const fx = await afm.generate({ system: "You fix one line of LaTeX so it compiles. Change only the markup that causes the error; keep every word of the author's text.",
                user: `ERROR: ${first.message}\nLINE ${first.line} of ${errFile}:\n${lineText}\n\nContext:\n${lines.slice(Math.max(0, first.line! - 4), first.line! + 2).join("\n")}`, maxTokens: 400, timeoutMs: this.budget.afmTimeoutMs,
                schema: { type: "object", properties: { corrected_line: { type: "string", description: "The whole corrected line" }, explanation: { type: "string", description: "One short sentence in the user's language" } }, required: ["corrected_line", "explanation"], additionalProperties: false } });
              if (fx.ok && String((fx.json as any).corrected_line ?? "").trim() && (fx.json as any).corrected_line !== lineText) { fixed = String((fx.json as any).corrected_line); why = String((fx.json as any).explanation ?? ""); }
            }
            steps.push({ kind: "latex_fix", detail: fixed ? (macro ? "macro" : "afm_line") : "none" });
            if (fixed !== undefined && fixed !== lineText) {
              const newContent = [...lines.slice(0, first.line! - 1), fixed, ...lines.slice(first.line!)].join("\n");
              const edit: EditProposal = { path: errFile, oldText: lineText, newText: fixed, explanation: why, baseHash: sha(content) };
              const diff = await diffOf(errFile, content, newContent);
              const testCmd = trialCompileCommand(root, main);
              answer += (ko ? `\n\n수정안: ${why}\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n샌드박스 사본에 적용해서 다시 컴파일해 볼까요? 성공하면 실제 파일에 적용할지 한 번 더 물어봐요. (\`예\` / \`아니요\`)`
                : `\n\nProposed fix: ${why}\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nTry it in a sandbox copy and recompile? (\`yes\` / \`no\`)`);
              return finish({ status: "answered_local", outcomeClass: "local_unverified", isProposal: true, answer, pendingEdit: { edit, testCmd } });
            }
            answer += ko ? `\n\n자동 수정안을 만들지 못했어요. \`${errFile}\` ${first.line}번째 줄을 확인해 주세요.` : `\n\nNo automatic fix; check \`${errFile}\` line ${first.line}.`;
          }
        }
        return finish({ status: "answered_local", outcomeClass: rep.ok ? "local_verified" : "local_unverified", answer });
      }
    }

    // 1d. Background sessions of this project (tmux): list / read / stop without a model.
    const mentionsSession = /(세션|sessions?\b|백그라운드|background)/i.test(prompt);
    if (root && (mentionsSession || /(서버|server|프로세스|process)/i.test(prompt))) {
      const mine = await listSessions(proj);
      const stop = /(stop|kill|terminate|shut ?down|종료|꺼|끄|중지|멈춰|정지)/i.test(prompt);
      const show = /(log|output|출력|로그)/i.test(prompt) && !/(무슨|what|which|왜|why|에러|error|오류)/i.test(prompt);
      const list = /(list|목록|뭐가|무엇|어떤|status|상태|있어|있나|보여)/i.test(prompt);
      if (mentionsSession || (mine.length && (stop || show))) {
        const done = (answer: string, code: string) => { reasonCode = code; return finish({ status: "answered_local", outcomeClass: "local_verified", answer }); };
        if (!mine.length && (stop || list || show)) return done(ko ? "이 폴더에서 실행 중인 백그라운드 세션이 없어요." : "No background sessions for this folder.", "local_session_none");
        const named = mine.filter((m) => prompt.toLowerCase().includes(m.label));
        const targets = named.length ? named : mine;
        if (stop) {
          for (const t of targets) await stopSession(t.name);
          return done((ko ? "세션을 종료했어요: " : "Stopped: ") + targets.map((t) => `\`${t.label}\``).join(", "), "local_session_stop");
        }
        if (show) {
          const parts = [];
          for (const t of targets.slice(0, 2)) parts.push(`**${t.label}** (${t.dead ? (ko ? "종료됨" : "exited") : (ko ? "실행 중" : "running")})\n\`\`\`\n${(await readSession(t.name, 40)) || "(no output)"}\n\`\`\``);
          return done(parts.join("\n\n"), "local_session_output");
        }
        if (list) return done(renderSessions(mine, ko) + (ko ? "\n\n직접 보기: `tmux -L onbud attach -t <이름>`" : "\n\nWatch live: `tmux -L onbud attach -t <name>`"), "local_session_list");
      }
    }

    // 1e. Explicit "run `command`": no model needed to choose it. Read-only runs now; anything else asks.
    // A bare command typed into the chat ("opencode auth list") counts too: triage once read that as an error log.
    const bare = !spans.length ? typedCommand(prompt) : undefined;
    const runSpan = spans.length === 1 && /(실행|돌려|띄워|켜\s?줘|시작|run|start|launch|execute)/i.test(prompt) ? spans[0].trim() : bare;
    if (runSpan && /^[A-Za-z0-9_./~-]+(\s|$)/.test(runSpan) && (!dangerous || dangerous === spans[0])) {
      // Without a project folder a typed command runs in the home folder (system commands such as `opencode auth list`).
      const cmdRoot = root ?? (bare ? homedir() : undefined);
      if (!cmdRoot) return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "needs_project_folder",
        answer: ko ? "명령을 실행하려면 먼저 프로젝트 폴더를 열어 주세요." : "Open a project folder first to run commands." });
      const cls = classifyCommand(runSpan, cmdRoot);
      reasonCode = cls.mode === "blocked" ? "destructive_command" : `explicit_command_${cls.mode}`;
      if (cls.mode === "blocked") {
        const hint = cls.reasons.includes("network_listener")
          ? (ko ? "\n\n외부(같은 네트워크)에 포트를 여는 서버라서 막았어요. 이 Mac에서만 쓰려면 `--bind 127.0.0.1`을 붙여서 요청해 주세요 (예: `python3 -m http.server --bind 127.0.0.1 8765`)."
                : "\n\nIt would open a port to your network. For this Mac only, add `--bind 127.0.0.1` (e.g. `python3 -m http.server --bind 127.0.0.1 8765`).") : "";
        return finish({ status: "ask_user", outcomeClass: "asked_user", answer: (ko ? "보안 게이트가 이 명령을 막았어요" : "The security gate blocks this command") + ` (${cls.reasons.join(", ")}).` + hint });
      }
      if (cls.mode === "auto") {
        const r = await execCommand(runSpan, cmdRoot);
        this.tel.toolCall({ taskId, tool: "run_command", ok: r.exitCode === 0, durationMs: r.ms, resultChars: r.output.length });
        return finish({ status: "answered_local", outcomeClass: "local_verified", answer: "```\n" + renderResult(runSpan, r) + "\n```" });
      }
      const bg = isLongRunning(runSpan);
      return finish({ status: "ask_user", outcomeClass: "asked_user", pendingCommand: runSpan, background: bg,
        answer: (ko ? `실행할 명령:\n\n\`\`\`sh\n${runSpan}\n\`\`\`` : `Command:\n\n\`\`\`sh\n${runSpan}\n\`\`\``)
          + (bg ? (ko ? "\n\n계속 실행되는 명령이라 백그라운드 tmux 세션에서 실행해요. 출력은 \"로그 보여줘\", 종료는 \"세션 종료해줘\"." : "\n\nIt keeps running, so it starts in a background tmux session. Ask for \"the log\" or to \"stop the session\" later.") : "")
          + (ko ? "\n\n실행할까요? (`예` / `아니요`)" : "\n\nRun it? (`yes` / `no`)") });
    }

    // 1f. Local jobs: list / apply / review / discard (deterministic), or plan a new one.
    if (root && /(로컬 작업|local jobs?|afm 작업|작업 목록|\bjobs?\b)/i.test(prompt)) {
      const jobs = listJobs(root);
      const allIds = [...prompt.matchAll(/\b(\d{8}-[0-9a-f]{6})\b/g)].map((m) => m[1]);
      if (/(비교|compare|versus|\bvs\b)/i.test(prompt)) {
        const ids = allIds.length >= 2 ? allIds : jobs.filter((j) => j.workspace.dir && j.status !== "discarded").slice(0, 2).map((j) => j.id);
        if (ids.length < 2) return finish({ status: "answered_local", outcomeClass: "local_verified", reasonCode: "local_jobs_compare", answer: ko ? "비교할 작업 브랜치가 두 개 이상 필요해요. \"로컬 작업 목록\"에서 id를 확인해 주세요." : "Need at least two job branches to compare (see \"local jobs\")." });
        reasonCode = "local_jobs_compare";
        return finish({ status: "ask_user", outcomeClass: "asked_user", pendingJob: { id: ids[0], action: "compare", ids },
          answer: (ko ? `작업 ${ids.map((i) => `\`${i}\``).join(", ")}을 비교할게요: 각 브랜치에서 확인 명령(테스트/컴파일)을 실행하고, 변경 규모와 Decima의 판단을 보여 드려요. 실행할까요? (\`예\` / \`아니요\`)`
            : `Compare jobs ${ids.join(", ")}: run the checks in each branch, show the change size and Decima's pick. Run? (\`yes\` / \`no\`)`) });
      }
      const id = jobIdFrom(prompt) ?? (/(마지막|최근|last|latest)/i.test(prompt) ? jobs[0]?.id : jobs.length === 1 ? jobs[0].id : undefined);
      const job = id ? loadJob(id) : undefined;
      const act = /(반영|적용|apply|merge)/i.test(prompt) ? "apply" : /(검토|리뷰|review)/i.test(prompt) ? "review" : /(폐기|삭제|버려|discard|remove)/i.test(prompt) ? "discard" : /(이어서|계속|재개|resume|continue)/i.test(prompt) ? "run" : "list";
      if (act === "list" || !job) {
        reasonCode = "local_jobs_list";
        const txt = jobs.length ? jobs.slice(0, 8).map((j) => `- \`${j.id}\` **${j.status}**${j.owner === "frontier" ? " (Codex)" : " (AFM)"} — ${j.request.slice(0, 70)}\n  ${j.workspace.branch}${j.workspace.dir ? ` · \`${j.workspace.dir}\`` : ""}`).join("\n")
          + (ko ? "\n\n\"작업 <id> 반영\", \"작업 <id> 검토\"(Codex), \"작업 <id> 이어서\", \"작업 <id> 폐기\"로 다룰 수 있어요." : "\n\nUse \"job <id> apply | review | continue | discard\".")
          : (ko ? "이 폴더의 로컬 작업이 없어요." : "No local jobs for this folder.");
        return finish({ status: "answered_local", outcomeClass: "local_verified", answer: txt });
      }
      reasonCode = `local_job_${act}`;
      const head = `**${job.id}** (${job.status}) — ${job.request.slice(0, 80)}\n\n${renderJob(job, ko)}\n\n${ko ? "기록" : "Journal"}: \`${journalPath(job.id)}\``;
      const ask = act === "apply" ? (ko ? "\n\n이 변경을 실제 프로젝트에 반영할까요? (`예` / `아니요`)" : "\n\nApply these changes to the project? (`yes` / `no`)")
        : act === "discard" ? (ko ? "\n\n작업 브랜치와 작업 폴더를 지울까요? 기록(JOURNAL)은 남아요. (`예` / `아니요`)" : "\n\nDelete the job's branch and folder? The journal stays. (`yes` / `no`)")
        : act === "run" ? (ko ? "\n\n남은 단계를 이어서 진행할까요? (`예` / `아니요`)" : "\n\nContinue the remaining steps? (`yes` / `no`)")
        : (ko ? "\n\nCodex에게 이 브랜치 검토·수정을 맡길까요? (`예` / `아니요`)" : "\n\nAsk Codex to review and fix this branch? (`yes` / `no`)");
      return finish({ status: "ask_user", outcomeClass: "asked_user", answer: head + ask, pendingJob: { id: job.id, action: act as any } });
    }
    // v3 routing (2026-10-31): a plain rename is mechanical (renameSymbol, then the project's tests), so it is a
    // local job even when Codex is reachable (S1 used to send it to Codex as a multi-file change).
    if (root && !dangerous && health.ok && renameRequest(prompt) && hasWorkTarget(root, prompt)) {
      reasonCode = "local_rename";
      return task.readOnly ? noJob() : this.planLocalJob(prompt, root, finish, steps, ko);
    }
    if (!dangerous && root && isJobRequest(prompt) && hasWorkTarget(root, prompt) && !enabled("code")) return disabled("code");
    if (root && !dangerous && health.ok && isJobRequest(prompt) && hasWorkTarget(root, prompt) && !(files.length === 1 && /(고쳐|수정|fix)/i.test(prompt) && !/(새|create|new|섹션|section)/i.test(prompt))) {
      // When a frontier model is reachable, the code skill's triage (firstWriter) decides whether Copilot writes
      // first (local job, checked by the tests and the gate) or Codex does (own branch). "로컬" still runs the local job.
      const T = this.policy.decision.decima.codeHardThreshold;
      let codeRoute: Job["codeRoute"];
      if (!/(로컬|오프라인|afm)(로|으로|만으로)/i.test(prompt) && !/\.(tex|bib)\b|섹션|section|논문/i.test(prompt) && (await frontierReachable())) {
        const d = this.decimaClient ? await codeDifficulty(this.decimaClient, prompt) : undefined;
        codeRoute = { d, threshold: T, algorithmic: algorithmic({ prompt }), newCode: newCodeRequest(prompt), tests: !!detectTestCommand(root) };
        steps.push({ kind: "decima_code", detail: d === undefined ? "n/a" : d.toFixed(2) });
        // who writes first: the code skill's triage (code-skill.ts firstWriter; copilot_mode in routing.yaml)
        // contest-style requests: the difficulty classifier decides whether Copilot is worth trying first
        const easy = codeRoute.algorithmic ? easyContest(prompt) : undefined;
        const fw = await firstWriter({ d, algorithmic: codeRoute.algorithmic, newCode: codeRoute.newCode, checkable: codeRoute.tests, easy, copilot: async () => !!(await copilotFiller(root)), mode: this.policy.decision.copilotMode, hardAt: T });
        if (fw.copilotTier) logEvent({ taskId, event: "copilot_tier", was: fw.reason, mode: this.policy.decision.copilotMode });
        const why = fw.writer === "frontier" ? fw.reason : undefined;
        logEvent({ taskId, event: "code_route", ...codeRoute, ...(this.decimaClient?.served ? { decimaDigest: this.decimaClient.served.slice(0, 12) } : {}), route: why ? "FRONTIER_GPT" : "LOCAL_JOB", reasonCode: why ?? "local_job" });
        if (why) {
          reasonCode = why;
          route = "FRONTIER_GPT";
          return this.escalate(taskId, { goal: prompt, constraints: [], evidence: [] }, prompt, root, task, steps, finish, reasonCode, "multi_file_change");
        }
      }
      return task.readOnly ? noJob() : this.planLocalJob(prompt, root, finish, steps, ko, undefined, codeRoute);
    }

    // 1z. Skill router (P3): no rule took the request; the skills' example requests are offered to AFM, which picks
    // one or none (any language). The pick must meet the skill's own conditions and the same folder/read-only
    // rules as a rule match. ONBUD_ROUTER=shadow logs the pick only, off skips it.
    // Only for requests that name no file (a named file goes to the document path, which answers questions about
    // it; framework-eval C4/X7: the router turned "how many lines does data.csv have" into a CSV→JSON write).
    // Skills that write files are never started by the router, only by their rules.
    if (!dangerous && health.ok && routerMode() !== "off" && !files.length) {
      const pick = await pickSkill(afm, prompt, entriesOf(), this.budget.afmTimeoutMs);
      const id = pick.id as LocalSkill | undefined;
      const usable = !!id && !WRITES_FILES.has(id) && routedSkillApplies(id, prompt, files) && (!!root || NO_ROOT.has(id)) && !(task.readOnly && NOT_DELEGATED.has(id)) && enabled(skillOf(id));
      steps.push({ kind: "router", detail: `${pick.id ?? "none"}${pick.id && !usable ? " (does not apply)" : ""}${routerMode() === "shadow" ? " (shadow)" : ""}`, ms: pick.ms });
      logEvent({ taskId, event: "router", pick: pick.id ?? "none", usable, mode: routerMode() });
      if (usable && routerMode() === "fallback") { const out = await runSkill(id!, true); if (out) return out; }
    }

    // 2. AFM triage (schema-constrained; free-text sentinels proved unreliable)
    let selfEscalate = false;
    if (health.ok) {
      const t = await afm.generate({ system: this.policy.afmSystem, user: `Triage this request: ${prompt}`, schema: TRIAGE_SCHEMA, maxTokens: 150, timeoutMs: this.budget.afmTimeoutMs });
      steps.push({ kind: "triage", detail: t.ok ? JSON.stringify(t.json) : `failed:${t.failure}`, ms: t.latencyMs });
      if (t.ok) {
        const j = t.json as { task_type: TaskType; escalate: boolean };
        taskType = j.task_type;
        selfEscalate = j.escalate;
      }
    } else {
      steps.push({ kind: "health", detail: "afm_unavailable" });
    }
    // Triage sometimes calls a plain question an edit ("How many Python files…" → small_edit); without an
    // edit verb it is not one, so it must not be answered as a proposal or routed to the edit loop.
    if ((taskType === "small_edit" || taskType === "multi_file_change") && !/(수정|고쳐|고치|바꿔|변경|추가|삭제|리팩터|리팩토|구현|작성|다듬|교정|이름.*바꿔|fix|edit|change|modify|update|add|remove|delete|rename|refactor|implement|rewrite|write|create|polish)/i.test(prompt)) taskType = "other";
    // Documents named in the request are read locally even if triage guessed "small_edit" etc.
    if (files.some((f) => ["pdf", "word", "slides", "sheet"].includes(kindOf(f.path))) && taskType !== "multi_file_change" && taskType !== "design") taskType = "document_question";

    // 3. Route (rules; safety overrides anything learned)
    const candidates: Action[] = ["LOCAL_AFM", "FRONTIER_GPT", "FRONTIER_CLAUDE", "RUN_VERIFICATION", "ASK_USER"];
    const d = await this.decision.decide({
      taskId, prompt,
      taskType,
      estimatedInputTokens: estimateTokens(prompt),
      filesTouched: taskType === "small_edit" || taskType === "multi_file_change" ? files.length : 0,
      command: dangerous,
      localAfmAvailable: health.ok,
    }, candidates);
    route = d.action;
    reasonCode = d.reasonCode;
    // Triage escalation is a guess made before reading anything; when the request names files that
    // exist, read them first and let the answer step decide (needs_escalation) instead.
    if (route === "LOCAL_AFM" && selfEscalate && root && files.length === 0) { route = "FRONTIER_GPT"; reasonCode = "afm_triage_escalate"; }
    if (route === "FRONTIER_CLAUDE") route = "FRONTIER_GPT";   // only the ChatGPT/Codex provider is configured
    steps.push({ kind: "route", detail: `${route}:${reasonCode}` });
    const sys = systemFor(this.policy, taskType);
    skill = sys.skill;
    this.tel.decision({ taskId, provider: d.provider, candidates, action: route, reasonCode, afmAvailable: health.ok, rawScores: d.rawScores,
      riskSignals: [dangerous ? "destructive_command" : "", secrets.length ? "secrets_redacted" : ""].filter(Boolean) });
    logEvent({ taskId, event: "decision", taskType, route, reasonCode, provider: d.provider, afm: health.ok, skill, ...(this.decimaClient?.served ? { decimaDigest: this.decimaClient.served.slice(0, 12) } : {}), ...pv });

    const capsule: Capsule = {
      goal: prompt,
      constraints: root
        ? ["Answer only from EVIDENCE; cite only paths that appear in EVIDENCE", "Propose edits as minimal diffs; nothing is applied automatically"]
        : ["No project folder is open, so no files are available. Answer from general knowledge and the conversation; if the question needs files, say which folder to open."],
      evidence: task.history ? [{ label: "conversation so far", body: redact(task.history).text.slice(-3000) }] : [],
    };

    if (route === "ASK_USER" && reasonCode.startsWith("decima") && health.ok) {
      // Decima thinks the request is ambiguous: AFM writes the one clarifying question.
      const q = await afm.generate({ system: "The request is ambiguous. Ask the single most useful clarifying question, in the user's language.", user: prompt, maxTokens: 120, timeoutMs: this.budget.afmTimeoutMs,
        schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false } });
      if (q.ok) return finish({ status: "ask_user", outcomeClass: "asked_user", answer: String((q.json as any).question) });
    }
    if (route === "ASK_USER") return finish({ status: "ask_user", outcomeClass: "asked_user", answer: `Needs your decision (${reasonCode}).` });
    if (route === "RUN_VERIFICATION") {
      // Run the project's checks through the normal approval flow (Decima or the rules chose verification).
      const cmd = root ? detectTestCommand(root) ?? (hasTeX() && isLatexProject(root) && findMainTex(root) ? trialCompileCommand(root, findMainTex(root)!) : undefined) : undefined;
      if (cmd) return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode, pendingCommand: cmd,
        answer: (ko ? `테스트를 실행할게요:\n\n\`\`\`sh\n${cmd}\n\`\`\`\n\n실행할까요? (\`예\` / \`아니요\`)` : `I'll run the checks:\n\n\`\`\`sh\n${cmd}\n\`\`\`\n\nRun it? (\`yes\` / \`no\`)`) });
      route = "LOCAL_AFM";   // no recognisable test command: let AFM look (it can propose one)
    }
    if (route !== "LOCAL_AFM") {
      // No frontier reachable (offline, or switched off): code/writing work becomes a local job instead.
      if (root && health.ok && /multi_file_change|small_edit|design|decima_frontier/.test(`${taskType} ${reasonCode}`) && /(수정|고쳐|바꿔|추가|구현|작성|만들|리팩터|써|fix|add|implement|create|write|refactor|change|update)/i.test(prompt) && !(await frontierReachable())) {
        steps.push({ kind: "offline", detail: "frontier unreachable → local job" });
        return task.readOnly ? noJob() : this.planLocalJob(prompt, root, finish, steps, ko, true);
      }
      return this.escalate(taskId, capsule, prompt, root, task, steps, finish, reasonCode, taskType);
    }

    const missing = root ? missingTarget(prompt, files) : undefined;
    if (missing) return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "missing_target", answer: missing });

    // 5b. Small single-file edit: AFM writes an exact search/replace edit; the user can try it in a
    // sandbox copy with the tests before anything touches the real file.
    // 5a. LaTeX prose polishing on given lines: markup is masked, AFM rewrites only the words, the
    // controller checks every placeholder came back, and the result is compiled in a sandbox before applying.
    const texTarget = files.find((f) => /\.tex$/.test(f.path))?.path;
    const lineSel = /(\d+)\s*(?:-|~|–)\s*(\d+)\s*(?:번째\s*)?(?:줄|행|lines?)|(\d+)\s*번째\s*(?:줄|행)|lines?\s*(\d+)(?:\s*-\s*(\d+))?/i.exec(prompt);
    if (root && texTarget && lineSel && /(다듬|교정|고쳐\s?써|학술적|자연스럽|간결|매끄럽|문법|polish|rewrite|paraphrase|proofread|grammar|concise|academic)/i.test(prompt) && health.ok) {
      const from = Number(lineSel[1] ?? lineSel[3] ?? lineSel[4]);
      const to = Number(lineSel[2] ?? lineSel[5] ?? from);
      const content = readFileSync(resolve(root, texTarget), "utf8");
      const lines = content.split("\n");
      if (from >= 1 && to >= from && to <= lines.length && to - from < 25) {
        reasonCode = "local_latex_polish";
        const original = lines.slice(from - 1, to).join("\n");
        const { masked, parts } = maskLatex(original);
        const rw = await afm.generate({ system: "You are an academic copy editor. Rewrite the text as the user asks: improve word choice, precision and sentence structure — a real rewrite, not a copy. Tokens like ⟦3⟧ stand for LaTeX markup (commands, citations, math): keep every token exactly once, attached to the same words. Do not add facts.\nExample: \"We use ⟦1⟧big⟦2⟧ models to check things ⟦3⟧.\" → \"We employ ⟦1⟧large-scale⟦2⟧ models to verify these properties ⟦3⟧.\"",
          user: `REQUEST: ${prompt}\n\nTEXT:\n${masked}`, maxTokens: 900, timeoutMs: Math.max(this.budget.afmTimeoutMs, 45_000),
          schema: { type: "object", properties: { rewritten: { type: "string", description: "The rewritten text with every ⟦n⟧ token kept" }, explanation: { type: "string", description: "One short sentence on what changed, in the user's language" } }, required: ["rewritten", "explanation"], additionalProperties: false } });
        const restored = rw.ok ? unmaskLatex(String((rw.json as any).rewritten ?? ""), parts) : undefined;
        steps.push({ kind: "latex_polish", detail: rw.ok ? (restored ? "ok" : "placeholders_lost") : `failed:${rw.failure}` });
        if (restored && restored.replace(/\s+/g, " ").trim() === original.replace(/\s+/g, " ").trim()) steps.push({ kind: "latex_polish", detail: "whitespace_only" });
        if (restored && restored.replace(/\s+/g, "") !== original.replace(/\s+/g, "")) {
          const newContent = [...lines.slice(0, from - 1), ...restored.split("\n"), ...lines.slice(to)].join("\n");
          const edit: EditProposal = { path: texTarget, oldText: original, newText: restored, explanation: String((rw.json as any).explanation ?? ""), baseHash: sha(content) };
          const diff = await diffOf(texTarget, content, newContent);
          const main = findMainTex(root);
          const testCmd = main ? trialCompileCommand(root, main) : undefined;
          return finish({ status: "answered_local", outcomeClass: "local_unverified", isProposal: true, pendingEdit: { edit, testCmd },
            answer: `${edit.explanation}\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n` + (ko ? "LaTeX 명령·인용·수식은 그대로 두고 문장만 바꿨어요. 샌드박스에서 컴파일해 보고 적용할까요? (`예` / `아니요`)" : "Markup, citations and math are unchanged; only the prose was rewritten. Compile in a sandbox, then apply? (`yes` / `no`)") });
        }
      }
    }

    if (root && taskType === "small_edit") {
      const target = await this.editTarget(root, prompt, files);
      if (target) {
        const sysEdit = systemFor(this.policy, "small_edit").text;
        let p = await proposeEdit(afm, { root, path: target, request: prompt, system: sysEdit, timeoutMs: Math.max(this.budget.afmTimeoutMs, 45_000) });
        steps.push({ kind: "edit", detail: p.ok ? `proposed ${target}` : `failed:${p.error}` });
        if (!p.ok && /old_text_not_(found|unique)|latex_keys_changed/.test(p.error)) {   // one corrective retry
          p = await proposeEdit(afm, { root, path: target, request: prompt, system: sysEdit, timeoutMs: Math.max(this.budget.afmTimeoutMs, 45_000),
            feedback: p.error === "old_text_not_unique" ? "old_text matched several places; include more surrounding lines so it is unique"
              : p.error.startsWith("latex_keys_changed") ? `Your edit removed or changed LaTeX commands (${p.error.split(":")[1]}). Keep every \\cite{...}, \\ref{...} and \\label{...} exactly as written; change only the prose.`
              : "old_text was not found; copy the lines exactly as they appear in FILE" });
          steps.push({ kind: "edit_retry", detail: p.ok ? "ok" : `failed:${p.error}` });
        }
        if (p.ok) {
          const testCmd = detectTestCommand(root, target);
          const ask = ko
            ? `\n\n샌드박스 사본(APFS 복제)에 적용해서 ${testCmd ? `\`${testCmd}\` 테스트` : "문법 검사"}를 해 볼까요? 실제 파일은 결과를 보고 한 번 더 확인한 뒤에만 바꿔요. (\`예\` / \`아니요\`)`
            : `\n\nTry it in a sandbox copy (APFS clone) and run ${testCmd ? `\`${testCmd}\`` : "a syntax check"}? The real file changes only after you confirm again. (\`yes\` / \`no\`)`;
          return finish({ status: "answered_local", outcomeClass: "local_unverified", isProposal: true, reasonCode: "local_small_edit",
            answer: `${p.edit.explanation}\n\n\`\`\`diff\n${p.diff}\n\`\`\`${ask}`, pendingEdit: { edit: p.edit, testCmd } });
        }
        if (p.error.startsWith("file_too_large") || p.error.startsWith("blocked")) return this.escalate(taskId, capsule, prompt, root, task, steps, finish, `edit_${p.error}`, taskType);
      }
    }
    const doc: { frame?: Frame; title?: string; lines?: string } = {};
    if (!root) steps.push({ kind: "seed", detail: "no project folder: chat only" });
    else {
      // Document questions: what kind of answer is asked for and which words to look for (question-frame.ts).
      // The frame is used for searching and checking only, not put into the answer prompt: AFM can misframe the
      // question, and a wrong "asks for a title" instruction then outweighs the evidence.
      if (taskType === "document_question" && health.ok && files.some((f) => ["pdf", "word", "slides", "sheet", "text"].includes(kindOf(f.path)))) {
        const ts = Date.now();
        doc.frame = await frameQuestion(afm, prompt, this.budget.afmTimeoutMs);
        // Korean question: AFM can drop the key word while framing ("어느 학회 논문" → "what is the title"), and the
        // document is often English. The on-device translator's words can be added to the search words.
        // Off by default since the macOS 27.2 model update: on 15 document tasks × 2 it changed no answer and cost
        // ~1 s (benchmark-notes §5i). ONBUD_KO_QUESTION=on turns it back on.
        if (doc.frame && ko && process.env.ONBUD_KO_QUESTION === "on") {
          const en = await toEnglish(prompt);
          const add = en ? translationWords(en, files.map((f) => basename(f.path))) : [];
          doc.frame.search_words = [...new Set([...doc.frame.search_words, ...add])].slice(0, 10);
          steps.push({ kind: "translate_question", detail: en ? `${en} → +${add.join(", ") || "none"}` : "unavailable" });
        }
        steps.push({ kind: "frame", detail: doc.frame ? `${doc.frame.asked_for}: ${doc.frame.search_words.join(", ")} | ${doc.frame.restated}` : "failed", ms: Date.now() - ts });
      }
      const failed = await this.gather(taskId, afm, root, proj, prompt, files, taskType, capsule, steps, doc);
      if (failed?.startsWith("ask_user:")) {
        return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "afm_needs_detail", answer: failed.slice(9) });
      }
      if (failed?.startsWith("approve:")) {
        const cmd = failed.slice(8);
        const bg = isLongRunning(cmd);
        const where = bg ? (ko ? "\n\n계속 실행되는 명령이라 백그라운드 tmux 세션에서 실행하고, 출력은 나중에 \"로그 보여줘\"로 볼 수 있어요." : "\n\nThis keeps running, so it will start in a background tmux session; ask for its output any time.") : "";
        return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "command_needs_approval", pendingCommand: cmd, background: bg,
          capsule: renderCapsule(capsule, 3000).text,
          answer: (ko ? `다음 명령을 실행해야 답할 수 있어요:\n\n\`\`\`sh\n${cmd}\n\`\`\`` : `I need to run this command to answer:\n\n\`\`\`sh\n${cmd}\n\`\`\``) + where + (ko ? "\n\n실행할까요? (`예` / `아니요`)" : "\n\nRun it? (`yes` / `no`)") });
      }
      if (failed) return this.escalate(taskId, capsule, prompt, root, task, steps, finish, failed, taskType);
    }

    // 6. Final answer, schema-constrained so escalation is a field, not a sentinel
    let rendered = renderCapsule(capsule, this.budget.capsuleTokens);
    const schemaA = answerSchema(root ? evidencePaths(capsule.evidence) : []);
    let ans = await afm.generate({ system: sys.text, user: rendered.text, schema: schemaA, maxTokens: 900, timeoutMs: this.budget.afmTimeoutMs });
    steps.push({ kind: "answer", detail: ans.ok ? "ok" : `failed:${ans.failure}`, ms: ans.latencyMs });
    if (!ans.ok) return this.escalate(taskId, capsule, prompt, root, task, steps, finish, `afm_answer_${ans.failure}`, taskType);
    let a = ans.json as { answer: string; needs_escalation: boolean; assumptions: string[] };

    // 7. Citation check; one corrective retry, then flag
    let bad: string[] = [];
    if (root) {
      const evidenceText = capsule.evidence.map((e) => e.label + "\n" + e.body).join("\n");
      bad = unverifiedPaths(a.answer, root, evidenceText);
      if (bad.length) {
        steps.push({ kind: "verify", detail: `unverified paths: ${bad.join(", ")}` });
        capsule.openQuestions = [`Your previous answer cited files that do not exist: ${bad.join(", ")}. Use only files listed in EVIDENCE.`];
        rendered = renderCapsule(capsule, this.budget.capsuleTokens);
        const retry = await afm.generate({ system: sys.text, user: rendered.text, schema: schemaA, maxTokens: 900, timeoutMs: this.budget.afmTimeoutMs });
        steps.push({ kind: "answer_retry", detail: retry.ok ? "ok" : `failed:${retry.failure}`, ms: retry.latencyMs });
        if (retry.ok) { ans = retry; a = retry.json as typeof a; bad = unverifiedPaths(a.answer, root, evidenceText); }
      }
      this.tel.verification({ taskId, kind: "cited_paths_exist", passed: bad.length === 0, detail: bad.join(",") || undefined });
      const g = quotesGrounded((a as any).quotes, evidenceText);
      this.tel.verification({ taskId, kind: "quotes_in_evidence", passed: g >= 0.5, detail: g.toFixed(2) });
      steps.push({ kind: "grounding", detail: `quotes in evidence ${Math.round(g * 100)}%` });
    }

    // 7b. Answer checks (question-frame.ts). (1) Wrong kind of answer (no number for an amount, the title for a
    // venue): one retry with the reason. (2) The answer ignores the document line that holds a specific word of
    // the question: a focused question with only that line, since with the whole capsule AFM kept its first
    // reading (P3: the full retry repeated the title 4/4, the focused question answered from the line 4/4).
    if (doc.frame) {
      const why = typeMismatch(doc.frame.asked_for, a.answer, doc.title);
      if (why) {
        steps.push({ kind: "verify", detail: `answer type: ${why}` });
        capsule.openQuestions = [`Your previous answer did not fit: ${why}. Answer the question that was asked, using the lines that contain the search words.`];
        rendered = renderCapsule(capsule, this.budget.capsuleTokens);
        const retry = await afm.generate({ system: sys.text, user: rendered.text, schema: schemaA, maxTokens: 900, timeoutMs: this.budget.afmTimeoutMs });
        const fits = retry.ok && !typeMismatch(doc.frame.asked_for, String((retry.json as any).answer ?? ""), doc.title);
        steps.push({ kind: "answer_retry", detail: !retry.ok ? `failed:${retry.failure}` : fits ? "fits" : "still_mismatch", ms: retry.latencyMs });
        if (fits) { ans = retry; a = retry.json as typeof a; }
      }
      const ign = doc.lines ? ignoredLine(doc.frame.search_words, doc.lines, a.answer) : undefined;
      if (ign) {
        const f = await afm.generate({ system: "Does the LINE from the document answer the QUESTION? If it does, give the answer taken from the line, in the question's language.", user: `QUESTION: ${prompt}\nLINE: ${ign.line}`,
          maxTokens: 200, timeoutMs: this.budget.afmTimeoutMs, schema: { type: "object", properties: { answers_question: { type: "boolean" }, answer: { type: "string" } }, required: ["answers_question", "answer"], additionalProperties: false } });
        const fj = f.json as { answers_question: boolean; answer: string } | undefined;
        const fa = String(fj?.answer ?? "").trim();
        const used = f.ok && !!fj?.answers_question && !!fa && !ignoredLine([ign.word], ign.line, fa);
        steps.push({ kind: "answer_focused", detail: `"${ign.word}": ${!f.ok ? `failed:${f.failure}` : used ? "line answers" : "line does not answer"}`, ms: f.latencyMs });
        if (used) a = { ...a, answer: `${fa}\n\n> ${ign.line}`, assumptions: [] };
      }
      this.tel.verification({ taskId, kind: "answer_type", passed: !why && !ign, detail: why ?? (ign ? `ignored line: ${ign.word}` : doc.frame.asked_for) });
    }

    // Language check (AFM drifts to the evidence's language, e.g. English papers): translate if needed.
    // Kept after the 27.2 check: Korean answers 2/28 → 8/28, no effect on correctness, ~1 s. ONBUD_KO_ANSWER=off for A/B.
    // (Asking for Korean in the answer prompt instead made P3 wrong again, 0/2, and gave 4/28 Korean answers.)
    // With the reply-language contract on, its masked translation (paths, code and names kept) runs after every
    // route instead; this older one translated paths ("policies/routing.yaml" → "정책/라우팅.yaml").
    if (ko && !hasHangul(a.answer) && process.env.ONBUD_KO_ANSWER !== "off" && contractMode() !== "on") {
      const tr = await afm.generate({
        system: "Translate the text into natural Korean. Keep file names, code, numbers, names and technical terms exactly as written.",
        user: a.answer,
        schema: { type: "object", properties: { korean: { type: "string", description: "The Korean translation" } }, required: ["korean"], additionalProperties: false },
        maxTokens: 900, timeoutMs: this.budget.afmTimeoutMs,
      });
      steps.push({ kind: "translate", detail: tr.ok ? "ok" : `failed:${tr.failure}`, ms: tr.latencyMs });
      // AFM transliterates names despite the instruction ("Jordan Lee-Moreno" → "조던 리-모레노"); a
      // translation that loses a Latin-script name is worse than an English answer, so keep the original.
      const ko2 = tr.ok ? String((tr.json as any).korean ?? "") : "";
      const names = [...new Set(a.answer.match(/\b[A-Z][A-Za-z'’-]{2,}\b/g) ?? [])].filter((n) => !/^(The|This|That|These|It|In|On|At|For|And|But|If|When|File|Answer|Yes|No)$/.test(n));
      const lost = names.filter((n) => !ko2.includes(n));
      if (tr.ok && hasHangul(ko2) && !lost.length) a.answer = ko2;
      else if (lost.length) steps.push({ kind: "translate", detail: `kept original: names lost (${lost.slice(0, 3).join(", ")})` });
    }

    if (a.needs_escalation) {
      if (!root) {   // chat only: escalation would not help without files; answer + say what is missing
        const hint = ko ? "\n\n파일 내용이 필요한 질문이면 해당 폴더를 열고 다시 물어봐 주세요." : "\n\nIf this needs files, open that folder and ask again.";
        return finish({ status: "answered_local", outcomeClass: "local_unverified", answer: a.answer + hint, capsuleTokens: rendered.tokens });
      }
      return this.escalate(taskId, capsule, prompt, root, task, steps, finish, "afm_needs_escalation", taskType);
    }
    let answer = a.assumptions.length ? `${a.answer}\n\n${ko ? "가정" : "Assumptions"}:\n${a.assumptions.map((x) => `- ${x}`).join("\n")}` : a.answer;
    if (bad.length) answer += `\n\n⚠ ${ko ? "확인되지 않은 경로" : "Unverified paths"}: ${bad.join(", ")}`;
    // Episodes only when grounded in files actually read and every cited path checked out; otherwise a
    // wrong answer would be recalled as "memory" next time and repeated (seen in testing).
    const readPaths = capsule.evidence.map((e) => /^(?:file|document) (.+)$/.exec(e.label)?.[1]).filter((x): x is string => !!x).slice(0, 4);
    if (root && this.memory && !task.readOnly && readPaths.length && !bad.length && !a.assumptions.length) {   // delegated tasks read memory, never write it
      this.memory.remember(proj, { kind: "episode", sourceTask: taskId, importance: 0.4, text: `Q: ${prompt.slice(0, 160)}\nA: ${a.answer.slice(0, 280)}`, paths: readPaths });
    }
    return finish({ status: "answered_local", outcomeClass: bad.length ? "local_unverified" : "local_verified", answer, unverifiedPaths: bad.length ? bad : undefined,
      isProposal: taskType === "small_edit", capsuleTokens: rendered.tokens });
  }

  /** Steps 4–5: memory recall, deterministic seed, then the bounded guided tool loop.
   *  Returns an escalation reason on AFM failure. */
  private async gather(taskId: string, afm: AFMProvider, root: string, proj: string, prompt: string, files: { path: string; line?: number }[],
    taskType: TaskType, capsule: Capsule, steps: Step[], doc: { frame?: Frame; title?: string; lines?: string } = {}): Promise<string | undefined> {
    // 4a. Memory (advisory, oldest block → dropped first under budget pressure)
    const recalled = this.memory?.recall(proj, prompt, { k: 3, root }) ?? [];
    if (recalled.length) {
      capsule.evidence.push({ label: "memory from earlier sessions (may be stale; verify against files)", body: renderMemory(recalled) });
      steps.push({ kind: "memory", detail: `${recalled.length} notes` });
    }
    // 4b. Seed evidence deterministically before AFM picks any tool
    for (const f of files.slice(0, 2)) {
      if (["pdf", "word", "slides", "sheet"].includes(kindOf(f.path))) {
        const d = await readDocument(root, f.path, { maxChars: 4500, pdfPages: 3, db: this.db });
        // No PDF reader: say how to get one instead of answering from nothing (seen on a fresh install).
        if (d.error === PDFTEXT_MISSING) return `ask_user:${/[\uac00-\ud7a3]/.test(prompt)
          ? `\`${f.path}\`를 읽을 PDF 도구(pdftext)가 없어요. OnBud 설정 > Backend > pdftext에서 **Install**을 누르거나, Command Line Tools를 설치하세요 (\`xcode-select --install\`). 그다음 다시 물어봐 주세요.`
          : `There is no PDF reader (pdftext) to read \`${f.path}\`. Click **Install** in OnBud Settings > Backend > pdftext, or install the Command Line Tools (\`xcode-select --install\`), then ask again.`}`;
        const letter = d.error ? undefined : letterFacts(d.text);
        if (letter) capsule.evidence.push({ label: `letter structure of ${f.path}`, body: letter });
        capsule.evidence.push({ label: `document ${f.path}`, body: d.error ? d.error : `${d.spotlightKind ?? d.kind}${d.pages ? `, ${d.pages} pages` : ""}${d.truncated ? ", excerpt" : ""}\n${d.text}` });
        if (!d.error) doc.title ??= d.text.split("\n").map((l) => l.trim()).find((l) => l.length >= 12 && !/^\[(slide|page|sheet)/i.test(l));
        // The whole document searched for the framed words (not only the excerpt above); added after it, so it is
        // kept first when the capsule is cut.
        if (!d.error && doc.frame?.search_words.length) {
          // Re-read up to 12 pages, never for a scanned PDF (OCR is ~1 s a page): there the excerpt is searched.
          const full = d.truncated && d.method !== "pdftext+ocr" ? await readDocument(root, f.path, { maxChars: 60_000, pdfPages: 12, db: this.db }) : d;
          const lines = full.error ? "" : relevantLines(full.text, doc.frame.search_words);
          if (lines) { capsule.evidence.push({ label: `lines of ${f.path} with: ${doc.frame.search_words.join(", ")}`, body: lines }); doc.lines = `${doc.lines ?? ""}${lines}\n`; }
          steps.push({ kind: "lines", detail: `${lines.split("\n").filter(Boolean).length} lines` });
        }
      } else {
        const s = readSnippet(root, f.path, f.line ? Math.max(1, f.line - 20) : 1, f.line ? f.line + 20 : 60);
        capsule.evidence.push({ label: `file ${f.path}`, body: "error" in s ? s.error : s.text });
      }
    }
    for (const id of identifiers(prompt).slice(0, 2)) {
      const hits = await searchCode(root, id, { max: 8 });
      if (hits.length) capsule.evidence.push({ label: `search "${id}"`, body: hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n") });
    }
    // A folder the request names ("the skills in policies/skills"): its listing, so the answer is read, not guessed.
    for (const dir of namedDirs(prompt, root).slice(0, 2)) capsule.evidence.push({ label: `listing of ${dir}/`, body: listing(root, dir) });
    // "Which file defines/sets X?", "X는 어디서 정의돼?": the request's content words searched across the project;
    // files matching more of them come first (AFM had answered a file that does not exist).
    if (!files.length && LOCATE.test(prompt)) {
      // a Korean question about English code: its English words (Apple's on-device translator), else its own
      const en = /[가-힣]/.test(prompt) ? await toEnglish(prompt).catch(() => undefined) : undefined;
      const terms = contentTerms(en ?? prompt).slice(0, 4);
      const byFile = new Map<string, { n: Set<string>; lines: string[] }>();
      for (const t of terms) for (const h of await searchCode(root, `[${t[0].toUpperCase()}${t[0]}]${t.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, { max: 30, regex: true })) {
        const e = byFile.get(h.path) ?? { n: new Set(), lines: [] };
        e.n.add(t); if (e.lines.length < 4) e.lines.push(`${h.path}:${h.line}: ${h.text.trim().slice(0, 160)}`); byFile.set(h.path, e);
      }
      // more distinct terms first; a term in the file's own path counts too ("routing" → routing.yaml)
      const score = (p: string, e: { n: Set<string> }) => e.n.size + terms.filter((t) => p.toLowerCase().includes(t)).length;
      const ranked = [...byFile].sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]) || b[1].lines.length - a[1].lines.length).slice(0, 4);
      if (ranked.length) capsule.evidence.push({ label: `files that mention ${terms.join(", ")} (most terms first)`, body: ranked.map(([, e]) => e.lines.join("\n")).join("\n") });
      steps.push({ kind: "locate", detail: `${terms.join(",")} → ${ranked.length} files` });
    }
    if (taskType === "diff_summary") capsule.evidence.push({ label: "git diff", body: await gitDiff(root) });
    if (/(log|output|server|session|running|crash|로그|출력|서버|세션|실행 중|상태|에러|오류)/i.test(prompt)) {
      for (const sn of (await listSessions(proj)).slice(0, 2)) {
        capsule.evidence.push({ label: `session ${sn.label} (${sn.dead ? `exited ${sn.exitStatus ?? "?"}` : "running"}: ${sn.command.slice(0, 60)}) — last lines`, body: await readSession(sn.name, 40) });
      }
    }
    for (const sd of intentSeeds(prompt, files, root)) {
      const ts = Date.now();
      const r = await execCommand(sd.command, root, { timeoutMs: 10_000, maxChars: 3000 });   // controller-authored, read-only
      this.tel.toolCall({ taskId, tool: `seed:${sd.label}`, ok: r.exitCode === 0, durationMs: Date.now() - ts, resultChars: r.output.length });
      capsule.evidence.push({ label: sd.label, body: renderResult(sd.command, r) });
    }
    steps.push({ kind: "seed", detail: `${capsule.evidence.length} blocks` });
    const tools = toolsFor(prompt, taskType, TOOLS);
    const project = needsProject(prompt, files);

    // 5. Bounded AFM tool loop (read-only tools, executed here)
    let calls = 0;
    const hasFacts = () => capsule.evidence.some((e) => !e.label.startsWith("conversation") && !e.label.startsWith("memory"));
    for (let round = 0; round < this.budget.maxRounds && calls < this.budget.maxToolCalls; round++) {
      // Choosing the next tool needs to know what was read, not all of it: bodies are cut to 700 chars.
      // Less text = faster, and fewer model refusals on sensitive passages inside documents (a paper's
      // figure listing real politicians made AFM refuse the tool-argument step even at permissive level).
      const { text } = renderCapsule({ ...capsule, evidence: capsule.evidence.map((e) => ({ ...e, body: e.body.length > 700 ? e.body.slice(0, 700) + "\n… (truncated for tool choice)" : e.body })) }, this.budget.capsuleTokens);
      const sel = await selectTool(afm, {
        system: "You gather just enough evidence from the open folder to answer the GOAL. Prefer list_dir to see what exists before reading.",
        context: text,
        tools,
        // nothing read from disk yet and the request is about the folder → force one tool on this step
        allowRespond: hasFacts() || !project,
        timeoutMs: this.budget.afmTimeoutMs,
      });
      if (sel.kind === "respond") { steps.push({ kind: "select", detail: "respond_directly", ms: sel.latencyMs }); break; }
      if (sel.kind === "failed") {
        steps.push({ kind: "select", detail: `failed:${sel.step}:${sel.failure}`, ms: sel.latencyMs });
        // Guardrails can trip on a document's text while choosing a tool; if evidence is already in hand,
        // answer from it instead of escalating (the answer step reports its own failure if it trips too).
        if (sel.failure === "guardrail" && hasFacts()) { steps.push({ kind: "loop", detail: "guardrail_in_selection:answer_from_evidence" }); break; }
        return `afm_tool_${sel.failure}`;
      }
      calls++;
      if (sel.tool === "ask_user") { steps.push({ kind: "tool", detail: "ask_user", ms: sel.latencyMs }); return `ask_user:${String(sel.args.question ?? "").trim() || "Could you give more detail?"}`; }
      if (sel.tool === "run_command") {
        const cmd = String(sel.args.command ?? "").trim();
        const cls = classifyCommand(cmd, root);
        if (cls.mode === "approval") { steps.push({ kind: "tool", detail: `run_command needs approval: ${cmd.slice(0, 100)} (${cls.reasons.join(",")})`, ms: sel.latencyMs }); return `approve:${cmd}`; }
      }
      const ts = Date.now();
      const obs = await this.runTool(root, sel.tool, sel.args);
      const toolOk = !/^(blocked|not_found|unknown tool|no matches|no files|list_failed|read_failed)/.test(obs.body);
      this.tel.toolCall({ taskId, tool: sel.tool, ok: toolOk, durationMs: Date.now() - ts, errorType: toolOk ? undefined : obs.body.slice(0, 40), resultChars: obs.body.length });
      steps.push({ kind: "tool", detail: `${sel.tool} ${JSON.stringify(sel.args).slice(0, 120)}`, ms: sel.latencyMs });
      if (capsule.evidence.some((e) => e.body === obs.body)) { steps.push({ kind: "loop", detail: "repeated_observation" }); break; }
      capsule.evidence.push(obs);
    }
    return undefined;
  }

  private async runTool(root: string, tool: string, args: Record<string, any>): Promise<{ label: string; body: string }> {
    switch (tool) {
      case "search_code": {
        // AFM often searches a phrase ("apfel token") under a guessed glob. When that finds nothing,
        // widen deterministically: all files, then the longest individual words.
        const pattern = String(args.pattern ?? "");
        const glob = String(args.glob ?? "*");
        const tries: [string, string][] = [[pattern, glob]];
        if (glob !== "*") tries.push([pattern, "*"]);
        const words = pattern.split(/[^A-Za-z0-9_.-]+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length);
        if (words.length > 1) for (const w of words.slice(0, 2)) tries.push([w, "*"]);
        for (const [p, g] of tries) {
          const hits = await searchCode(root, p, { glob: g, max: 12 });
          if (hits.length) {
            const note = p !== pattern || g !== glob ? ` (widened from "${pattern}" ${glob})` : "";
            return { label: `search "${p}" ${g}${note}`, body: hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n") };
          }
        }
        return { label: `search "${pattern}" ${glob}`, body: "no matches (also tried all files and single words)" };
      }
      case "read_file": {
        const p = String(args.path ?? "");
        if (["pdf", "word", "slides", "sheet"].includes(kindOf(p))) return this.runTool(root, "read_document", { path: p });
        const s = readSnippet(root, p, Number(args.start_line) || 1, Number(args.end_line) || undefined);
        return { label: `file ${p}`, body: "error" in s ? s.error : s.text };
      }
      case "read_document": {
        const p = String(args.path ?? "");
        const d = await readDocument(root, p, { maxChars: 4500, pdfPages: 3, db: this.db });   // ~1.5k tokens: fm-guide chunk size
        return { label: `document ${p}`, body: d.error ? d.error : `${d.spotlightKind ?? d.kind}${d.pages ? `, ${d.pages} pages` : ""}${d.truncated ? ", excerpt of the beginning" : ""}\n${d.text}` };
      }
      case "list_dir": {
        const rel = String(args.path ?? ".") || ".";
        const r = listDir(root, rel);
        if (!Array.isArray(r)) return { label: `list_dir ${rel}`, body: r.error };
        const rows = r.map((name) => {
          if (name.endsWith("/") || name.startsWith("…")) return name;
          try {
            const st = statSync(resolve(root, rel, name));
            return `${name}  (${kindOf(name)}, ${humanSize(st.size)})`;
          } catch { return name; }
        });
        return { label: `list_dir ${rel}`, body: rows.length ? rows.join("\n") : "empty directory" };
      }
      case "find_files": {
        const r = await spotlightFind(root, String(args.query ?? ""), { max: 10 });
        return { label: `find_files "${args.query}"`, body: r.length ? r.join("\n") : "no files" };
      }
      case "run_command": {
        const cmd = String(args.command ?? "").trim();
        const cls = classifyCommand(cmd, root);
        if (cls.mode === "blocked") return { label: `run_command`, body: `blocked by security gate (${cls.reasons.join(", ")}): ${cmd}` };
        const r = await execCommand(cmd, root);
        return { label: `run_command`, body: renderResult(cmd, r) };
      }
      case "git_diff":
        return { label: `git diff ${args.path ?? ""}`, body: (await gitDiff(root, { path: args.path || undefined })) || "no changes" };
      default:
        return { label: tool, body: "unknown tool" };
    }
  }

  /** Plan a local job and ask the user to start it. */
  async planLocalJob(prompt: string, root: string, finish: (o: any) => Outcome, steps: Step[], ko: boolean, offline?: boolean, codeRoute?: Job["codeRoute"]): Promise<Outcome> {
    const off = offline ?? !(await frontierReachable());
    const p = await planJob(this.afm, { root, request: prompt, decima: this.decimaClient, offline: off, timeoutMs: 60_000 });
    steps.push({ kind: "job_plan", detail: p.ok ? `${p.job.steps.length} steps` : `failed:${p.error}` });
    if (!p.ok) return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: "job_plan_failed",
      answer: ko ? `할 일 목록을 만들지 못했어요 (${p.error}). 만들 파일이나 바꿀 파일을 구체적으로 알려 주세요.` : `Could not plan this (${p.error}). Name the files to create or change.` });
    const j = p.job;
    if (codeRoute) { j.codeRoute = codeRoute; saveJob(j); }
    const risk = j.decimaPlanRisk !== undefined && j.decimaPlanRisk > 0.5 ? (ko ? `\n\n⚠ Decima가 이 계획을 위험할 수 있다고 봤어요 (destructive ${j.decimaPlanRisk.toFixed(2)}).` : `\n\n⚠ Decima flags this plan as possibly destructive (${j.decimaPlanRisk.toFixed(2)}).`) : "";
    const where = ko ? `별도 브랜치 \`${j.workspace.branch}\`의 작업 폴더에서 진행하고, 단계마다 커밋과 기록(JOURNAL)을 남겨요. 실제 프로젝트는 끝난 뒤 승인할 때만 바뀌어요.` : `It runs in a separate worktree on branch \`${j.workspace.branch}\`, with a commit and journal entry per step. The real project changes only when you approve at the end.`;
    return finish({ status: "ask_user", outcomeClass: "asked_user", reasonCode: off ? "local_job_offline" : "local_job", pendingJob: { id: j.id, action: "run" },
      answer: (off ? (ko ? "Codex(인터넷)에 연결할 수 없어서 로컬 AFM으로 진행할게요.\n\n" : "Codex is not reachable, so the on-device model will do this.\n\n") : "")
        + (ko ? `**로컬 작업 계획** (\`${j.id}\`)\n\n` : `**Local job plan** (\`${j.id}\`)\n\n`) + renderJob(j, ko)
        + `\n\n${where}${j.testCmd ? (ko ? ` 확인 명령: \`${j.testCmd}\`` : ` Check: \`${j.testCmd}\``) : ""}${risk}\n\n` + (ko ? "진행할까요? (`예` / `아니요`)" : "Start? (`yes` / `no`)") });
  }

  /** Compare job branches: checks in each worktree, change size, Decima's pick (uncalibrated). */
  async compareLocalJobs(ids: string[]): Promise<{ text: string; jobs: Job[] }> {
    const jobs = ids.map((i) => loadJob(i)).filter((j): j is Job => !!j && !!j.workspace.dir);
    const ko = hasHangul(jobs[0]?.request ?? "");
    if (jobs.length < 2) return { text: ko ? "비교할 수 있는 작업 브랜치가 두 개 이상 필요해요." : "Need two job branches with worktrees.", jobs };
    const cmp = await compareJobs(jobs);
    let pick: string | undefined, probs: Record<string, number> | undefined;
    if (this.decimaClient && (await this.decimaClient.available())) {
      try {
        const criteria = Object.fromEntries(cmp.map((c) => [c.id, `${c.owner} branch: ${c.tests ? (c.tests.ok ? "checks pass" : "checks fail") : "no checks"}, ${c.files} files, +${c.added}/-${c.removed} lines`]));
        const r = await fetch(`${this.decimaClient.cfg.url}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(this.decimaClient.cfg.timeoutMs),
          body: JSON.stringify({ model: this.decimaClient.cfg.model, state: `request: ${jobs[0].request}\n\n${await jobDiffs(jobs)}`.slice(0, 12_000), questions: { better: { type: "choice", instructions: "Which branch implements the request better and more safely?", criteria } } }) });
        const d: any = await r.json(); pick = d?.answers?.better?.choice; probs = d?.answers?.better?.probabilities;
      } catch { /* advisory */ }
    }
    // Checks decide first; Decima breaks ties and is shown as a second opinion.
    const ranked = [...cmp].sort((a, b) => Number(!!b.tests?.ok) - Number(!!a.tests?.ok) || (b.id === pick ? 1 : 0) - (a.id === pick ? 1 : 0));
    const rows = cmp.map((c) => `| \`${c.id}\` | ${c.owner === "frontier" ? "Codex" : "AFM"} | ${c.tests ? (c.tests.ok ? `✅${c.tests.count !== undefined ? ` ${c.tests.count}` : ""}` : "❌") : "–"} | ${c.files} | +${c.added} / -${c.removed} | ${probs?.[c.id] !== undefined ? probs[c.id].toFixed(2) : "–"} |`);
    const head = ko ? "| 작업 | 작성 | 확인 | 파일 | 줄 | Decima |\n|---|---|---|---|---|---|" : "| job | by | checks | files | lines | Decima |\n|---|---|---|---|---|---|";
    for (const j of jobs) appendFileSync(journalPath(j.id), `\n## Compared with ${ids.filter((i) => i !== j.id).join(", ")} at ${new Date().toISOString()}\n${cmp.map((c) => `- ${c.id}: ${c.tests ? (c.tests.ok ? "checks pass" : "checks fail") : "no checks"}, ${c.stat}${probs?.[c.id] !== undefined ? `, Decima ${probs[c.id].toFixed(2)}` : ""}`).join("\n")}\n`);
    const text = `${head}\n${rows.join("\n")}\n\n${ko ? `추천: \`${ranked[0].id}\` (확인 결과 우선, 같으면 Decima 판단). Decima 점수는 보정되지 않은 참고값이에요.` : `Suggested: \`${ranked[0].id}\` (checks first, Decima as tie-break; Decima scores are uncalibrated).`}`
      + (ko ? `\n\n반영: "작업 ${ranked[0].id} 반영" · Codex에게 두 브랜치를 함께 검토시키려면 \`예\`` : `\n\nApply: "job ${ranked[0].id} apply" · reply \`yes\` to have Codex review both branches`);
    return { text, jobs };
  }

  /** Run (or continue) an approved job, streaming one line per step. */
  async runLocalJob(id: string, onProgress?: (line: string) => void): Promise<string> {
    const job = loadJob(id);
    if (!job) return `job ${id} not found`;
    const ko = hasHangul(job.request);
    // Copilot's inline completion as the middle tier for code steps AFM cannot finish (unlimited on every plan).
    const copilot = await copilotFiller(job.root);
    const done = await runJob(this.afm, job, { decima: this.decimaClient, onProgress, copilot });
    // Shadow record for calibrating decima_code_hard_threshold on real requests (tools/calibrate-code-threshold.ts).
    if (done.codeRoute) logEvent({ event: "job_outcome", jobId: id, status: done.status, ...done.codeRoute });
    const head = done.status === "done" ? (ko ? `✅ 로컬 작업 \`${id}\` 완료` : `✅ Local job \`${id}\` finished`) : (ko ? `⚠ 로컬 작업 \`${id}\`이 ${done.steps.find((s) => s.status === "failed")?.n}단계에서 멈췄어요` : `⚠ Local job \`${id}\` stopped at step ${done.steps.find((s) => s.status === "failed")?.n}`);
    const next = done.status === "done"
      ? (ko ? "\n\n실제 프로젝트에 반영할까요? (`예` / `아니요`) — 나중에 하려면 \"작업 " + id + " 반영\", 온라인일 때 Codex 검토는 \"작업 " + id + " 검토\"." : `\n\nApply to the project? (\`yes\` / \`no\`) — later: "job ${id} apply", or "job ${id} review" for Codex.`)
      : (ko ? `\n\n브랜치와 기록은 남아 있어요. 온라인이 되면 \"작업 ${id} 검토\"로 Codex가 이어서 고치게 할 수 있어요.` : `\n\nThe branch and journal are kept; when online, "job ${id} review" lets Codex continue.`);
    return `${head}\n\n${renderJob(done, ko)}\n\n\`\`\`\n${done.summary ?? ""}\n\`\`\`\n${ko ? "브랜치" : "Branch"}: \`${done.workspace.branch}\` · ${ko ? "작업 폴더" : "worktree"}: \`${done.workspace.dir}\` · ${ko ? "기록" : "journal"}: \`${journalPath(id)}\`${next}`;
  }

  async applyLocalJob(id: string): Promise<string> {
    const job = loadJob(id);
    if (!job) return `job ${id} not found`;
    const ko = hasHangul(job.request);
    const r = await applyJob(job);
    return r.ok ? (ko ? `반영했어요 (${r.files.length}개 파일):\n${r.files.map((f) => `- \`${f}\``).join("\n")}\n\n되돌리려면 \`git checkout -p\` 또는 \`git apply -R ${journalPath(id).replace("JOURNAL.md", "changes.patch")}\`.` : `Applied (${r.files.length} files). Undo with \`git apply -R ${journalPath(id).replace("JOURNAL.md", "changes.patch")}\`.`)
      : (ko ? `반영하지 못했어요 (${r.error}).` : `Could not apply (${r.error}).`);
  }

  async discardLocalJob(id: string): Promise<string> { const j = loadJob(id); if (!j) return `job ${id} not found`; await discardJob(j); return hasHangul(j.request) ? `작업 \`${id}\`의 브랜치와 작업 폴더를 지웠어요. 기록은 \`${journalPath(id)}\`에 남아 있어요.` : `Removed job \`${id}\`'s branch and folder; the journal stays at \`${journalPath(id)}\`.`; }

  /** Approved web search: search, read the top pages, answer from them with numbered sources. */
  async answerFromWeb(prompt: string, query: string, kind: WebKind): Promise<{ text: string; backend: string; n: number }> {
    const ko = hasHangul(prompt);
    const taskId = randomUUID();
    const afm = this.tracked(taskId);
    const { results, backend } = await webSearch(query, { kind, n: 5 });
    this.tel.toolCall({ taskId, tool: `web_search:${backend}`, ok: results.length > 0, durationMs: 0, resultChars: results.length });
    if (!results.length) return { text: ko ? `"${query}"로 검색했지만 결과가 없었어요.` : `No results for "${query}".`, backend, n: 0 };
    const top = results.slice(0, 3);   // mutable: a second query may add pages
    const pages = await Promise.all(top.map((r) => (kind !== "encyclopedia" && !/arxiv\.org\/abs/.test(r.url) ? fetchPage(r.url, 3200) : Promise.resolve({ url: r.url, title: r.title, text: r.snippet }))));
    const capsule: Capsule = { goal: prompt, constraints: ["Answer only from the WEB sources below; cite them as [1], [2], [3]", "Say so if the sources do not answer the question"], evidence: [] };
    top.forEach((r, i) => capsule.evidence.push({ label: `web [${i + 1}] ${r.title} — ${r.url}`, body: (pages[i].text || r.snippet).slice(0, 3200) }));
    const rendered = renderCapsule(capsule, this.budget.capsuleTokens);
    const ans = await afm.generate({ system: `${this.policy.afmSystem}\nYou answer from web search results. Cite sources as [n].`, user: rendered.text, schema: answerSchema([]), maxTokens: 900, timeoutMs: Math.max(this.budget.afmTimeoutMs, 45_000) });
    let body = ans.ok ? String((ans.json as any).answer ?? "") : "";
    // Second attempt when the pages did not contain the fact: a reformulated query, two more pages.
    const noQuote = ans.ok && !((ans.json as any).quotes ?? []).some((q: string) => q && q.length > 3);
    if (!body || noQuote || /(not (mentioned|found|stated|provided)|찾을 수 없|언급되지 않|확인할 수 없|나와 있지 않)/i.test(body)) {
      const q2 = await afm.generate({ system: "The first web search did not answer the question. Write a different search query (other keywords, official source names, exact technical terms).", user: `QUESTION: ${prompt}\nFIRST QUERY: ${query}`, maxTokens: 60, timeoutMs: this.budget.afmTimeoutMs,
        schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } });
      const query2 = q2.ok ? redact(String((q2.json as any).query ?? "")).text.slice(0, 200) : "";
      if (query2 && query2 !== query) {
        const more = (await webSearch(query2, { kind, n: 5 })).results.filter((r) => !top.some((t) => t.url === r.url)).slice(0, 2);
        const pages2 = await Promise.all(more.map((r) => (kind !== "encyclopedia" && !/arxiv\.org\/abs/.test(r.url) ? fetchPage(r.url, 3200) : Promise.resolve({ url: r.url, title: r.title, text: r.snippet }))));
        more.forEach((r, i) => { capsule.evidence.push({ label: `web [${top.length + i + 1}] ${r.title} — ${r.url}`, body: (pages2[i].text || r.snippet).slice(0, 3200) }); results.push(r); top.push(r); });
        const ans2 = await afm.generate({ system: `${this.policy.afmSystem}\nYou answer from web search results. Cite sources as [n].`, user: renderCapsule(capsule, this.budget.capsuleTokens).text, schema: answerSchema([]), maxTokens: 900, timeoutMs: Math.max(this.budget.afmTimeoutMs, 45_000) });
        if (ans2.ok && String((ans2.json as any).answer ?? "").trim()) body = String((ans2.json as any).answer);
      }
    }
    const hangulShare = (t: string) => (t.match(/[\uac00-\ud7a3]/g)?.length ?? 0) / Math.max(1, t.replace(/\s/g, "").length);
    if (body && ko && hangulShare(body) < 0.2) {
      const tr = await afm.generate({ system: "Translate into natural Korean. Keep names, numbers, [n] citations and technical terms exactly.", user: body, maxTokens: 900, timeoutMs: this.budget.afmTimeoutMs,
        schema: { type: "object", properties: { korean: { type: "string" } }, required: ["korean"], additionalProperties: false } });
      const k = tr.ok ? String((tr.json as any).korean ?? "") : "";
      if (hasHangul(k)) body = k;
    }
    const sources = results.map((r, i) => `${i + 1}. [${r.title || r.url}](${r.url})${i >= 3 ? (ko ? " (읽지 않음)" : " (not read)") : ""}`).join("\n");
    const head = body || (ko ? "AFM이 답을 만들지 못했어요. 검색 결과만 보여 드려요." : "AFM could not write an answer; here are the results.");
    return { text: `${head}\n\n${ko ? "출처" : "Sources"} (${backend}, \`${query}\`):\n${sources}`, backend, n: results.length };
  }

  /** The single file a small edit targets: the named code/text file, or the only file defining the named identifier. */
  private async editTarget(root: string, prompt: string, files: { path: string }[]): Promise<string | undefined> {
    const code = files.filter((f) => ["code", "text"].includes(kindOf(f.path)));
    if (code.length === 1) return code[0].path;
    if (code.length > 1) return undefined;
    const ids = identifiers(prompt);
    if (!ids.length) return undefined;
    const hits = await searchCode(root, ids[0], { max: 20 });
    const paths = [...new Set(hits.map((h) => h.path))].filter((p) => !/(^|\/)(tests?|__tests__)\/|test_|_test\./.test(p));
    return paths.length === 1 ? paths[0] : undefined;
  }

  /** Approved trial of an AFM edit: sandbox + tests; on failure AFM gets the output once and tries again. */
  async runEditTrial(root: string, request: string, pe: { edit: EditProposal; testCmd?: string }, onProgress?: (msg: string) => void): Promise<{ trial: TrialResult; attempts: number; report: string }> {
    const ko = hasHangul(request);
    const sysEdit = systemFor(this.policy, "small_edit").text;
    let edit = pe.edit;
    let trial = await trialEdit(root, edit, pe.testCmd);
    let attempts = 1;
    const parts = [`**${ko ? "시도" : "Attempt"} 1** — ${renderTrial(trial, ko)}`];
    if (!trial.ok && (trial.stage === "tests" || trial.stage === "syntax")) {
      onProgress?.(ko ? "테스트가 실패해서 AFM이 출력을 보고 한 번 더 고쳐 볼게요…\n\n" : "Tests failed; AFM is revising once from the output…\n\n");
      const p = await proposeEdit(this.afm, { root, path: edit.path, request, system: sysEdit, previous: edit, feedback: trial.result?.output ?? "", timeoutMs: 60_000 });
      if (p.ok) {
        attempts = 2;
        edit = p.edit;
        trial = await trialEdit(root, edit, pe.testCmd);
        parts.push(`**${ko ? "시도" : "Attempt"} 2** — ${edit.explanation}\n\n\`\`\`diff\n${trial.diff}\n\`\`\`\n\n${renderTrial(trial, ko)}`);
      } else parts.push(ko ? `AFM이 수정안을 다시 만들지 못했어요 (${p.error}).` : `AFM could not produce a corrected edit (${p.error}).`);
    }
    this.tel.verification({ taskId: randomUUID(), kind: "edit_trial", passed: trial.ok, detail: `${trial.stage}:${attempts}` });
    return { trial, attempts, report: parts.join("\n\n") };
  }

  private async escalate(taskId: string, capsule: Capsule, prompt: string, root: string | undefined, task: Task, steps: Step[],
    finish: (o: any) => Outcome, reasonCode: string, taskType: TaskType): Promise<Outcome> {
    if (capsule.evidence.length === 0 && root) capsule.evidence.push({ label: "git status", body: await gitStatus(root) });
    const rendered = renderCapsule(capsule, 3000);
    steps.push({ kind: "escalate", detail: reasonCode });
    logEvent({ taskId, event: "escalate", reasonCode, frontier: !!(task.allowFrontier && this.frontier) });
    // Reflexion-style lesson: remembered and shown on similar later tasks.
    if (root && this.memory && !task.readOnly && reasonCode.startsWith("afm_")) {
      this.memory.remember(projectHash(root), { kind: "lesson", sourceTask: taskId, importance: 0.7,
        text: `Local AFM could not finish a ${taskType} task ("${prompt.slice(0, 100)}"): ${reasonCode}. Read the relevant files first or hand off to codex.`,
        keywords: [taskType, reasonCode] });
    }
    if (!task.allowFrontier || !this.frontier) {
      return finish({ status: "escalation_required", outcomeClass: "escalation_pending", reasonCode, capsule: rendered.text, capsuleTokens: rendered.tokens,
        answer: `Escalation needed (${reasonCode}).` });
    }
    const handoff = `${prompt}\n\n---\nLocal pre-analysis (on-device model, redacted, may be incomplete):\n${rendered.text}`;
    const ts = Date.now();
    const r = await this.frontier.run(handoff, root ?? process.cwd());
    this.tel.modelCall({ taskId, provider: this.frontier.name, model: "frontier", purpose: "handoff", ok: r.ok, failure: r.detail, latencyMs: Date.now() - ts, costType: "subscription" });
    steps.push({ kind: "frontier", detail: r.ok ? this.frontier.name : `failed:${r.detail}`, ms: Date.now() - ts });
    return finish({ status: r.ok ? "answered_frontier" : "failed", outcomeClass: r.ok ? "escalated_recovered" : "failed", reasonCode, answer: r.text, capsule: rendered.text, capsuleTokens: rendered.tokens });
  }
}
