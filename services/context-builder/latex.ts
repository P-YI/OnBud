// LaTeX for papers, fully offline (MacTeX in /Library/TeX/texbin; no network, no model needed for the
// deterministic parts):
//   - find the main .tex (\documentclass + \begin{document}), pick the engine (xelatex for kotex/fontspec)
//   - compile with latexmk, shell-escape off, output in ~/OnBud/runtime/latex/<project>/ (project untouched)
//   - parse the log into file:line errors, undefined references/citations, overfull boxes
//   - cross-check \cite keys against .bib files, \ref against \label, duplicate labels
// Fixing errors reuses the AFM edit→test loop: the "test" is a compile in a sandbox clone.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execCommand, type CommandResult } from "./terminal.ts";

const TEXBIN = "/Library/TeX/texbin";
const OUT_ROOT = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "latex");

export const hasTeX = () => existsSync(join(TEXBIN, "latexmk"));

function texFiles(root: string, max = 200): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) walk(r, depth + 1);
      else if (/\.(tex|bib)$/i.test(e.name)) out.push(r);
      if (out.length >= max) return;
    }
  };
  walk("", 0);
  return out;
}

export function isLatexProject(root: string): boolean { return texFiles(root, 50).some((f) => f.endsWith(".tex")); }

/** Root documents (\documentclass and \begin{document}) under `root`. */
export function mainTexFiles(root: string): string[] {
  return texFiles(root).filter((f) => f.endsWith(".tex")).filter((f) => {
    try { const t = readFileSync(join(root, f), "utf8"); return /\\documentclass/.test(t) && /\\begin\{document\}/.test(t); } catch { return false; }
  });
}

/** A .tex file named by an absolute or ~/ path in the request: { abs } if it exists inside the home folder,
 *  { missing } if not; undefined when no such path is written. */
export function namedTexPath(prompt: string, home = homedir()): { abs: string } | { missing: string } | undefined {
  const m = /(?:^|[\s`'"(“‘:])((?:~\/|\/)[^\s`'"”’)]+?\.tex)(?=$|[\s`'"”’),.!?]|[가-힣])/i.exec(prompt);
  if (!m) return undefined;
  const abs = resolve(m[1].startsWith("~/") ? join(home, m[1].slice(2)) : m[1]).normalize("NFC");
  if (!abs.startsWith(home + "/")) return { missing: m[1] };
  try { return statSync(abs).isFile() ? { abs } : { missing: m[1] }; } catch { return { missing: m[1] }; }
}

/** The root document: has \documentclass and \begin{document}; prefers main.tex / paper.tex / the largest. */
export function findMainTex(root: string, hint?: string): string | undefined {
  if (hint && /\.tex$/.test(hint) && existsSync(join(root, hint))) return hint;
  const mains = mainTexFiles(root);
  const pref = mains.find((f) => /^(main|paper|thesis|manuscript)\.tex$/i.test(basename(f)));
  return pref ?? mains.sort((a, b) => statSync(join(root, b)).size - statSync(join(root, a)).size)[0];
}

export function engineFor(root: string, main: string): "pdf" | "xelatex" | "lualatex" {
  const t = readFileSync(join(root, main), "utf8");
  if (/\\usepackage(\[[^\]]*\])?\{(fontspec|xeCJK|unicode-math)\}|%\s*!TEX\s+(TS-)?program\s*=\s*xelatex/i.test(t)) return "xelatex";
  if (/\\usepackage(\[[^\]]*\])?\{luatexko\}|%\s*!TEX\s+(TS-)?program\s*=\s*lualatex/i.test(t)) return "lualatex";
  if (/\\usepackage(\[[^\]]*\])?\{kotex\}/.test(t)) return "xelatex";   // kotex works best with xelatex
  return "pdf";
}

/** latexmk command for `main` (relative to the project), writing everything into `outDir`. */
export function compileCommand(root: string, main: string, outDir: string): string {
  const eng = engineFor(root, main);
  const flag = eng === "pdf" ? "-pdf" : eng === "xelatex" ? "-xelatex" : "-lualatex";
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `PATH=${TEXBIN}:$PATH latexmk ${flag} -interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape -outdir=${q(outDir)} ${q(main)}`;
}

/** Compile command for an edit trial inside a sandbox clone (output stays in the clone). */
export function trialCompileCommand(root: string, main: string): string { return compileCommand(root, main, ".afm-build"); }

