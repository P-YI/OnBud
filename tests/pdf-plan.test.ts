import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { pdfPlan, resolvePdfPlan, pageRanges } = await import("../services/controller/pdf-plan.ts");
const { convert, convertPlan, pdfPageEdit } = await import("../services/controller/mac-tasks.ts");
const { detectLocalSkill } = await import("../services/controller/local-skills.ts");

const IN = ["/x/a.pdf", "/x/b.pdf", "/x/c.pdf"], COUNTS = [5, 4, 6];
const show = (prompt: string, k = 2) => {
  const plan = pdfPlan(prompt, IN.slice(0, k));
  const r = resolvePdfPlan(plan, IN.slice(0, k), COUNTS);
  if (plan.unbound.length) return `? ${plan.unbound.join(",")}`;
  return "segments" in r ? r.segments.map((s) => `${"abc"[s.file]}[${pageRanges(s.pages)}]`).join(" ") : `! ${r.error}`;
};

test("pdf plan: order (named, list, relations, first/last, reverse, ordinals)", () => {
  assert.equal(show("a.pdf랑 b.pdf 합쳐줘"), "a[1–5] b[1–4]");
  assert.equal(show("b.pdf랑 a.pdf 순서로 합쳐줘"), "b[1–4] a[1–5]");
  assert.equal(show("b.pdf를 a.pdf 뒤에 붙여서 합쳐줘"), "a[1–5] b[1–4]");
  assert.equal(show("a.pdf 앞에 b.pdf를 넣어서 합쳐줘"), "b[1–4] a[1–5]");
  assert.equal(show("b.pdf를 먼저 오게 a.pdf랑 합쳐줘"), "b[1–4] a[1–5]");
  assert.equal(show("a.pdf, b.pdf, c.pdf 합쳐줘. c.pdf를 맨 앞으로", 3), "c[1–6] a[1–5] b[1–4]");
  assert.equal(show("Put b.pdf after c.pdf and merge a.pdf, b.pdf, c.pdf", 3), "a[1–5] c[1–6] b[1–4]");
  assert.equal(show("Combine a.pdf and b.pdf and make b.pdf come first"), "b[1–4] a[1–5]");
  assert.equal(show("Merge them with the second file first"), "b[1–4] a[1–5]");
  assert.equal(show("Combine the files in reverse order"), "b[1–4] a[1–5]");
  // two or more named: attached files not named stay out
  const p = pdfPlan("c.pdf와 a.pdf 합쳐줘", IN);
  assert.deepEqual([p.order, p.left], [[2, 0], [1]]);
});

test("pdf plan: pages left out or picked, bound to the right file", () => {
  assert.equal(show("a.pdf에서 3쪽 빼고 b.pdf랑 합쳐줘"), "a[1–2, 4–5] b[1–4]");
  assert.equal(show("a.pdf의 2쪽과 b.pdf의 3쪽을 빼고 합쳐줘"), "a[1, 3–5] b[1–2, 4]");
  assert.equal(show("a.pdf는 1~3쪽만, b.pdf는 마지막 페이지 빼고 합쳐줘"), "a[1–3] b[1–3]");
  assert.equal(show("a.pdf 1-3쪽이랑 b.pdf 합치고, b.pdf 2쪽은 빼줘"), "a[1–3] b[1, 3–4]");
  assert.equal(show("a.pdf 표지 빼고 b.pdf랑 합쳐줘"), "a[2–5] b[1–4]");
  assert.equal(show("a.pdf 3쪽부터 끝까지와 b.pdf 합쳐줘"), "a[3–5] b[1–4]");
  assert.equal(show("a.pdf 3페이지까지만 b.pdf랑 합쳐줘"), "a[1–3] b[1–4]");
  assert.equal(show("a.pdf 홀수 페이지만 b.pdf랑 합쳐줘"), "a[1, 3, 5] b[1–4]");
  assert.equal(show("a.pdf와 b.pdf를 합쳐줘, a.pdf 첫 장이랑 b.pdf 마지막 장 빼고"), "a[2–5] b[1–3]");
  assert.equal(show("Merge b.pdf and a.pdf, skipping page 2 of b.pdf"), "b[1, 3–4] a[1–5]");
  assert.equal(show("Combine a.pdf without page 3 and b.pdf"), "a[1–2, 4–5] b[1–4]");
  assert.equal(show("Merge a.pdf and b.pdf but drop the first page of b.pdf and the last 2 pages of a.pdf"), "a[1–3] b[2–4]");
  assert.equal(show("merge a.pdf (skip pages 2 and 4) with b.pdf"), "a[1, 3, 5] b[1–4]");
  assert.equal(show("Merge a.pdf and b.pdf, keep only pages 1 and 3 of b.pdf"), "a[1–5] b[1, 3]");
  // pages of the merged result
  assert.equal(show("a.pdf랑 b.pdf 합친 파일에서 3쪽 빼줘"), "a[1–2, 4–5] b[1–4]");
  assert.equal(show("Merge a.pdf and b.pdf, keep pages 1-2 of the merged pdf"), "a[1–2]");
  // no file to tie the page to: asked, never guessed
  assert.equal(show("a.pdf랑 b.pdf 합쳐줘. 2쪽은 빼고"), "? 2쪽");
  assert.equal(show("Merge a.pdf and b.pdf, skipping page 2"), "? page 2");
  // one PDF: that file; pages that do not exist or leave nothing are errors
  assert.equal(show("a.pdf에서 2, 4페이지 삭제해줘", 1), "a[1, 3, 5]");
  assert.equal(show("Remove pages 2-3 from a.pdf", 1), "a[1, 4–5]");
  assert.equal(show("a.pdf에서 9쪽 빼줘", 1), "! out_of_range");
  assert.equal(show("a.pdf에서 1-5쪽 빼줘", 1), "! empty");
});

