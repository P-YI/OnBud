// AFM small edits with a local edit → test loop (single file, bounded, approval-gated):
//   1. AFM proposes ONE exact search/replace edit (schema: old_text, new_text) for one named file.
//   2. The controller checks old_text occurs exactly once and shows the diff.  → user approves the trial
//   3. Trial: APFS clone of the project (cp -c, near-zero disk), apply, syntax check, run the tests.
//      On failure AFM gets the test output once and proposes a corrected edit (max 2 attempts).
//   4. Only after the user approves again is the real file written, and only if it has not changed since.
// Anything bigger (several files, design, repeated test failures) goes to Codex.

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { gatePath, redact } from "../security/gate.ts";
import { execCommand, renderResult, type CommandResult } from "../context-builder/terminal.ts";
import { findMainTex, hasTeX, parseLatexLog, trialCompileCommand } from "../context-builder/latex.ts";

// preservesBehaviour: the edit cannot change what the code does (e.g. docstrings, checked with the AST), so tests
// that already failed before it are not its fault and only new failures count.
export interface EditProposal { path: string; oldText: string; newText: string; explanation: string; baseHash: string; preservesBehaviour?: boolean }
export interface TrialResult { ok: boolean; stage: "apply" | "syntax" | "tests" | "no_tests"; command?: string; result?: CommandResult; diff: string; edit: EditProposal; preexisting?: string[] }

const SANDBOX_ROOT = join(process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM"), "runtime", "sandbox");
const MAX_FILES = 20_000;   // larger trees are not cloned: hand off to Codex instead
export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const EDIT_SCHEMA = {
  type: "object" as const,
  properties: {
    old_text: { type: "string" as const, description: "Exact lines copied from FILE that must change, including indentation. Keep it short (1–15 lines) but unique in the file" },
    new_text: { type: "string" as const, description: "The replacement for old_text, with the same indentation style" },
    explanation: { type: "string" as const, description: "One sentence: what changed and why, in the user's language" },
  },
  required: ["old_text", "new_text", "explanation"],
  additionalProperties: false,
};

/** JSON escaping slips seen with LaTeX: "\\textbf" doubled, or "\t"/"\b"/"\f" turned into control characters. */
const unescapeVariants = (s: string) => [s, s.replace(/\\\\/g, "\\"), s.replace(/\t(?=[a-z])/g, "\\t").replace(/\x08(?=[a-z])/g, "\\b").replace(/\f(?=[a-z])/g, "\\f").replace(/\r(?=[a-z])/g, "\\r")];

/** Apply old→new exactly once (trying LaTeX escape repairs), else a whitespace-tolerant or fuzzy match. */
export function applyEdit(content: string, oldText: string, newText: string): { ok: true; text: string; fuzzy?: boolean } | { ok: false; error: string } {
  const o = unescapeVariants(oldText), n = unescapeVariants(newText);
  let last: { ok: false; error: string } = { ok: false, error: "old_text_not_found" };
  for (let i = 0; i < o.length; i++) {
    if (i > 0 && o[i] === o[0]) continue;
    const r = applyEditOnce(content, o[i], n[i]);
    if (r.ok || r.error !== "old_text_not_found") return r;
    last = r;
  }
  return last;
}

function applyEditOnce(content: string, oldText: string, newText: string): { ok: true; text: string; fuzzy?: boolean } | { ok: false; error: string } {
  if (!oldText.trim()) return { ok: false, error: "empty_old_text" };
  if (oldText === newText) return { ok: false, error: "no_change" };
  const n = content.split(oldText).length - 1;
  if (n === 1) return { ok: true, text: content.replace(oldText, () => newText) };
  if (n > 1) return { ok: false, error: "old_text_not_unique" };
  const norm = (s: string) => s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
  const lines = content.split("\n");
  const want = norm(oldText).split("\n");
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (lines.slice(i, i + want.length).map((l) => l.replace(/\s+$/, "")).join("\n") === want.join("\n")) hits.push(i);
  }
  if (hits.length > 1) return { ok: false, error: "old_text_not_unique" };
  if (hits.length === 1) return { ok: true, text: [...lines.slice(0, hits[0]), ...newText.split("\n"), ...lines.slice(hits[0] + want.length)].join("\n") };
  return fuzzyApply(lines, oldText, newText);
}