export interface LatexIssue { file?: string; line?: number; message: string }
export interface LatexReport { ok: boolean; pdf?: string; errors: LatexIssue[]; undefinedRefs: string[]; undefinedCites: string[]; overfull: number; warnings: number; ms: number; result: CommandResult; engine: string }

export function parseLatexLog(log: string): Omit<LatexReport, "ok" | "pdf" | "ms" | "result" | "engine"> {
  const errors: LatexIssue[] = [];
  for (const m of log.matchAll(/^(?:\.\/)?([^\s:][^:\n]*\.(?:tex|sty|cls|bib)):(\d+): (.+)$/gm)) errors.push({ file: m[1], line: Number(m[2]), message: m[3].trim() });
  for (const m of log.matchAll(/^! (.+)$/gm)) if (!errors.some((e) => e.message.includes(m[1].trim()))) errors.push({ message: m[1].trim() });
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    errors: errors.slice(0, 10),
    undefinedRefs: uniq([...log.matchAll(/Reference `([^']+)' on page \d+ undefined/g)].map((m) => m[1])),
    undefinedCites: uniq([...log.matchAll(/Citation `([^']+)' on page \d+ undefined/g)].map((m) => m[1])),
    overfull: (log.match(/^Overfull \\hbox/gm) ?? []).length,
    warnings: (log.match(/^(LaTeX|Package \w+) Warning/gm) ?? []).length,
  };
}

/** Compile into ~/OnBud/runtime/latex/<project-hash>/ and summarise the log. */
export async function compileLatex(root: string, main: string, timeoutMs = 180_000): Promise<LatexReport> {
  const outDir = join(OUT_ROOT, createHash("sha256").update(root).digest("hex").slice(0, 10));
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const result = await execCommand(`cd ${JSON.stringify(dirname(join(root, main)))} && ${compileCommand(dirname(join(root, main)), basename(main), outDir)}`, root, { timeoutMs, maxChars: 4000 });
  const logPath = join(outDir, basename(main).replace(/\.tex$/, ".log"));
  const log = existsSync(logPath) ? readFileSync(logPath, "latin1") : result.output;
  const pdf = join(outDir, basename(main).replace(/\.tex$/, ".pdf"));
  const parsed = parseLatexLog(log);
  const ok = result.exitCode === 0 && existsSync(pdf);
  return { ok, pdf: existsSync(pdf) ? pdf : undefined, ...parsed, ms: Date.now() - t0, result, engine: engineFor(dirname(join(root, main)), basename(main)) };
}

/** Offline consistency checks over all .tex/.bib files (no compile needed). */
/** The files one document is made of: `main` and what it \input/\include/\subfile's (recursively), and the .bib
 *  files it names (\bibliography{a,b}, \addbibresource{x.bib}). Paths relative to `root`. */
export function documentFiles(root: string, main: string): { tex: string[]; bib: string[] } {
  const strip = (t: string) => t.replace(/(^|[^\\])%.*$/gm, "$1");
  const tex: string[] = [], bib = new Set<string>();
  const base = dirname(main);
  const visit = (rel: string) => {
    if (tex.includes(rel) || tex.length > 200) return;
    let t: string; try { t = strip(readFileSync(join(root, rel), "utf8")); } catch { return; }
    tex.push(rel);
    for (const m of t.matchAll(/\\(?:input|include|subfile|import\{[^}]*\})\{([^}]+)\}/g)) {
      const name = m[1].trim(), withExt = /\.tex$/.test(name) ? name : `${name}.tex`;
      for (const cand of [join(base, withExt), join(dirname(rel), withExt)]) if (existsSync(join(root, cand))) { visit(cand); break; }
    }
    for (const m of t.matchAll(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]+)\}/g))
      for (const b of m[1].split(",").map((x) => x.trim()).filter(Boolean)) { const f = join(base, /\.bib$/.test(b) ? b : `${b}.bib`); if (existsSync(join(root, f))) bib.add(f); }
  };
  visit(main);
  return { tex, bib: [...bib] };
}

