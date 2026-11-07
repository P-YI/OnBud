// Read text out of documents, on-device only (no network; every helper ships with macOS or is built here):
//   pdf                      → runtime/bin/pdftext (PDFKit; Vision OCR for scanned pages; --find for page search)
//   images                   → runtime/bin/pdftext --image (Vision OCR, ko/en)
//   doc docx rtf rtfd odt html webarchive → /usr/bin/textutil
//   pptx                     → slide XML via /usr/bin/unzip: presentation order, titles, paragraphs, tables, notes
//   xlsx                     → sheets.ts: every sheet, column-aligned rows, group heading rows kept
//   hwpx / epub              → section / chapter XML via unzip
//   ipynb                    → markdown and code cells
//   key pages numbers ppt xls and anything else Spotlight can index → `mdimport -t -d3` (kMDItemTextContent)
//   text / code              → read directly
// plus Spotlight metadata (kind, pages, authors, title) from /usr/bin/mdls.
// Results are cached in SQLite by path+size+mtime, so slow OCR only happens once per file version.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gatePath, redact } from "../security/gate.ts";
import { decodeXml, readTable, tableText } from "./sheets.ts";
import { now } from "../telemetry/db.ts";

export type DocKind = "pdf" | "word" | "slides" | "sheet" | "text" | "code" | "image" | "other";

export interface DocInfo {
  path: string;
  kind: DocKind;
  bytes: number;
  modified: string;          // ISO date
  pages?: number;
  title?: string;
  authors?: string[];
  spotlightKind?: string;
  text: string;              // redacted, capped
  truncated: boolean;
  method: string;            // pdftext | pdftext+ocr | ocr | textutil | pptx-xml | xlsx-xml | hwpx-xml | epub-xml | ipynb | spotlight | read | metadata-only
  error?: string;
}

const CODE = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".swift", ".rb", ".sh", ".sql", ".r", ".m", ".ipynb"]);
const TEXT = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".tex", ".bib", ".log", ".xml"]);
const WORD = new Set([".doc", ".docx", ".rtf", ".rtfd", ".odt", ".html", ".htm", ".webarchive", ".pages", ".hwpx", ".hwp", ".epub", ".eml"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".heic", ".gif", ".tiff", ".bmp", ".webp"]);

export function kindOf(path: string): DocKind {
  const e = extname(path).toLowerCase();
  if (e === ".pdf") return "pdf";
  if (WORD.has(e)) return "word";
  if (e === ".pptx" || e === ".key" || e === ".ppt") return "slides";
  if (e === ".xlsx" || e === ".numbers" || e === ".xls") return "sheet";
  if (CODE.has(e)) return "code";
  if (TEXT.has(e)) return "text";
  if (IMAGE.has(e)) return "image";
  return "other";
}

const PDFTEXT = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "bin", "pdftext");
// The launcher installs a prebuilt pdftext (Settings > Backend); without it, it is built here from
// tools/pdftext/main.swift on first use (Command Line Tools come with Homebrew), once per process.
let pdftextBuild: Promise<boolean> | undefined;
export const PDFTEXT_MISSING = "pdftext_unavailable";
async function ensurePdftext(): Promise<boolean> {
  if (existsSync(PDFTEXT)) return true;
  pdftextBuild ??= (async () => {
    const src = new URL("../../tools/pdftext/main.swift", import.meta.url).pathname;
    if (!existsSync(src) || !existsSync("/usr/bin/swiftc")) return false;
    mkdirSync(dirname(PDFTEXT), { recursive: true });
    const r = await run("/usr/bin/swiftc", ["-O", "-o", PDFTEXT, src, "-framework", "PDFKit", "-framework", "Vision", "-framework", "AppKit"], 300_000);
    return r.code === 0 && existsSync(PDFTEXT);
  })();
  return pdftextBuild;
}

function run(cmd: string, args: string[], timeoutMs = 30_000, maxBuffer = 8 * 1024 * 1024): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } },
      (err: any, stdout) => res({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: String(stdout ?? "") }));
    child.stdin?.end();
  });
}

