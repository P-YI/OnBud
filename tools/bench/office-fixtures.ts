// Synthetic xlsx and pptx files for tests and the benchmark (no third-party data): written as Office Open XML parts
// and zipped with /usr/bin/zip. The workbook has the layouts that flat readers get wrong: group heading rows (the
// heading in one column, the rest of the row empty, the rows below belonging to it), a vertically merged column,
// and string cells in sharedStrings. The deck's slide files are numbered out of presentation order and carry a
// table and speaker notes.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i: number) => String.fromCharCode(65 + i);

function zip(dest: string, parts: Record<string, string>) {
  const tmp = mkdtempSync(join(tmpdir(), "office-"));
  for (const [p, x] of Object.entries(parts)) { mkdirSync(dirname(join(tmp, p)), { recursive: true }); writeFileSync(join(tmp, p), x); }
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  execFileSync("/usr/bin/zip", ["-q", "-X", "-r", dest, "."], { cwd: tmp });
  rmSync(tmp, { recursive: true, force: true });
}

/** Sheets as rows of strings ("" = empty cell, left out of the XML as Excel does); merges like "A2:A4". */
export function writeXlsx(dest: string, sheets: { name: string; rows: string[][]; merges?: string[] }[]) {
  const shared: string[] = [];
  const sid = (s: string) => { let i = shared.indexOf(s); if (i < 0) { i = shared.length; shared.push(s); } return i; };
  const parts: Record<string, string> = {};
  sheets.forEach((sh, k) => {
    const rows = sh.rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => !v ? "" : /^-?\d+(\.\d+)?$/.test(v)
      ? `<c r="${col(j)}${i + 1}"><v>${v}</v></c>` : `<c r="${col(j)}${i + 1}" t="s"><v>${sid(v)}</v></c>`).join("")}</row>`).join("");
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    parts[`xl/worksheets/sheet${k + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges}</worksheet>`;
  });
  parts["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;
  parts["xl/workbook.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, k) => `<sheet name="${esc(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}</sheets></workbook>`;
  parts["xl/_rels/workbook.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  parts["_rels/.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  parts["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  zip(dest, parts);
}

export interface Slide { title: string; bullets?: string[]; table?: string[][]; notes?: string }
/** Slides in presentation order; file k+1 holds slide order[k] when `fileOrder` is given (to test reordering). */
export function writePptx(dest: string, slides: Slide[], fileOrder?: number[]) {
  const ns = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  // A run split in two ("Rev" + "enue") checks that runs in one paragraph are joined without a space.
  const para = (t: string) => `<a:p>${t.length > 6 ? `<a:r><a:t>${esc(t.slice(0, 3))}</a:t></a:r><a:r><a:t>${esc(t.slice(3))}</a:t></a:r>` : `<a:r><a:t>${esc(t)}</a:t></a:r>`}</a:p>`;
  const files = fileOrder ?? slides.map((_, i) => i);   // files[k] = index of the slide stored in slide{k+1}.xml
  const parts: Record<string, string> = {};
  const order: number[] = [];   // presentation order → file number
  files.forEach((si, k) => {
    const s = slides[si];
    order[si] = k + 1;
    const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>${para(s.title)}</p:txBody></p:sp>`;
    const body = s.bullets?.length ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${s.bullets.map(para).join("")}</p:txBody></p:sp>` : "";
    const table = s.table ? `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${s.table.map((r) => `<a:tr h="300">${r.map((c) => `<a:tc><a:txBody>${para(c)}</a:txBody></a:tc>`).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>` : "";
    parts[`ppt/slides/slide${k + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${ns}><p:cSld><p:spTree>${title}${body}${table}</p:spTree></p:cSld></p:sld>`;
    if (s.notes) {
      parts[`ppt/slides/_rels/slide${k + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${k + 1}.xml"/></Relationships>`;
      parts[`ppt/notesSlides/notesSlide${k + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${para(s.notes)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });
  parts["ppt/presentation.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${ns}><p:sldIdLst>${order.map((f, i) => `<p:sldId id="${256 + i}" r:id="rId${f}"/>`).join("")}</p:sldIdLst></p:presentation>`;
  parts["ppt/_rels/presentation.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${files.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${k + 1}.xml"/>`).join("")}</Relationships>`;
  parts["_rels/.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  parts["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${files.map((_, k) => `<Override PartName="/ppt/slides/slide${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`;
  zip(dest, parts);
}

/** The benchmark's parts price list: two group rows mention "bearing 6204" (steel and ceramic), one supplier makes
 *  only the ceramic one; a second sheet merges the team column vertically. */
export function partsWorkbook(dest: string) {
  const H = ["No", "구분", "그룹코드", "품목코드", "품명", "공급업체", "단가", "비고"];
  const g = (no: number, code: string, label: string) => [String(no), "기계", code, label, "", "", "", ""];
  const r = (no: number, code: string, item: string, name: string, sup: string, price: string) => [String(no), "기계", code, item, name, sup, price, ""];
  const rows = [H,
    g(1, "B6204S", "bearing 6204 (steel, 20x47mm)"),
    r(2, "B6204S", "880120011", "깊은홈볼베어링 6204ZZ_(강철)", "대한베어링(주)", "4200"),
    r(3, "B6204S", "880120012", "볼베어링6204-2RS_(강철)", "(주)세진정밀", "4350"),
    g(4, "B6204C", "bearing 6204 (ceramic, 20x47mm)"),
    r(5, "B6204C", "880120021", "세라믹베어링 6204_(지르코니아)", "대한베어링(주)", "18900"),
    r(6, "B6204C", "880120022", "하이브리드베어링6204_(세라믹볼)", "한빛모션(주)", "16500"),
    g(7, "H50C", "hydraulic cylinder 50mm bore"),
    r(8, "H50C", "770300101", "유압실린더 50x100_(복동)", "(주)동성유압", "212000"),
    r(9, "H50C", "770300102", "유압실린더 50x200_(복동)", "(주)동성유압", "238000"),
    g(10, "V12", "solenoid valve 12V DC"),
    r(11, "V12", "660100501", "솔레노이드밸브 12V_(2way)", "에이스밸브(주)", "31500"),
  ];
  const budget = [["부서", "항목", "금액(만원)"], ["연구개발팀", "시제품 제작", "1200"], ["", "시험 장비 임차", "450"], ["", "특허 출원", "300"], ["영업팀", "전시회 참가", "800"], ["", "홍보물 제작", "150"]];
  writeXlsx(dest, [{ name: "단가표", rows }, { name: "예산", rows: budget, merges: ["A2:A4", "A5:A6"] }]);
}

/** The benchmark's deck: four slides stored out of order (file 1 = slide 3 …), a revenue table, notes with a deadline. */
export function reviewDeck(dest: string) {
  writePptx(dest, [
    { title: "Q3 Product Review", bullets: ["Team Atlas", "October 2026"] },
    { title: "Revenue by quarter", table: [["Quarter", "Revenue (KRW M)", "Growth"], ["Q1", "410", "-"], ["Q2", "468", "14%"], ["Q3", "523", "12%"]] },
    { title: "Launch risks", bullets: ["Supplier delay on the sensor board", "Certification still pending"], notes: "Certification paperwork must be submitted by November 14." },
    { title: "Next steps", bullets: ["Freeze firmware 2.3", "Start pilot with two hospitals"] },
  ], [2, 0, 3, 1]);
}