export function checkReferences(root: string, main?: string): { missingCites: string[]; unusedBib: string[]; undefinedRefs: string[]; duplicateLabels: string[]; bibFiles: string[] } {
  // With a main document: only its own files (a folder holding v1, v2, v3 of a paper is not one document).
  const doc = main ? documentFiles(root, main) : undefined;
  const files = doc ? [...doc.tex, ...doc.bib] : texFiles(root);
  const tex = files.filter((f) => f.endsWith(".tex")).map((f) => readFileSync(join(root, f), "utf8").replace(/(^|[^\\])%.*$/gm, "$1"));
  const bibs = files.filter((f) => f.endsWith(".bib"));
  const bibKeys = new Set(bibs.flatMap((f) => [...readFileSync(join(root, f), "utf8").matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1])));
  const all = tex.join("\n");
  const cites = new Set([...all.matchAll(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g)].flatMap((m) => m[1].split(",").map((k) => k.trim())).filter((k) => k && k !== "*"));
  const labels = [...all.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);
  const refs = new Set([...all.matchAll(/\\(?:auto|c|C|eq|page|name)?ref\*?\{([^}]+)\}/g)].flatMap((m) => m[1].split(",").map((k) => k.trim())));
  const labelSet = new Set(labels);
  return {
    missingCites: bibs.length ? [...cites].filter((k) => !bibKeys.has(k)) : [],
    unusedBib: [...bibKeys].filter((k) => !cites.has(k)).slice(0, 30),
    undefinedRefs: [...refs].filter((r) => !labelSet.has(r)),
    duplicateLabels: [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))],
    bibFiles: bibs,
  };
}