/** Character-bigram Dice similarity of two lines, ignoring surrounding whitespace. */
function lineSim(a: string, b: string): number {
  a = a.trim(); b = b.trim();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const A = grams(a), B = grams(b);
  let both = 0;
  for (const [g, n] of A) both += Math.min(n, B.get(g) ?? 0);
  return (2 * both) / (a.length - 1 + b.length - 1);
}

/** Small models retype old_text with slips ("""→"). Find the one region that matches line by line
 *  (≥ 0.85 on average, clearly better than any other), then keep the file's own text for every line
 *  the edit did not change, so only the intended lines differ. Aider uses a similar fuzzy fallback. */
function fuzzyApply(lines: string[], oldText: string, newText: string): { ok: true; text: string; fuzzy: true } | { ok: false; error: string } {
  const want = oldText.replace(/\n+$/, "").split("\n");
  const need = want.length < 2 ? 0.9 : 0.85;   // a single line must match more closely
  const scores: { i: number; s: number }[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let sum = 0;
    for (let j = 0; j < want.length; j++) sum += lineSim(lines[i + j], want[j]);
    scores.push({ i, s: sum / want.length });
  }
  scores.sort((a, b) => b.s - a.s);
  const [best, second] = scores;
  if (!best || best.s < need || (second && second.s > best.s - 0.1)) return { ok: false, error: best && best.s >= need ? "old_text_not_unique" : "old_text_not_found" };
  const region = lines.slice(best.i, best.i + want.length);
  const repl = newText.replace(/\n+$/, "").split("\n").map((l) => { const j = want.indexOf(l); return j >= 0 ? region[j] : l; });
  return { ok: true, fuzzy: true, text: [...lines.slice(0, best.i), ...repl, ...lines.slice(best.i + want.length)].join("\n") };
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } },
      (err: any, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: String(stdout ?? "") + String(stderr ?? "") }));
    child.stdin?.end();
  });
}

/** Unified diff of one file (git diff --no-index works outside repositories too). */
export async function diffOf(path: string, before: string, after: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "afm-diff-"));
  try {
    mkdirSync(join(dir, "a"), { recursive: true }); mkdirSync(join(dir, "b"), { recursive: true });
    const name = basename(path);
    writeFileSync(join(dir, "a", name), before); writeFileSync(join(dir, "b", name), after);
    const r = await run("git", ["diff", "--no-index", "--no-color", "-U2", `a/${name}`, `b/${name}`], dir);
    const body = r.out.replace(/^diff --git.*\n(index.*\n)?/m, "").replace(/^--- .*$/m, `--- a/${path}`).replace(/^\+\+\+ .*$/m, `+++ b/${path}`);
    return redact(body).text.trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** \cite/\ref/\label keys (and the commands themselves) present before an edit but gone after it. */
export function latexKeysLost(before: string, after: string): string[] {
  const keys = (t: string) => new Set([...t.matchAll(/\\(cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|label)\*?(?:\[[^\]]*\])*\{([^}]+)\}/g)].flatMap((m) => m[2].split(",").map((k) => `\\${m[1]}{${k.trim()}}`)));
  const a = keys(after);
  return [...keys(before)].filter((k) => !a.has(k));
}

