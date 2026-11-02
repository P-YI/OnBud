// Spreadsheets as tables (2026-10-31): whole sheets, column-aligned, with group rows understood.
// Many public lists (drug price lists, catalogues, budgets) put a heading row above the rows it covers: the heading
// sits in one column and the rest of that row is empty ("doxepin hydrochloride (as doxepin 3mg)" above the products
// that contain it), or it is a horizontally merged cell. Reading such a sheet as flat text loses which rows belong
// to which heading, and a 20 000-character window loses most of the sheet. Here code reads every row, attaches each
// row to its group heading, and answers lookups exactly; the model only chooses columns.
//   xlsx  sheet XML + sharedStrings via /usr/bin/unzip (cell references keep empty cells in place; merges are applied)
//   csv / tsv  RFC 4180 quoting
import { readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname } from "node:path";

export interface Sheet {
  name: string;
  header: string[];
  headerRow: number;              // 0-based row index of the header in the sheet
  rows: { n: number; cells: string[]; group?: string }[];   // data rows (n = 1-based sheet row), group = heading above
  groups: number;                 // heading rows found
}
export interface Table { sheets: Sheet[] }

function unzip(args: string[]): Promise<string> {
  return new Promise((res) => execFile("/usr/bin/unzip", args, { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }, (_e, out) => res(String(out ?? ""))));
}
export const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
const colIndex = (ref: string) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "A") n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const rowIndex = (ref: string) => Number(/\d+$/.exec(ref)?.[0] ?? 1) - 1;
/** Text used for matching: Unicode NFC, lower case, runs of spaces as one. */
export const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

async function xlsxGrids(abs: string): Promise<{ name: string; grid: string[][]; merges: string[] }[]> {
  const list = (await unzip(["-Z1", abs])).split("\n");
  const shared = list.includes("xl/sharedStrings.xml")
    ? [...(await unzip(["-p", abs, "xl/sharedStrings.xml"])).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join("")))
    : [];
  // Sheet names and order from workbook.xml + its rels (sheetN.xml numbering need not follow the tab order).
  const wb = await unzip(["-p", abs, "xl/workbook.xml"]);
  const rels = await unzip(["-p", abs, "xl/_rels/workbook.xml.rels"]);
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const order = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: decodeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? ""), rid: /r:id="([^"]+)"/.exec(m[0])?.[1] }))
    .map((s) => ({ name: s.name, path: (target.get(s.rid) ?? "").replace(/^\/?(xl\/)?/, "xl/") }))
    .filter((s) => list.includes(s.path));
  const sheets = order.length ? order : list.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).map((p) => ({ name: p.replace(/^.*\/|\.xml$/g, ""), path: p }));
  const out = [];
  for (const s of sheets) {
    const xml = await unzip(["-p", abs, s.path]);
    const grid: string[][] = [];
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(/\br="(\d+)"/.exec(row[1])?.[1] ?? grid.length + 1) - 1;
      const cells: string[] = [];
      let next = 0;
      for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+\d+)"/.exec(c[1])?.[1];
        const i = ref ? colIndex(ref) : next;
        next = i + 1;
        const body = c[2] ?? "";
        const t = /\bt="(\w+)"/.exec(c[1])?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const val = t === "s" ? shared[Number(v)] ?? "" : t === "inlineStr" ? decodeXml([...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join("")) : decodeXml(v ?? "");
        cells[i] = val;
      }
      grid[r] = Array.from(cells, (x) => x ?? "");
    }
    out.push({ name: s.name, grid: Array.from(grid, (x) => x ?? []), merges: [...xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map((m) => `${m[1]}:${m[2]}`) });
  }
  return out;
}

function csvGrid(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell === "") q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const filled = (r: string[]) => r.filter((x) => x.trim()).length;
const numeric = (s: string) => /^[\s\d.,%()+\-/:]*$/.test(s);