const xmlText = (xml: string) =>
  [...xml.matchAll(/<a:t>([^<]*)<\/a:t>|<t[^>]*>([^<]*)<\/t>/g)].map((m) => (m[1] ?? m[2]))
    .join(" ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export interface ReadOptions { maxChars?: number; pdfPages?: number; pages?: number[]; db?: DatabaseSync; withMetadata?: boolean }

const unescapeMd = (s: string) =>
  s.replace(/\\U([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\").normalize("NFC");

/** Text that Spotlight's own importer extracts (iWork, legacy Office, …), without touching the index. */
export async function spotlightText(abs: string): Promise<string> {
  const r = await run("/usr/bin/mdimport", ["-t", "-d3", abs], 15_000);
  const m = /kMDItemTextContent = "((?:[^"\\]|\\.)*)"/.exec(r.out);
  return m ? unescapeMd(m[1]) : "";
}

/** Pages of a PDF ranked by how many of the terms they contain (text layer only). */
export async function findPdfPages(abs: string, terms: string[]): Promise<{ pages: number; hits: { page: number; count: number; terms: number }[] }> {
  const q = terms.map((t) => t.replace(/\|/g, " ").trim()).filter((t) => t.length >= 2).join("|");
  if (!q || !(await ensurePdftext())) return { pages: 0, hits: [] };
  try { const j = JSON.parse((await run(PDFTEXT, ["--find", abs, q], 30_000)).out || "{}"); return { pages: j.pages ?? 0, hits: j.hits ?? [] }; }
  catch { return { pages: 0, hits: [] }; }
}

const stripTags = (x: string) => x.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ");

const byNumber = (re: RegExp) => (a: string, b: string) => Number(re.exec(a)?.[1] ?? 0) - Number(re.exec(b)?.[1] ?? 0);

/** pptx → slides in presentation order (presentation.xml, not file numbering): title, one line per paragraph
 *  (runs joined without spaces, so words split across runs stay whole), tables as "a | b" rows, speaker notes. */
async function pptxText(abs: string, maxChars: number): Promise<{ text: string; slides: number }> {
  const list = (await run("/usr/bin/unzip", ["-Z1", abs])).out.split("\n");
  const relsOf = async (xmlPath: string) => {
    const r = xmlPath.replace(/([^/]+)$/, "_rels/$1.rels");
    if (!list.includes(r)) return new Map<string, string>();
    const base = xmlPath.replace(/[^/]+$/, "");
    return new Map([...(await run("/usr/bin/unzip", ["-p", abs, r])).out.matchAll(/<Relationship\b[^>]*>/g)]
      .map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? "", resolve("/" + base, /Target="([^"]+)"/.exec(m[0])?.[1] ?? "").slice(1)]));
  };
  const pres = await relsOf("ppt/presentation.xml");
  const ids = [...(await run("/usr/bin/unzip", ["-p", abs, "ppt/presentation.xml"])).out.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => pres.get(m[1]) ?? "");
  const slides = ids.filter((x) => list.includes(x));
  const order = slides.length ? slides : list.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber(/slide(\d+)\.xml$/));
  const paras = (xml: string) => [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
    .map((p) => decodeXml([...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join("")).trim()).filter(Boolean);
  const out: string[] = [];
  for (const [i, sl] of order.entries()) {
    const xml = (await run("/usr/bin/unzip", ["-p", abs, sl])).out;
    const lines: string[] = [];
    for (const sh of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)) {
      const x = sh[0];
      if (x.includes("<a:tbl>")) {
        for (const tr of x.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) lines.push("| " + [...tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) => paras(tc[0]).join(" ")).join(" | ") + " |");
        continue;
      }
      if (/<p:ph\b[^>]*type="sldNum"/.test(x)) continue;
      const t = paras(x);
      if (!t.length) continue;
      if (/<p:ph\b[^>]*type="(title|ctrTitle)"/.test(x)) lines.push(`# ${t.join(" ")}`);
      else lines.push(...t);
    }
    const notes = [...(await relsOf(sl)).values()].find((v) => /notesSlides\/notesSlide\d+\.xml$/.test(v));
    if (notes && list.includes(notes)) {
      const nx = (await run("/usr/bin/unzip", ["-p", abs, notes])).out;
      const nt = [...nx.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].filter((m) => !/type="(sldNum|sldImg)"/.test(m[0])).flatMap((m) => paras(m[0]));
      if (nt.length) lines.push(`(notes) ${nt.join(" ")}`);
    }
    if (lines.length) out.push(`[slide ${i + 1}]\n${lines.join("\n")}`);
    if (out.join("\n").length > maxChars) break;
  }
  return { text: out.join("\n\n"), slides: order.length };
}