/** Ask AFM for one edit. `feedback` carries the failing test output on the second attempt. */
export async function proposeEdit(afm: AFMProvider, a: { root: string; path: string; request: string; system: string; feedback?: string; previous?: EditProposal; timeoutMs?: number }):
  Promise<{ ok: true; edit: EditProposal; diff: string } | { ok: false; error: string }> {
  const g = gatePath(a.path, a.root, "write");
  if (g.verdict !== "allow") return { ok: false, error: `blocked:${g.reasons.join(",")}` };
  const content = readFileSync(join(a.root, a.path), "utf8");
  if (content.length > 24_000) return { ok: false, error: "file_too_large_for_local_edit" };
  const numbered = content.split("\n").map((l, i) => `${i + 1}| ${l}`).join("\n");
  const user = [
    `REQUEST: ${a.request}`,
    `FILE ${a.path}:\n${numbered.slice(0, 14_000)}`,
    a.previous ? `YOUR PREVIOUS EDIT replaced:\n${a.previous.oldText}\nwith:\n${a.previous.newText}` : "",
    a.feedback ? `IT FAILED THE TESTS:\n${a.feedback.slice(-2500)}\nPropose a corrected edit against the ORIGINAL file above.` : "",
    "Copy old_text exactly from FILE without the line-number prefixes.",
  ].filter(Boolean).join("\n\n");
  const r = await afm.generate({ system: a.system, user, schema: EDIT_SCHEMA, maxTokens: 900, timeoutMs: a.timeoutMs ?? 45_000 });
  if (!r.ok) return { ok: false, error: `afm_${r.failure}` };
  const j = r.json as { old_text: string; new_text: string; explanation: string };
  const strip = (s: string) => s.replace(/^\s*\d+\| ?/gm, "");   // AFM sometimes copies the line numbers
  const oldText = /^\s*\d+\| /m.test(j.old_text) ? strip(j.old_text) : j.old_text;
  const newText = /^\s*\d+\| /m.test(j.new_text) ? strip(j.new_text) : j.new_text;
  const isTex = /\.(tex|bib|sty|cls)$/i.test(a.path);
  // In LaTeX a tab/backspace/formfeed followed by letters is a broken "\t…"/"\b…"/"\f…" escape, never intended.
  const fixedNew = isTex ? newText.replace(/\t(?=[A-Za-z])/g, "\\t").replace(/\x08(?=[A-Za-z])/g, "\\b").replace(/\f(?=[A-Za-z])/g, "\\f").replace(/\r(?=[A-Za-z])/g, "\\r") : newText;
  const applied = applyEdit(content, oldText, fixedNew);
  if (!applied.ok) return { ok: false, error: applied.error };
  if (isTex && !/(cite|citation|ref|label|인용|참조|레퍼런스)/i.test(a.request)) {
    const lost = latexKeysLost(content, applied.text);
    if (lost.length) return { ok: false, error: `latex_keys_changed:${lost.slice(0, 3).join(",")}` };
  }
  const edit: EditProposal = { path: a.path, oldText, newText: fixedNew, explanation: j.explanation, baseHash: sha(content) };
  return { ok: true, edit, diff: await diffOf(a.path, content, applied.text) };
}

function countFiles(dir: string, limit: number): number {
  let n = 0;
  const stack = [dir];
  while (stack.length && n <= limit) {
    const d = stack.pop()!;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) { n++; if (e.isDirectory() && !e.isSymbolicLink()) stack.push(join(d, e.name)); }
  }
  return n;
}

function canImport(root: string, py: string, mod: string): boolean {
  try {
    execFileSync(py.startsWith("/") || py === "python3" ? py : join(root, py), ["-c", `import ${mod}`],
      { cwd: root, stdio: "ignore", timeout: 5000, env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: homedir() } });
    return true;
  } catch { return false; }
}