/** Header = first row (of the first 15) whose cells are mostly filled, mostly text, and distinct. */
function findHeader(grid: string[][]): number {
  const width = Math.max(0, ...grid.slice(0, 50).map((r) => r.length));
  for (let i = 0; i < Math.min(15, grid.length); i++) {
    const r = grid[i] ?? [];
    const f = r.filter((x) => x.trim());
    if (f.length >= Math.max(2, width * 0.6) && f.filter((x) => !numeric(x)).length >= f.length * 0.8 && new Set(f).size === f.length) return i;
  }
  return 0;
}

/** Group heading rows: a row that fills at most half of the columns its following rows fill, with a text cell the
 *  data rows do not repeat, or a row spanned by a horizontal merge. Data rows inherit the latest heading. */
export function buildSheet(name: string, grid: string[][], merges: string[] = []): Sheet {
  const g = grid.map((r) => [...r]);
  const hMerged = new Set<number>();
  for (const m of merges) {
    const [a, b] = m.split(":");
    const r0 = rowIndex(a), r1 = rowIndex(b), c0 = colIndex(a), c1 = colIndex(b);
    const v = g[r0]?.[c0] ?? "";
    if (r1 > r0) for (let r = r0 + 1; r <= r1; r++) { (g[r] ??= [])[c0] = g[r][c0] || v; }   // vertical merge: fill down
    if (c1 > c0 && r1 === r0) hMerged.add(r0);
  }
  const h = findHeader(g);
  const header = (g[h] ?? []).map((x, i) => x.trim() || `col${i + 1}`);
  const rows: Sheet["rows"] = [];
  let group: string | undefined, groups = 0;
  for (let i = h + 1; i < g.length; i++) {
    const r = g[i] ?? [];
    const f = filled(r);
    if (!f) { group = undefined; continue; }
    const next = g.slice(i + 1, i + 4).find((x) => x && filled(x));
    const textCells = r.map((x, c) => ({ x: x.trim(), c })).filter((o) => o.x && !numeric(o.x));
    const label = textCells.sort((a, b) => b.x.length - a.x.length)[0];
    const isGroup = !!label && (hMerged.has(i) || (!!next && f <= header.length / 2 && filled(next) >= f + 2
      && label.x.length >= 3 && !g.slice(i + 1, i + 4).some((x) => (x?.[label.c] ?? "") === label.x)));
    if (isGroup) { group = label!.x.replace(/\s+/g, " "); groups++; continue; }
    rows.push({ n: i + 1, cells: header.map((_, c) => (r[c] ?? "").trim()), group });
  }
  return { name, header, headerRow: h, rows, groups };
}

const cache = new Map<string, { key: string; table: Table }>();
/** Whole table of an xlsx, csv or tsv file (cached by path, size and mtime). */
export async function readTable(abs: string): Promise<Table> {
  const st = statSync(abs);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(abs);
  if (hit?.key === key) return hit.table;
  const ext = extname(abs).toLowerCase();
  let table: Table;
  if (ext === ".xlsx" || ext === ".xlsm") table = { sheets: (await xlsxGrids(abs)).map((s) => buildSheet(s.name, s.grid, s.merges)) };
  else {
    const text = readFileSync(abs, "utf8").replace(/^﻿/, "");
    const sep = ext === ".tsv" || (!text.split("\n")[0].includes(",") && text.split("\n")[0].includes("\t")) ? "\t" : ",";
    table = { sheets: [buildSheet("sheet1", csvGrid(text, sep))] };
  }
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  cache.set(abs, { key, table });
  return table;
}

/** Flat text of a table for the document reader: sheet name, then "header: value" free rows, group headings kept. */
export function tableText(t: Table, maxChars: number): string {
  const out: string[] = [];
  let n = 0;
  for (const s of t.sheets) {
    out.push(`[${s.name}] ${s.rows.length} rows${s.groups ? `, ${s.groups} group headings` : ""}`, s.header.join("\t"));
    let last: string | undefined;
    for (const r of s.rows) {
      if (r.group !== last && r.group) out.push(`## ${r.group}`);
      last = r.group;
      out.push(r.cells.join("\t"));
      n += out[out.length - 1].length;
      if (n > maxChars) return out.join("\n");
    }
  }
  return out.join("\n");
}

