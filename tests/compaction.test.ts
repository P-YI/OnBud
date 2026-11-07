import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ONBUD_HOME = mkdtempSync(join(tmpdir(), "onbud-home-"));
const { buildCheckpoint, isCompactionRequest, TEMPLATE_HEADINGS } = await import("../services/controller/compaction.ts");
const { namedDocuments } = await import("../services/controller/controller.ts");
const { makeRepo } = await import("./helpers.ts");

// What OpenCode 2.2.3 sends and how it validates (copied from its compaction step).
const OPENCODE_PROMPT = "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.\nSummarize only what the user and the assistant said and did.\nYou MUST use this format for your response\n<template>\n## Objective\n- [..]\n## Important Context\n- [..]\n</template>";
const openCodeAccepts = (text: string) => text.split("\n").some((l) => TEMPLATE_HEADINGS.includes(l.trim()));

test("compaction requests are recognised, normal questions are not", () => {
  assert.ok(isCompactionRequest(OPENCODE_PROMPT));
  assert.ok(isCompactionRequest("Update the existing checkpoint in the conversation above into one consolidated summary."));
  assert.ok(isCompactionRequest("The previous response did not fill in the required summary template. Do not call tools."));
  assert.ok(!isCompactionRequest("Award Letter 문서에서 편지를 발송한 주체가 누구인지 알려줘"));
});

test("checkpoint follows the template, keeps the open question, files and earlier answers", () => {
  const turns = [
    { role: "user" as const, text: "현재 디렉토리 내의 문서들이 각각 어떤 문서인지 짧게 요약과 함께 설명해줘." },
    { role: "assistant" as const, text: "현재 폴더의 파일 11개\n* Workshop Award Letter.pdf — 편지\n* conf2026_final.pdf — 논문\n\n— AFM controller · LOCAL_AFM · local_document_overview · 4.6s" },
    { role: "user" as const, text: "Award Letter 문서에서 편지를 발송한 주체가 누구인지 이름을 확인해서 알려줘." },
  ];
  const root = makeRepo({ "Workshop Award Letter.pdf": "x", "conf2026_final.pdf": "x" });
  const cp = buildCheckpoint(turns, { root });
  assert.ok(openCodeAccepts(cp));
  for (const h of ["## Objective", "## Work State", "### Active", "## Relevant Files", "## Important Context"]) assert.ok(cp.includes(h), h);
  assert.match(cp, /### Active\n- Award Letter 문서에서 편지를/);
  assert.match(cp, /`Workshop Award Letter\.pdf`/);
  assert.match(cp, /이전 답: 현재 폴더의 파일 11개/);
  assert.doesNotMatch(cp, /AFM controller · LOCAL_AFM/);
  // a second compaction keeps facts from the first checkpoint
  const again = buildCheckpoint([{ role: "user", text: "고마워" }], { previous: cp });
  assert.match(again, /이전 답: 현재 폴더의 파일 11개/);
});

test("documents named loosely are found; ties are left to AFM", () => {
  const root = makeRepo({ "Workshop Award Letter.pdf": "x", "Thesis.pdf": "x", "Thesis.pptx": "x", "ProjectQA_final.doc": "x", "ProjectQA_draft.doc": "x" });
  assert.deepEqual(namedDocuments("Award Letter 문서에서 편지를 보낸 사람은?", root), [{ path: "Workshop Award Letter.pdf" }]);
  assert.deepEqual(namedDocuments("Thesis 발표 슬라이드 몇 쪽?", root), [{ path: "Thesis.pptx" }]);
  assert.deepEqual(namedDocuments("ProjectQA 원고 요약해줘", root), []);
});

test("letter structure: signer after the closing, not the person the letter is about", async () => {
  const { letterFacts } = await import("../services/context-builder/documents.ts");
  const f = letterFacts("NeurIPS 2026\nTo Whom It May Concern,\nThis letter is to certify that Alex Kim served as a reviewer.\nSincerely,\nJordan Lee\nProgram Chairs, NeurIPS 2026")!;
  assert.match(f, /sender \(signed after "Sincerely,"\): Jordan Lee, Program Chairs, NeurIPS 2026/);
  assert.match(f, /addressed to: To Whom It May Concern/);
  assert.match(letterFacts("홍길동 귀하\n추천합니다.\n김철수 드림")!, /sender .*: 김철수/);
  assert.equal(letterFacts("def f():\n    return 1"), undefined);
});

test("checkpoint file list: bold names with spaces, no fragments", async () => {
  const { buildCheckpoint } = await import("../services/controller/compaction.ts");
  const cp = buildCheckpoint([{ role: "user", text: "요약" }, { role: "assistant", text: "- **Master's Thesis.pptx** — 발표\n- **Workshop Award Letter.pdf** — 편지\nBatch Inference vllm_search_agent_inference.py 기반" }]);
  const filesPart = cp.split("## Relevant Files")[1].split("## Important Context")[0];
  assert.match(filesPart, /`Master's Thesis\.pptx`/);
  assert.match(filesPart, /`Workshop Award Letter\.pdf`/);
  assert.match(filesPart, /`vllm_search_agent_inference\.py`/);
  assert.doesNotMatch(filesPart, /`s Thesis|`\.pptx`|`Thesis\.pptx`|Batch Inference/);
});

test("LaTeX masking: prose is editable, markup round-trips, lost placeholders are refused", async () => {
  const { maskLatex, unmaskLatex, fixUndefinedMacro, parseLatexLog, csvToLatexTable, checkReferences } = await import("../services/context-builder/latex.ts");
  const src = "Models store \\textbf{time-specific} facts \\cite{a,b} ($x^2$) in Table~\\ref{tab:x}. % note";
  const { masked, parts } = maskLatex(src);
  assert.ok(!masked.includes("\\cite") && !masked.includes("$") && masked.includes("time-specific"));
  assert.equal(unmaskLatex(masked, parts), src);
  const glued = masked.replace(/time-specific/, " temporal").replace(/facts ⟦(\d+)⟧/, "data⟦$1⟧");
  assert.match(unmaskLatex(glued, parts)!, /\\textbf\{temporal\} data \\cite\{a,b\}/);
  assert.equal(unmaskLatex(masked.replace("⟦2⟧", ""), parts), undefined);
  const root = makeRepo({ "main.tex": "\\documentclass{article}\\begin{document}\\textbf{a} \\textbff{b}\\end{document}", "refs.bib": "@misc{k1, title={x}}\n@misc{k2, title={y}}" });
  assert.equal(fixUndefinedMacro(root, "Language \\textbff{b}")!.to, "textbf");
  const log = "./sections/intro.tex:2: Undefined control sequence.\nLaTeX Warning: Citation `k9' on page 1 undefined on input line 3.\nOverfull \\hbox (1pt too wide)";
  const p = parseLatexLog(log);
  assert.deepEqual(p.errors[0], { file: "sections/intro.tex", line: 2, message: "Undefined control sequence." });
  assert.deepEqual(p.undefinedCites, ["k9"]);
  assert.equal(p.overfull, 1);
  assert.match(csvToLatexTable("m,acc\nAFM,72.5"), /\\begin\{tabular\}\{lr\}[\s\S]*AFM & 72\.5/);
  writeFileSync(join(root, "sec.tex"), "\\cite{k1,k3} \\ref{fig:a} \\label{s}\\label{s}");
  const r = checkReferences(root);
  assert.deepEqual([r.missingCites, r.unusedBib, r.undefinedRefs, r.duplicateLabels], [["k3"], ["k2"], ["fig:a"], ["s"]]);
});