/** The project's test command, if one is recognisable. Prefers the test file that matches the edited file. */
export function detectTestCommand(root: string, editedPath?: string): string | undefined {
  const has = (p: string) => existsSync(join(root, p));
  const py = has(".venv/bin/python") ? ".venv/bin/python" : has("venv/bin/python") ? "venv/bin/python" : "python3";
  const stem = editedPath ? basename(editedPath, extname(editedPath)) : "";
  if (editedPath?.endsWith(".py") || has("pytest.ini") || has("conftest.py") || has("tests") || has("test")) {
    const pyproject = has("pyproject.toml") ? readFileSync(join(root, "pyproject.toml"), "utf8") : "";
    const testDirs = ["tests", "test", "."].filter(has);
    const match = stem && testDirs.map((d) => join(d, `test_${stem}.py`)).find(has);
    const anyTests = has("pytest.ini") || has("conftest.py") || /\[tool\.pytest/.test(pyproject)
      || testDirs.some((d) => { try { return readdirSync(join(root, d)).some((f) => /^test_.*\.py$|_test\.py$/.test(f)); } catch { return false; } });
    if (match || anyTests) {
      // Use pytest only if it is installed for that interpreter; plain unittest suites run without it.
      if (canImport(root, py, "pytest")) return match ? `${py} -m pytest -q -x ${match.replace(/^\.\//, "")}` : `${py} -m pytest -q -x`;
      const usesUnittest = testDirs.some((d) => { try { return readdirSync(join(root, d)).filter((f) => /^test.*\.py$/.test(f)).some((f) => /import unittest|from unittest/.test(readFileSync(join(root, d, f), "utf8"))); } catch { return false; } });
      if (usesUnittest) return match ? `${py} -m unittest -q ${match.replace(/^\.\//, "").replace(/\.py$/, "").replace(/\//g, ".")}` : `${py} -m unittest discover -q`;
    }
  }
  if (editedPath?.endsWith(".tex") || editedPath?.endsWith(".bib")) {
    const main = findMainTex(root);
    if (main && hasTeX()) return trialCompileCommand(root, main);   // the "test" for a paper is that it still compiles
  }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return "npm test --silent";
    } catch { /* not JSON */ }
  }
  if (has("go.mod")) return "go test ./...";
  if (has("Cargo.toml")) return "cargo test -q";
  return undefined;
}

/** Cheap syntax check for the edited file (no project code runs). */
export function syntaxCheck(path: string): string | undefined {
  const q = `'${path.replace(/'/g, "")}'`;
  if (path.endsWith(".py")) return `python3 -m py_compile ${q}`;
  if (/\.(m?js|cjs)$/.test(path)) return `node --check ${q}`;
  if (path.endsWith(".json")) return `python3 -m json.tool ${q} > /dev/null`;
  if (path.endsWith(".sh")) return `sh -n ${q}`;
  return undefined;
}

