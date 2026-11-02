import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { readTable, lookup, candidateTerms, buildSheet } = await import("../services/context-builder/sheets.ts");
const { readDocument } = await import("../services/context-builder/documents.ts");
const { partsWorkbook, reviewDeck } = await import("../tools/bench/office-fixtures.ts");
const { runLocalSkill, detectLocalSkill } = await import("../services/controller/local-skills.ts");
const { spacedPaths } = await import("../services/controller/controller.ts");

const dir = mkdtempSync(join(tmpdir(), "office-"));
partsWorkbook(join(dir, "parts.xlsx"));
reviewDeck(join(dir, "review.pptx"));

test("sheets: group heading rows are attached to the rows below them, merges fill down", async () => {
  const t = await readTable(join(dir, "parts.xlsx"));
  const s = t.sheets[0];
  assert.equal(s.name, "단가표");
  assert.equal(s.groups, 4);
  assert.equal(s.rows.length, 7);
  assert.equal(s.rows[0].group, "bearing 6204 (steel, 20x47mm)");
  assert.deepEqual(lookup(t, "bearing 6204").map((m) => m.row.cells[5]), ["대한베어링(주)", "(주)세진정밀", "대한베어링(주)", "한빛모션(주)"]);
  assert.deepEqual(t.sheets[1].rows.map((r) => r.cells[0]), ["연구개발팀", "연구개발팀", "연구개발팀", "영업팀", "영업팀"]);
});

test("sheets: empty cells keep their column (sparse XML), header-like rows found", () => {
  const s = buildSheet("x", [["a", "b", "c"], ["1", "", "z"], ["2", "y", ""]]);
  assert.deepEqual(s.rows.map((r) => r.cells), [["1", "", "z"], ["2", "y", ""]]);
});

test("sheets: request words found in the table, Latin phrase before a Korean particle", async () => {
  const t = await readTable(join(dir, "parts.xlsx"));
  assert.equal(candidateTerms("bearing 6204를 공급하는 업체를 알려줘", t, t.sheets[0].header)[0].term, "bearing 6204");
  assert.equal(candidateTerms("유압실린더 단가 알려줘", t, t.sheets[0].header)[0].term, "유압실린더");
});

test("sheet_lookup: all suppliers across both group rows, by group", async () => {
  const afm = { generate: async () => ({ ok: true, json: { columns: ["공급업체"] } }) } as any;
  const p = "parts.xlsx에서 bearing 6204를 만드는 회사를 모두 알려줘";
  assert.equal(detectLocalSkill(p, [{ path: "parts.xlsx" }]), "sheet_lookup");
  const r = await runLocalSkill("sheet_lookup", { afm, root: dir, prompt: p, files: [{ path: "parts.xlsx" }], ko: true });
  assert.match(r.answer, /공급업체\*\* \(중복 제외 3\): 대한베어링\(주\), \(주\)세진정밀, 한빛모션\(주\)/);
  assert.match(r.answer, /bearing 6204 \(ceramic, 20x47mm\): 대한베어링\(주\), 한빛모션\(주\)/);
});

test("sheet_lookup: a name in no row is reported as not found; no word at all declines", async () => {
  const afm = { generate: async () => ({ ok: false }) } as any;
  const r = await runLocalSkill("sheet_lookup", { afm, root: dir, prompt: "parts.xlsx 엑셀에서 turbine 공급처 알려줘", files: [{ path: "parts.xlsx" }], ko: true });
  assert.match(r.answer, /\*\*turbine\*\*을\(를\) 찾지 못했어요/);
  const r2 = await runLocalSkill("sheet_lookup", { afm, root: dir, prompt: "parts.xlsx: who supplies the gizmo?", files: [{ path: "parts.xlsx" }], ko: false });
  assert.equal(r2.declined, true);
});

test("sheet_lookup: 'how many' answers with the count, file-name words are not search terms", async () => {
  const afm = { generate: async () => { throw new Error("no AFM call expected"); } } as any;
  const r = await runLocalSkill("sheet_lookup", { afm, root: dir, prompt: "parts 엑셀에서 hydraulic cylinder 품목은 몇 개야?", files: [{ path: "parts.xlsx" }], ko: true });
  assert.match(r.answer, /^\*\*hydraulic cylinder\*\*: 2개 행/);
});

test("pptx: presentation order, titles, whole words across runs, table rows, notes", async () => {
  const d = await readDocument(dir, "review.pptx");
  const slides = d.text.split(/\n\n(?=\[slide )/);
  assert.equal(d.pages, 4);
  assert.match(slides[0], /# Q3 Product Review/);
  assert.match(slides[1], /\| Q2 \| 468 \| 14% \|/);
  assert.match(slides[1], /Revenue by quarter/);
  assert.match(slides[2], /\(notes\) Certification paperwork must be submitted by November 14\./);
  assert.match(slides[3], /# Next steps/);
});

test("spacedPaths: paths with spaces, Hangul, brackets and commas inside the root only", () => {
  const sub = join(dir, "자료 모음", "단가:2025");
  mkdirSync(sub, { recursive: true });
  partsWorkbook(join(sub, "부품 단가표_(2025.6.1.)(1,204)_공개용.xlsx"));
  assert.deepEqual(spacedPaths("자료 모음/단가:2025/부품 단가표_(2025.6.1.)(1,204)_공개용.xlsx 파일에서 bearing 업체 알려줘", dir), ["자료 모음/단가:2025/부품 단가표_(2025.6.1.)(1,204)_공개용.xlsx"]);
  assert.deepEqual(spacedPaths(`${sub}/부품 단가표_(2025.6.1.)(1,204)_공개용.xlsx의 업체`, dir), ["자료 모음/단가:2025/부품 단가표_(2025.6.1.)(1,204)_공개용.xlsx"]);
  assert.deepEqual(spacedPaths(`${sub}/부품 단가표_(2025.6.1.)(1,204)_공개용.xlsx`, sub + "/nope"), []);
});

test("slides_outline: titles in presentation order, the Nth slide's title or content", async () => {
  const afm = {} as any;
  const files = [{ path: "review.pptx" }];
  assert.equal(detectLocalSkill("review.pptx 슬라이드 제목을 순서대로 알려줘", files), "slides_outline");
  assert.equal(detectLocalSkill("review.pptx에서 2분기 매출은 얼마야?", files), undefined);
  const o = await runLocalSkill("slides_outline", { afm, root: dir, prompt: "슬라이드 제목을 순서대로 알려줘", files, ko: true });
  assert.match(o.answer, /1\. Q3 Product Review\n2\. Revenue by quarter · 표\n3\. Launch risks · 노트\n4\. Next steps/);
  const t = await runLocalSkill("slides_outline", { afm, root: dir, prompt: "3번째 슬라이드 제목이 뭐야?", files, ko: true });
  assert.equal(t.answer, "3번째 슬라이드 제목: **Launch risks**");
  const s3 = await runLocalSkill("slides_outline", { afm, root: dir, prompt: "What is on the third slide?", files, ko: false });
  assert.match(s3.answer, /Speaker notes: Certification paperwork must be submitted by November 14\./);
  const last = await runLocalSkill("slides_outline", { afm, root: dir, prompt: "마지막 슬라이드 내용 보여줘", files, ko: true });
  assert.match(last.answer, /4번째 슬라이드: Next steps/);
});