test("pdf plan: inserting one file inside another", () => {
  assert.equal(show("b.pdf를 a.pdf 3쪽 뒤에 넣어줘"), "a[1–3] b[1–4] a[4–5]");
  assert.equal(show("Insert b.pdf after page 2 of a.pdf"), "a[1–2] b[1–4] a[3–5]");
  assert.equal(show("Insert b.pdf between pages 3 and 4 of a.pdf"), "a[1–3] b[1–4] a[4–5]");
  assert.equal(show("c.pdf 3쪽 다음에 a.pdf를 끼워 넣어줘", 3), "c[1–3] a[1–5] c[4–6]");
});

test("pdf pages: routing; questions about pages are not edits", () => {
  const one = [{ path: "a.pdf" }], two = [{ path: "a.pdf" }, { path: "b.pdf" }];
  for (const p of ["a.pdf에서 3쪽 빼줘", "Remove page 2 from a.pdf", "a.pdf 1~2쪽만 따로 저장해줘", "Extract pages 3-5 of a.pdf into a new pdf"]) {
    assert.equal(detectLocalSkill(p, one), "convert", p);
    assert.equal(convertPlan(p, ["/x/a.pdf"])?.op, "pdf_pages", p);
  }
  for (const p of ["a.pdf 3페이지 요약해줘", "What does page 2 of a.pdf say?", "a.pdf 2쪽 번역해줘", "a.pdf 몇 페이지야?"]) {
    assert.equal(pdfPageEdit(p), false, p);
    assert.notEqual(detectLocalSkill(p, one), "convert", p);
  }
  for (const p of ["b.pdf를 a.pdf 3쪽 뒤에 넣어줘", "Insert b.pdf after page 2 of a.pdf"]) {
    assert.equal(detectLocalSkill(p, two), "convert", p);
    assert.equal(convertPlan(p, ["/x/a.pdf", "/x/b.pdf"])?.op, "merge_pdf", p);
  }
  assert.equal(convertPlan("a.pdf랑 photo.jpg 합쳐줘", ["/x/a.pdf", "/x/photo.jpg"])?.op, "merge_pdf");
});

test("pdf pages: real files, every page checked; errors make no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdfp-"));
  const mk = (name: string, pages: number) => {
    const t = join(dir, `${name}.txt`);
    writeFileSync(t, Array.from({ length: pages }, (_, i) => `${name} page ${i + 1}`).join("\f"));
    writeFileSync(join(dir, `${name}.pdf`), execFileSync("/usr/sbin/cupsfilter", [t], { stdio: ["ignore", "pipe", "ignore"] }));
    rmSync(t);
  };
  mk("report", 5); mk("appendix", 4);
  const before = statSync(join(dir, "report.pdf")).mtimeMs;
  const go = (prompt: string, files: string[]) => convert({ root: dir, prompt, files: files.map((path) => ({ path })), ko: /[가-힣]/.test(prompt) });
  let r = await go("report.pdf에서 3쪽 빼고 appendix.pdf 앞에 붙여줘", ["appendix.pdf", "report.pdf"]);
  assert.equal(r.verified, true, r.answer);
  assert.match(r.detail, /report\.pdf\[1–2, 4–5\] \+ appendix\.pdf\[1–4\], 8\/8 pages/);
  assert.match(r.answer, /모든 페이지가 원본과 일치/);
  r = await go("Insert appendix.pdf after page 2 of report.pdf", ["report.pdf", "appendix.pdf"]);
  assert.match(r.detail, /report\.pdf\[1–2\] \+ appendix\.pdf\[1–4\] \+ report\.pdf\[3–5\], 9\/9 pages/);
  r = await go("report.pdf 짝수 페이지만 남겨줘", ["report.pdf"]);
  assert.match(r.detail, /pdf_pages: report\.pdf\[2, 4\], 2\/2 pages/);
  assert.ok(existsSync(join(dir, "report (pages).pdf")));
  const n = readdirSync(dir).length;
  for (const [p, f, d] of [["report.pdf에서 9쪽 빼줘", ["report.pdf"], "out_of_range"], ["report.pdf에서 1-5쪽 빼줘", ["report.pdf"], "empty"],
    ["report.pdf랑 appendix.pdf 합쳐줘. 2쪽은 빼고", ["report.pdf", "appendix.pdf"], "ambiguous_pages"]] as [string, string[], string][]) {
    r = await go(p, f);
    assert.equal(r.verified, false, p); assert.equal(r.detail, d, p);
  }
  assert.equal(readdirSync(dir).length, n);
  assert.equal(statSync(join(dir, "report.pdf")).mtimeMs, before);
  rmSync(dir, { recursive: true, force: true });
});