/** Zip-of-XML formats: hwpx (Contents/section*.xml) and epub (xhtml chapters in archive order). */
async function zippedXml(abs: string, pick: RegExp, maxChars: number, order?: (a: string, b: string) => number): Promise<string> {
  let names = (await run("/usr/bin/unzip", ["-Z1", abs])).out.split("\n").filter((n) => pick.test(n));
  if (order) names = names.sort(order);
  const parts: string[] = [];
  for (const n of names) {
    parts.push(stripTags((await run("/usr/bin/unzip", ["-p", abs, n])).out).replace(/\n\s*\n+/g, "\n").trim());
    if (parts.join("\n").length > maxChars) break;
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Spotlight metadata for several files in one mdls call each (mdls is fast and already indexed). */
export async function spotlightMeta(abs: string): Promise<Pick<DocInfo, "pages" | "title" | "authors" | "spotlightKind">> {
  const r = await run("/usr/bin/mdls", ["-name", "kMDItemNumberOfPages", "-name", "kMDItemTitle", "-name", "kMDItemAuthors", "-name", "kMDItemKind", abs], 4000);
  const get = (k: string) => new RegExp(`${k}\\s*=\\s*(\\([\\s\\S]*?\\)|[^\\n]*)`).exec(r.out)?.[1]?.trim();
  const unq = (s?: string) => (s && s !== "(null)" ? s.replace(/^"|"$/g, "") : undefined);
  const decode = (s: string) => s.replace(/\\U([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).normalize("NFC");
  const authorsRaw = get("kMDItemAuthors");
  const authors = authorsRaw && authorsRaw !== "(null)"
    ? [...authorsRaw.matchAll(/"([^"]*)"|^\s*([^\s(),"][^,\n]*)$/gm)].map((m) => decode((m[1] ?? m[2] ?? "").trim())).filter(Boolean)
    : undefined;
  const pages = Number(unq(get("kMDItemNumberOfPages")));
  return {
    pages: Number.isFinite(pages) && pages > 0 ? pages : undefined,
    title: unq(get("kMDItemTitle")) ? decode(unq(get("kMDItemTitle"))!) : undefined,
    authors: authors?.length ? authors : undefined,
    spotlightKind: unq(get("kMDItemKind")) ? decode(unq(get("kMDItemKind"))!) : undefined,
  };
}