/** Apply the edit in a throwaway APFS clone, syntax-check, run tests; never touches the real project. */
export async function trialEdit(root: string, edit: EditProposal, testCmd: string | undefined, timeoutMs = 120_000): Promise<TrialResult> {
  const original = readFileSync(join(root, edit.path), "utf8");
  const applied = applyEdit(original, edit.oldText, edit.newText);
  const diff = applied.ok ? await diffOf(edit.path, original, applied.text) : "";
  if (!applied.ok || sha(original) !== edit.baseHash) return { ok: false, stage: "apply", diff, edit };
  if (countFiles(root, MAX_FILES) > MAX_FILES) return { ok: false, stage: "apply", diff, edit, command: "project_too_large_for_sandbox" };
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  const box = mkdtempSync(join(SANDBOX_ROOT, "trial-"));
  const copy = join(box, basename(root));
  try {
    // cp -c = clonefile(2): copy-on-write, so even large trees cost almost no disk.
    const cp = await run("/bin/cp", ["-cR", root, copy], box, 60_000);
    if (cp.code !== 0) cpSync(root, copy, { recursive: true });
    writeFileSync(join(copy, edit.path), applied.text);
    const syn = syntaxCheck(edit.path);
    if (syn) {
      const r = await execCommand(syn, copy, { timeoutMs: 20_000, maxChars: 3000 });
      if (r.exitCode !== 0) return { ok: false, stage: "syntax", command: syn, result: r, diff, edit };
    }
    if (!testCmd) return { ok: true, stage: "no_tests", diff, edit };
    const r = await execCommand(testCmd, copy, { timeoutMs, maxChars: 6000 });
    if (r.exitCode === 0 || r.timedOut || !edit.preservesBehaviour) return { ok: r.exitCode === 0 && !r.timedOut, stage: "tests", command: testCmd, result: r, diff, edit };
    // Behaviour-preserving edit with failing tests: judged by *new* failures, as local jobs are. The same tests on the
    // unmodified copy give the baseline; the failures that were already there are reported. (A bug fix is not judged
    // this way: there the failing test is exactly what the edit must fix.)
    writeFileSync(join(copy, edit.path), original);
    const base = await execCommand(testCmd, copy, { timeoutMs, maxChars: 6000 });
    const { failingTests } = await import("./jobs.ts");
    const after = failingTests(r.output), before = failingTests(base.output);
    const added = [...after].filter((x) => !before.has(x));
    const ok = after.size > 0 && before.size > 0 && added.length === 0;
    return { ok, stage: "tests", command: testCmd, result: r, diff, edit, ...(ok ? { preexisting: [...after] } : {}) };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

/** Write the approved edit to the real file, only if the file is still what the edit was made against. */
export function applyToProject(root: string, edit: EditProposal): { ok: boolean; error?: string } {
  const g = gatePath(edit.path, root, "write");
  if (g.verdict !== "allow") return { ok: false, error: `blocked:${g.reasons.join(",")}` };
  const current = readFileSync(join(root, edit.path), "utf8");
  if (sha(current) !== edit.baseHash) return { ok: false, error: "file_changed_since_proposal" };
  const applied = applyEdit(current, edit.oldText, edit.newText);
  if (!applied.ok) return { ok: false, error: applied.error };
  writeFileSync(join(root, edit.path), applied.text);
  return { ok: true };
}

export function renderTrial(t: TrialResult, ko: boolean): string {
  // latexmk logs are long: show the parsed summary (errors, undefined refs/cites) instead of the raw log.
  const latex = /latexmk/.test(t.command ?? "") && t.result;
  const summary = latex ? (() => { const p = parseLatexLog(t.result!.output); return [...p.errors.slice(0, 4).map((e) => `${e.file ? `${e.file}:${e.line}: ` : ""}${e.message}`),
    p.undefinedCites.length ? `undefined citations: ${p.undefinedCites.join(", ")}` : "", p.undefinedRefs.length ? `undefined references: ${p.undefinedRefs.join(", ")}` : "", `[exit ${t.result!.exitCode}]`].filter(Boolean).join("\n"); })() : "";
  const out = t.result ? "```\n" + (latex ? summary : renderResult(t.command ?? "", t.result).slice(-2500)) + "\n```" : "";
  const head = t.ok
    ? (t.stage === "no_tests" ? (ko ? "✅ 문법 검사 통과 (테스트를 찾지 못해 실행하지 않았어요)" : "✅ Syntax check passed (no tests found to run)")
      : t.preexisting?.length ? (ko ? `✅ 새로 깨진 테스트 없음: \`${t.command}\` (원래부터 실패하던 테스트 ${t.preexisting.length}개: ${t.preexisting.map((x) => `\`${x}\``).join(", ")})` : `✅ No new test failures: \`${t.command}\` (already failing before the edit: ${t.preexisting.map((x) => `\`${x}\``).join(", ")})`)
      : (ko ? `✅ 샌드박스 사본에서 테스트 통과: \`${t.command}\`` : `✅ Tests passed in a sandbox copy: \`${t.command}\``))
    : t.stage === "apply" ? (ko ? `⚠ 편집을 적용할 수 없어요 (${t.command ?? "파일이 바뀌었거나 일치하는 부분이 없음"})` : `⚠ The edit could not be applied (${t.command ?? "file changed or no match"})`)
    : t.stage === "syntax" ? (ko ? "❌ 문법 검사 실패" : "❌ Syntax check failed")
    : (ko ? `❌ 샌드박스 사본에서 테스트 실패: \`${t.command}\`` : `❌ Tests failed in a sandbox copy: \`${t.command}\``);
  return `${head}\n\n${out}`.trim();
}