export interface Match { sheet: string; row: Sheet["rows"][number]; via: "cell" | "group" }
/** Rows where a cell or the row's group heading contains the term (NFC, case and spacing ignored). */
export function lookup(t: Table, term: string): Match[] {
  const q = norm(term);
  if (!q) return [];
  const out: Match[] = [];
  for (const s of t.sheets) for (const r of s.rows) {
    if (r.group && norm(r.group).includes(q)) out.push({ sheet: s.name, row: r, via: "group" });
    else if (r.cells.some((c) => norm(c).includes(q))) out.push({ sheet: s.name, row: r, via: "cell" });
  }
  return out;
}

// Words that name the file or the question, not the thing looked up ("엑셀에서 … 알려줘" must not find "엑셀리바캡슐").
const STOP = /^(엑셀|파일|시트|스프레드시트|표|목록|문서|자료|데이터|엑셀파일|알려|알려줘|찾아|찾아줘|보여|보여줘|모두|전부|제품|제조|업체|회사|가격|금액|몇|개수|어떤|무슨|해당|관련|포함|정보|the|a|an|and|or|of|in|on|for|to|by|with|from|what|which|who|whom|where|when|how|many|much|list|show|tell|give|me|find|all|any|file|xlsx|csv|sheet|excel|table|row|rows|column|is|are|was|does|do|did|make|makes|made|maker|makers|company|companies|manufacturer|manufacturers|manufactures|supplier|suppliers|price|prices|product|products|item|items|that|this|these|those|please|there|count)$/i;

/** Request words that are not in the table at all: a Korean request's Latin words (4+ letters), which are names. */
export function missingNames(prompt: string, t: Table, skip: string[] = []): string[] {
  const skipN = skip.map(norm);
  return [...new Set(prompt.normalize("NFC").replace(/([A-Za-z0-9])([\uac00-\ud7a3])/g, "$1 $2").match(/[A-Za-z][A-Za-z0-9-]{3,}/g) ?? [])]
    .filter((w) => !STOP.test(w) && !skipN.some((h) => h.includes(norm(w))) && !lookup(t, w).length);
}

/** Search terms from the request that the table actually contains: Latin phrases, quoted text and Korean words
 *  (particles stripped by trying shorter prefixes), longest phrase first; each must match at least one row. */
export function candidateTerms(prompt: string, t: Table, skip: string[] = []): { term: string; hits: number }[] {
  // A Korean particle written straight after a Latin word ("hydrochloride를") is a word boundary.
  const p = prompt.normalize("NFC").replace(/([A-Za-z0-9)])([\uac00-\ud7a3])/g, "$1 $2");
  const skipN = skip.map(norm);
  const cands = new Set<string>();
  for (const m of p.matchAll(/["'“‘`]([^"'”’`]{2,80})["'”’`]/g)) cands.add(m[1].trim());
  const words = p.split(/[^\p{L}\p{N}.\-+/()%]+/u).filter(Boolean);
  for (let len = 4; len >= 1; len--) for (let i = 0; i + len <= words.length; i++) {
    const w = words.slice(i, i + len);
    if (w.every((x) => /^[A-Za-z0-9][A-Za-z0-9.\-+/()%]*$/.test(x)) && w.some((x) => /[A-Za-z]/.test(x))) cands.add(w.join(" "));
  }
  for (const w of words) if (/[가-힣]/.test(w)) for (let k = [...w].length; k >= 2; k--) cands.add([...w].slice(0, k).join(""));
  const out: { term: string; hits: number }[] = [];
  for (const c of [...cands].sort((a, b) => b.length - a.length)) {
    const n = norm(c);
    if ([...n].length < 2 || skipN.some((h) => h.startsWith(n)) || /^\d+$/.test(n) || out.some((o) => norm(o.term).includes(n))) continue;
    if (STOP.test(n)) continue;
    const hits = lookup(t, c).length;
    if (hits) out.push({ term: c, hits });
  }
  return out;
}