export function renderLatexReport(r: LatexReport, root: string, main: string, ko: boolean, refs?: ReturnType<typeof checkReferences>): string {
  const lines: string[] = [];
  const url = r.pdf ? "file://" + encodeURI(r.pdf) : "";
  lines.push(r.ok
    ? (ko ? `✅ \`${main}\` 컴파일 성공 (${r.engine}, ${(r.ms / 1000).toFixed(1)}초) — [PDF 열기](${url})` : `✅ Compiled \`${main}\` (${r.engine}, ${(r.ms / 1000).toFixed(1)} s) — [open PDF](${url})`)
    : (ko ? `❌ \`${main}\` 컴파일 실패 (${r.engine}, ${(r.ms / 1000).toFixed(1)}초)` : `❌ \`${main}\` failed to compile (${r.engine}, ${(r.ms / 1000).toFixed(1)} s)`));
  if (r.result.timedOut) lines.push(ko ? "- 시간 초과" : "- timed out");
  for (const e of r.errors.slice(0, 5)) lines.push(`- ${e.file ? `\`${e.file}:${e.line}\` ` : ""}${e.message}`);
  if (r.undefinedCites.length) lines.push(`- ${ko ? "정의되지 않은 인용" : "Undefined citations"}: ${r.undefinedCites.slice(0, 8).map((k) => `\`${k}\``).join(", ")}`);
  if (r.undefinedRefs.length) lines.push(`- ${ko ? "정의되지 않은 참조" : "Undefined references"}: ${r.undefinedRefs.slice(0, 8).map((k) => `\`${k}\``).join(", ")}`);
  if (r.overfull) lines.push(`- Overfull hbox: ${r.overfull}`);
  if (refs) {
    if (refs.missingCites.length) lines.push(`- ${ko ? ".bib에 없는 인용 키" : "Cite keys missing from .bib"}: ${refs.missingCites.slice(0, 8).map((k) => `\`${k}\``).join(", ")}`);
    if (refs.duplicateLabels.length) lines.push(`- ${ko ? "중복 label" : "Duplicate labels"}: ${refs.duplicateLabels.map((k) => `\`${k}\``).join(", ")}`);
    if (refs.unusedBib.length) lines.push(`- ${ko ? "인용되지 않은 .bib 항목" : "Unused .bib entries"}: ${refs.unusedBib.length}`);
  }
  return lines.join("\n");
}

export const relToRoot = (root: string, p: string) => relative(root, p);

/** CSV/TSV → booktabs table (deterministic; AFM only suggests the caption if asked). */
export function csvToLatexTable(text: string, caption = "", label = "tab:data"): string {
  const rows = text.trim().split(/\r?\n/).map((l) => (l.includes("\t") ? l.split("\t") : l.split(",")).map((c) => c.trim().replace(/^"|"$/g, "")));
  const width = Math.max(...rows.map((r) => r.length));
  const esc = (c: string) => c.replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
  const numeric = (j: number) => rows.slice(1).every((r) => !r[j] || /^-?[\d.,]+%?$/.test(r[j]));
  const spec = Array.from({ length: width }, (_, j) => (numeric(j) ? "r" : "l")).join("");
  const line = (r: string[]) => Array.from({ length: width }, (_, j) => esc(r[j] ?? "")).join(" & ") + " \\\\";
  return ["\\begin{table}[t]", "  \\centering", ...(caption ? [`  \\caption{${esc(caption)}}`] : []), `  \\label{${label}}`, `  \\begin{tabular}{${spec}}`, "    \\toprule",
    `    ${line(rows[0])}`, "    \\midrule", ...rows.slice(1).map((r) => `    ${line(r)}`), "    \\bottomrule", "  \\end{tabular}", "\\end{table}", "% needs \\usepackage{booktabs}"].join("\n");
}

// ---- error fixes that do not need the model to retype text
const KNOWN_MACROS = ["textbf", "textit", "texttt", "textsc", "textrm", "textsf", "emph", "underline", "cite", "citep", "citet", "ref", "eqref", "autoref", "cref", "Cref", "label",
  "section", "subsection", "subsubsection", "paragraph", "caption", "includegraphics", "footnote", "url", "href", "item", "begin", "end", "frac", "mathbf", "mathrm", "mathcal",
  "left", "right", "cdot", "times", "alpha", "beta", "gamma", "delta", "lambda", "sigma", "sum", "prod", "int", "infty", "leq", "geq", "neq", "approx", "hline", "toprule",
  "midrule", "bottomrule", "multicolumn", "multirow", "centering", "small", "footnotesize", "large", "Large", "noindent", "vspace", "hspace", "newline", "linewidth", "textwidth"];

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** "Undefined control sequence" on a line: replace the unknown macro with the closest known one
 *  (standard commands plus macros the project defines or uses elsewhere). Deterministic. */
export function fixUndefinedMacro(root: string, lineText: string): { fixed: string; from: string; to: string } | undefined {
  const project = texFiles(root).filter((f) => f.endsWith(".tex")).map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const defined = [...project.matchAll(/\\(?:newcommand|renewcommand|DeclareMathOperator)\*?\{?\\([A-Za-z]+)/g)].map((m) => m[1]);
  const counts = new Map<string, number>();
  for (const m of project.matchAll(/\\([A-Za-z]+)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const known = new Set([...KNOWN_MACROS, ...defined, ...[...counts].filter(([, n]) => n >= 2).map(([k]) => k)]);
  for (const m of lineText.matchAll(/\\([A-Za-z]+)/g)) {
    const name = m[1];
    if (known.has(name)) continue;
    const best = [...known].map((k) => ({ k, d: editDistance(name, k) })).filter((x) => x.d <= 2 && x.d < name.length / 2).sort((a, b) => a.d - b.d);
    if (best.length && (best.length === 1 || best[0].d < best[1].d)) {
      return { fixed: lineText.replace(`\\${name}`, `\\${best[0].k}`), from: name, to: best[0].k };
    }
  }
  return undefined;
}

// ---- prose rewriting without letting the model touch markup
/** Replace LaTeX commands, math and comments with ⟦n⟧ placeholders so a model can rewrite only the prose. */
export function maskLatex(text: string): { masked: string; parts: string[] } {
  const parts: string[] = [];
  const keep = (m: string) => { parts.push(m); return `⟦${parts.length}⟧`; };
  const masked = text
    .replace(/%.*$/gm, keep)                                                     // comments
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, keep)   // math
    .replace(/\\(?:cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|label|url|href|includegraphics|input|include)\*?(?:\[[^\]]*\])*\{[^}]*\}(?:\{[^}]*\})?/g, keep)   // keys, paths
    .replace(/\\[A-Za-z]+\*?(?:\[[^\]]*\])?\{|\\[A-Za-z]+\*?|[{}~]/g, keep);   // other commands and braces (their arguments stay readable prose)
  return { masked, parts };
}

/** Put the markup back; undefined if any placeholder was dropped, duplicated or invented. */
export function unmaskLatex(rewritten: string, parts: string[]): string | undefined {
  const found = [...rewritten.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1]));
  if (found.length !== parts.length || new Set(found).size !== parts.length || found.some((n) => n < 1 || n > parts.length)) return undefined;
  // Spacing around markup follows the original: no space after an opening "\cmd{", and a space before a
  // citation/reference if the original had one (models often glue "points⟦5⟧").
  let out = rewritten.replace(/⟦(\d+)⟧\s*/g, (m, n) => (parts[Number(n) - 1].endsWith("{") ? `⟦${n}⟧` : m))
    .replace(/\s+⟦(\d+)⟧/g, (m, n) => (parts[Number(n) - 1] === "}" ? `⟦${n}⟧` : m));
  out = out.replace(/⟦(\d+)⟧/g, (_, n) => parts[Number(n) - 1]);
  return out.replace(/([A-Za-z0-9.,;:)])(\\(?:cite[a-zA-Z]*|ref|eqref|cref)\b)/g, "$1 $2");
}
