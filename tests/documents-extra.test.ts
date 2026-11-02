import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.OPENAFM_HOME = mkdtempSync(join(tmpdir(), "openafm-home-"));
const realPdftext = join(homedir(), "OpenAFM", "runtime", "bin", "pdftext");
if (existsSync(realPdftext)) {
  mkdirSync(join(process.env.OPENAFM_HOME, "runtime", "bin"), { recursive: true });
  symlinkSync(realPdftext, join(process.env.OPENAFM_HOME, "runtime", "bin", "pdftext"));
}
const { readDocument, findPdfPages } = await import("../services/context-builder/documents.ts");

const root = mkdtempSync(join(tmpdir(), "afm-docs-"));
/** Build a zip container from {path: xml} (xlsx, hwpx and epub are all zips of XML). */
function zipOf(name: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "afm-zip-"));
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
  execFileSync("/usr/bin/zip", ["-qr", join(root, name), ...Object.keys(files)], { cwd: dir });
}

test("xlsx: rows with shared strings and numbers, as tab-separated text", async () => {
  zipOf("budget.xlsx", {
    "xl/sharedStrings.xml": `<sst><si><t>item</t></si><si><t>cost</t></si><si><t>GPU</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200.5</v></c></row></sheetData></worksheet>`,
  });
  const d = await readDocument(root, "budget.xlsx", { withMetadata: false });
  assert.equal(d.method, "xlsx-xml");
  assert.match(d.text, /item\tcost\nGPU\t1200\.5/);
});

test("hwpx and epub: text from their XML parts", async () => {
  zipOf("report.hwpx", { "Contents/section0.xml": `<hs:sec><hp:p><hp:run><hp:t>한글 보고서 본문</hp:t></hp:run></hp:p></hs:sec>`, "mimetype": "application/hwp+zip" });
  const h = await readDocument(root, "report.hwpx", { withMetadata: false });
  assert.equal(h.method, "hwpx-xml");
  assert.match(h.text, /한글 보고서 본문/);
  zipOf("book.epub", { "OEBPS/ch1.xhtml": `<html><body><h1>Chapter 1</h1><p>Attention heads &amp; time.</p></body></html>` });
  const e = await readDocument(root, "book.epub", { withMetadata: false });
  assert.match(e.text, /Chapter 1[\s\S]*Attention heads & time\./);
});

test("ipynb: cells instead of raw JSON", async () => {
  writeFileSync(join(root, "nb.ipynb"), JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# Train\n"] }, { cell_type: "code", source: ["model.fit(x)\n"], outputs: [{ data: { "image/png": "A".repeat(5000) } }] }] }));
  const d = await readDocument(root, "nb.ipynb", { withMetadata: false });
  assert.equal(d.method, "ipynb");
  assert.match(d.text, /\[markdown\]\n# Train[\s\S]*\[code\]\nmodel\.fit\(x\)/);
  assert.ok(!d.text.includes("AAAA"));
});

test("images are OCR'd on-device; PDFs can be searched by page", { skip: !existsSync(realPdftext) }, async () => {
  const txt = join(root, "note.txt");
  writeFileSync(txt, "OpenAFM receipt 2026\nTotal 42\n");
  execFileSync("/usr/bin/qlmanage", ["-t", "-s", "800", "-o", root, txt], { stdio: "ignore" });
  const img = await readDocument(root, "note.txt.png", { withMetadata: false });
  assert.equal(img.method, "ocr");
  assert.match(img.text, /receipt 2026/i);
  execFileSync("/usr/bin/sips", ["-s", "format", "pdf", join(root, "note.txt.png"), "--out", join(root, "scan.pdf")], { stdio: "ignore" });
  const f = await findPdfPages(join(root, "scan.pdf"), ["receipt"]);
  assert.equal(f.pages, 1);
  assert.equal(f.hits.length, 0);   // a scan has no text layer: --find does not OCR (too slow), reading does
  const p = await readDocument(root, "scan.pdf", { withMetadata: false, pages: [1] });
  assert.equal(p.method, "pdftext+ocr");
  assert.match(p.text, /\[page 1\][\s\S]*receipt/i);
});
