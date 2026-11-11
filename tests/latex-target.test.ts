// LaTeX target (2026-11-11): a .tex named by path is the one compiled, even outside the open folder, and the
// reference check covers that document's own files only (a folder with several versions of a paper is not one
// document). Before, Spotlight (root ~/Desktop) compiled another project's main.tex for an absolute path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReferences, documentFiles, namedTexPath } from "../services/context-builder/latex.ts";

const home = mkdtempSync(join(tmpdir(), "onbud-tex-"));
const dir = join(home, "Downloads", "project", "proposal");
mkdirSync(join(dir, "sections"), { recursive: true });
const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
writeFileSync(join(dir, "proposal_v3.tex"), doc("\\section{A}\\label{sec:a}\\cite{old}"));
writeFileSync(join(dir, "proposal_v4.tex"), doc("\\input{sections/intro}\n\\section{A}\\label{sec:a} See \\ref{sec:intro}. \\cite{knuth}\n\\bibliography{refs}"));
writeFileSync(join(dir, "sections", "intro.tex"), "\\section{Intro}\\label{sec:intro} % \\label{sec:a}\n\\cite{lamport}");
writeFileSync(join(dir, "refs.bib"), "@book{knuth, title={T}}\n@book{lamport, title={L}}\n@book{unused, title={U}}\n");

test("namedTexPath: absolute and ~/ paths inside home; missing files and paths outside home are reported", () => {
  const abs = join(dir, "proposal_v4.tex");
  assert.deepEqual(namedTexPath(`Please compile the tex file into pdf in the following directory: ${abs}`, home), { abs });
  assert.deepEqual(namedTexPath("~/Downloads/project/proposal/proposal_v4.tex 컴파일해줘", home), { abs });
  assert.deepEqual(namedTexPath("compile ~/Downloads/project/proposal/nope.tex", home), { missing: "~/Downloads/project/proposal/nope.tex" });
  assert.ok("missing" in namedTexPath("compile /etc/x.tex", home)!);
  assert.equal(namedTexPath("compile main.tex", home), undefined);
});

test("documentFiles and checkReferences: only the document's own files", () => {
  const d = documentFiles(dir, "proposal_v4.tex");
  assert.deepEqual(d.tex.sort(), ["proposal_v4.tex", "sections/intro.tex"]);
  assert.deepEqual(d.bib, ["refs.bib"]);
  const r = checkReferences(dir, "proposal_v4.tex");
  assert.deepEqual(r.duplicateLabels, []);          // v3's sec:a and a commented-out label are not this document
  assert.deepEqual(r.missingCites, []);              // "old" is cited only in v3
  assert.deepEqual(r.undefinedRefs, []);
  assert.deepEqual(r.unusedBib, ["unused"]);
  assert.deepEqual(checkReferences(dir).duplicateLabels, ["sec:a"]);   // the whole folder (no main) still sees both
});