export async function readDocument(root: string, rel: string, opts: ReadOptions = {}): Promise<DocInfo> {
  const maxChars = opts.maxChars ?? 6000;
  const abs = resolve(root, rel);
  const kind = kindOf(rel);
  const base = { path: rel, kind, bytes: 0, modified: "", text: "", truncated: false, method: "metadata-only" } as DocInfo;
  const g = gatePath(rel, root, "read");
  if (g.verdict !== "allow") return { ...base, error: `blocked:${g.reasons.join(",")}` };
  if (!existsSync(abs)) return { ...base, error: "not_found" };
  const st = statSync(abs);
  base.bytes = st.size;
  base.modified = st.mtime.toISOString().slice(0, 10);

  const key = `${abs}|${st.size}|${Math.floor(st.mtimeMs)}|${maxChars}|${opts.pdfPages ?? 2}|${opts.pages?.join(",") ?? ""}`;
  if (opts.db) {
    try {
      const hit = opts.db.prepare("SELECT json FROM doc_cache WHERE key=?").get(key) as any;
      if (hit) return JSON.parse(hit.json);
    } catch { /* cache is optional */ }
  }

  let info: DocInfo = { ...base };
  const ext = extname(rel).toLowerCase();
  if (opts.withMetadata !== false) Object.assign(info, await spotlightMeta(abs));
  try {
    if (kind === "pdf") {
      if (!(await ensurePdftext())) info.error = PDFTEXT_MISSING;
      else {
        const r = await run(PDFTEXT, [abs, String(opts.pdfPages ?? 2), String(maxChars), ...(opts.pages?.length ? [opts.pages.join(",")] : [])], 60_000);
        const j = JSON.parse(r.out || "{}");
        if (j.error) info.error = j.error;
        info.text = j.text ?? "";
        info.pages = j.pages ?? info.pages;
        info.title = info.title || j.title || undefined;
        info.truncated = !!j.truncated;
        info.method = j.ocr_pages ? "pdftext+ocr" : "pdftext";
      }
    } else if (kind === "image") {
      if (!(await ensurePdftext())) info.error = PDFTEXT_MISSING;
      else if (st.size > 30 * 1024 * 1024) info.error = "file_too_large";
      else { const j = JSON.parse((await run(PDFTEXT, ["--image", abs], 60_000)).out || "{}"); info.text = j.text ?? ""; info.method = "ocr"; if (j.error) info.error = j.error; }
    } else if (ext === ".hwpx") {
      info.text = await zippedXml(abs, /^Contents\/section\d+\.xml$/, maxChars, byNumber(/section(\d+)\.xml$/)); info.method = "hwpx-xml";
    } else if (ext === ".epub") {
      info.text = await zippedXml(abs, /\.x?html?$/i, maxChars); info.method = "epub-xml";
    } else if (ext === ".eml") {
      info.text = st.size <= 4 * 1024 * 1024 ? readFileSync(abs, "utf8").replace(/^Content-Transfer-Encoding: base64[\s\S]*?(?=\n--)/gim, "[attachment]") : ""; info.method = "read";
    } else if (kind === "word" && ext !== ".pages" && ext !== ".hwp") {
      const r = await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", abs], 30_000);
      info.text = r.out; info.method = "textutil";
    } else if (ext === ".pptx") {
      const x = await pptxText(abs, maxChars);
      info.text = x.text; info.pages = x.slides; info.method = "pptx-xml";
    } else if (ext === ".xlsx") {
      // Every row, column-aligned, with group heading rows kept as "## heading" (sheets.ts); clipped to maxChars.
      const t = await readTable(abs);
      info.text = tableText(t, maxChars); info.pages = t.sheets.length; info.method = "xlsx-xml";
    } else if (ext === ".ipynb") {
      const nb = JSON.parse(readFileSync(abs, "utf8"));
      info.text = (nb.cells ?? []).map((c: any) => `[${c.cell_type}]\n${[].concat(c.source ?? []).join("")}`).join("\n\n"); info.method = "ipynb";
    } else if (kind === "code" || kind === "text") {
      if (st.size <= 4 * 1024 * 1024) { info.text = readFileSync(abs, "utf8"); info.method = "read"; }
      else info.error = "file_too_large";
    }
    // Anything else (Keynote, Pages, Numbers, legacy ppt/xls, …): ask Spotlight's importer for the text.
    if (!info.text.trim() && !info.error && kind !== "code" && kind !== "text") {
      const t = await spotlightText(abs);
      if (t.trim()) { info.text = t; info.method = "spotlight"; }
    }
  } catch (e: any) {
    info.error = info.error ?? `extract_failed`;
  }
  // PDF figures come out as U+FFFC placeholders and 1–3 character label lines: drop that debris.
  info.text = info.text.replace(/\ufffc/g, "").replace(/^[ \t]*\S{0,3}[ \t]*$\n?/gm, (m) => (/^\s*$/.test(m) ? m : "")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (info.text.length > maxChars) { info.text = info.text.slice(0, maxChars); info.truncated = true; }
  info.text = redact(info.text).text;

  if (opts.db && !info.error) {
    try { opts.db.prepare("INSERT OR REPLACE INTO doc_cache(key, path, extracted_at, json) VALUES (?,?,?,?)").run(key, abs, now(), JSON.stringify(info)); } catch { /* optional */ }
  }
  return info;
}

export const humanSize = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** Who signed / who it is addressed to, for letters and certificates. Small models confuse the person a
 *  letter is about with its sender, so the structure is stated explicitly. Undefined if not a letter. */
export function letterFacts(text: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const close = lines.findIndex((l) => /^(sincerely|yours (sincerely|truly|faithfully)|best regards|kind regards|warm regards|regards|respectfully|with (best|warm) wishes)\b[ ,.]*$/i.test(l) || /(드림|올림|배상)\s*$/.test(l));
  if (close < 0) return undefined;
  const signer = /(드림|올림|배상)\s*$/.test(lines[close]) ? [lines[close].replace(/\s*(드림|올림|배상)\s*$/, "")] : lines.slice(close + 1, close + 3);
  const to = lines.find((l) => /^(dear\b|to whom it may concern|to:|수신|받는\s?사람|.*귀하\s*$)/i.test(l));
  const head = lines.slice(0, 2).join(" / ");
  const out = [`sender (signed after "${lines[close]}"): ${signer.filter(Boolean).join(", ") || "unknown"}`];
  if (to) out.push(`addressed to: ${to}`);
  out.push(`letterhead / first lines: ${head}`);
  return out.join("\n");
}
