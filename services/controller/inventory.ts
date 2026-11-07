// Directory/document overview ("list and describe the documents in this folder").
// Deterministic map step + small AFM calls, deterministic reduce:
//   1. walk the folder (gated, bounded) and read Spotlight metadata + a short text excerpt per file
//   2. AFM writes a 1–2 sentence description per file from that excerpt (schema-constrained),
//      reusing fresh file_summary memories instead of re-asking
//   3. the controller renders the list itself, so the answer can only contain files that exist.
// This replaces a free tool loop, which failed on this task: AFM invented "docs/project_overview.md".

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { humanSize, kindOf, readDocument, type DocInfo, type DocKind } from "../context-builder/documents.ts";
import { gatePath } from "../security/gate.ts";
import { fileStamp, MemoryStore } from "../memory/memory.ts";

const LIST_WORDS = /(나열|목록|리스트|정리|설명|요약|소개|뭐가|무엇이|어떤|살펴|훑어|list|describe|summari[sz]e|overview|inventory|what('?s| is| are)? (in|inside)|(what|which) (files|documents|papers)|show)/i;
const DOC_WORDS = /(문서|파일|자료|논문|pdf|ppt|슬라이드|documents?|files?|papers?|slides?|folder contents)/i;
const DIR_WORDS = /(디렉토리|디렉터리|폴더|여기|이 곳|현재|directory|folder|here|this (dir|folder)|in this)/i;

export function isInventoryRequest(prompt: string): boolean {
  return LIST_WORDS.test(prompt) && DOC_WORDS.test(prompt) && (DIR_WORDS.test(prompt) || /(나열|list|inventory)/i.test(prompt));
}

export const hasHangul = (s: string) => /[가-힣]/.test(s);

const PRODUCER = /^(LaTeX with hyperref|Microsoft® Word.*|Hwp \d.*|ezPDF.*|Adobe .*|Acrobat .*|pdfTeX.*|Quartz PDFContext|Skia\/PDF.*|Writer|Word)$/i;
export const realAuthors = (a?: string[]) => (a ?? []).filter((x) => x && !PRODUCER.test(x) && x.length < 80);

/** Pick a subfolder the user named ("docs 폴더"), else the root. */
export function targetDir(prompt: string, root: string): string {
  for (const m of prompt.matchAll(/([\w.-][\w./ -]*?)\s*(?:폴더|디렉토리|디렉터리|folder|directory)/gi)) {
    const cand = m[1].trim().split(/\s+/).pop()!;
    if (!cand || /^(이|현재|this|the|current)$/i.test(cand)) continue;
    try { if (statSync(resolve(root, cand)).isDirectory() && gatePath(cand, root, "read").verdict === "allow") return cand; } catch { /* not a dir */ }
  }
  return ".";
}

export function walk(root: string, dir = ".", maxFiles = 40, maxDepth = 2): { files: string[]; skipped: number } {
  const files: string[] = [];
  let skipped = 0;
  const visit = (rel: string, depth: number) => {
    let entries;
    try { entries = readdirSync(resolve(root, rel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
      const p = rel === "." ? e.name : join(rel, e.name);
      if (gatePath(p, root, "read").verdict !== "allow") { skipped++; continue; }
      if (e.isDirectory()) subdirs.push(p);
      else if (e.isFile()) { if (files.length < maxFiles) files.push(p); else skipped++; }
    }
    if (depth < maxDepth) for (const d of subdirs) visit(d, depth + 1);
  };
  visit(dir, 1);
  return { files, skipped };
}

const DOC_TYPES = ["paper", "thesis", "slides", "manuscript", "certificate_or_letter", "report", "code", "data", "notes", "other"] as const;

const DESCRIBE_SCHEMA = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const, description: "The document's title as written in the excerpt, or empty if none" },
    doc_type: { type: "string" as const, enum: [...DOC_TYPES], description: "What kind of document this is" },
    summary: { type: "string" as const, description: "One or two sentences on what the document is about, based only on the excerpt" },
  },
  required: ["title", "doc_type", "summary"],
  additionalProperties: false,
};

export interface InventoryItem { info: DocInfo; title?: string; docType: string; summary: string; source: "afm" | "memory" | "metadata" }

export interface InventoryDeps {
  afm: AFMProvider;
  db?: DatabaseSync;
  memory?: MemoryStore;
  projectHash: string;
  timeoutMs: number;
  onCall?: (purpose: string, ok: boolean, ms: number, failure?: string) => void;
}

export async function buildInventory(root: string, prompt: string, deps: InventoryDeps, maxDescribe = 15) {
  const dir = targetDir(prompt, root);
  const { files, skipped } = walk(root, dir);
  const korean = hasHangul(prompt);
  const items: InventoryItem[] = [];
  const order: DocKind[] = ["pdf", "word", "slides", "sheet", "text", "code", "image", "other"];
  const sorted = [...files].sort((a, b) => order.indexOf(kindOf(a)) - order.indexOf(kindOf(b)) || a.localeCompare(b));

  let described = 0;
  for (const f of sorted) {
    const kind = kindOf(f);
    const describable = kind !== "image" && kind !== "other" && described < maxDescribe;
    const info = await readDocument(root, f, { maxChars: describable ? 1500 : 0, pdfPages: 1, db: deps.db });
    if (!describable) { items.push({ info, docType: kind, summary: "", source: "metadata" }); continue; }
    described++;

    const stamp = fileStamp(root, f);
    const cached = deps.memory?.fileSummary(deps.projectHash, f, root, korean ? "lang:ko" : "lang:en");
    if (cached) {
      const j = safeJson(cached.text);
      if (j) { items.push({ info, title: j.title, docType: j.doc_type, summary: j.summary, source: "memory" }); continue; }
    }
    if (!info.text) {
      items.push({ info, docType: kind, summary: korean ? "본문 텍스트를 읽지 못했어요 (메타데이터만 있음)." : "No readable text (metadata only).", source: "metadata" });
      continue;
    }
    const meta = [info.spotlightKind, info.pages ? `${info.pages} pages` : "", info.title ? `title: ${info.title}` : "",
      realAuthors(info.authors).length ? `authors: ${realAuthors(info.authors).join(", ")}` : ""].filter(Boolean).join("; ");
    const ask = (extra = "") => deps.afm.generate({
      system: `You describe one file for a folder overview. Use only the excerpt and metadata; do not guess beyond them. ` +
        `Keep names of people, venues, products and titles exactly as written (e.g. "Mina Cho", "NeurIPS"); never transliterate them. ` +
        (korean ? "Write the summary in Korean (한국어로 작성)." : "Write the summary in English.") + extra,
      user: `File: ${f}\nMetadata: ${meta || "none"}\nExcerpt (start of the file):\n${info.text}`,
      schema: DESCRIBE_SCHEMA,
      maxTokens: 220,
      timeoutMs: deps.timeoutMs,
    });
    // A schema violation here is usually doc_type outside the enum; keep the summary and coerce the type.
    const salvage = (x: Awaited<ReturnType<typeof ask>>) => {
      const j = x.json as any;
      if (!x.ok && x.failure === "schema_violation" && j && typeof j.summary === "string" && j.summary.trim()) {
        return { ...x, ok: true, failure: undefined, json: { title: typeof j.title === "string" ? j.title : "", doc_type: DOC_TYPES.includes(j.doc_type) ? j.doc_type : "other", summary: j.summary } };
      }
      return x;
    };
    let r = salvage(await ask());
    deps.onCall?.("describe_file", r.ok, r.latencyMs, r.failure);
    // AFM sometimes answers in the excerpt's language; one retry with a stricter instruction.
    if (r.ok && korean && !hasHangul((r.json as any).summary)) {
      r = salvage(await ask(" 반드시 summary 필드는 한국어 문장으로 쓰세요. The previous summary was not in Korean."));
      deps.onCall?.("describe_file_retry_lang", r.ok, r.latencyMs, r.failure);
    }
    if (r.ok && korean && !hasHangul((r.json as any).summary)) {   // last resort: translate the short summary
      const tr = await deps.afm.generate({
        system: "Translate the text into natural Korean. Keep names, titles and technical terms (e.g. LLM, ASGUARD) as written.",
        user: (r.json as any).summary,
        schema: { type: "object", properties: { korean: { type: "string", description: "The Korean translation" } }, required: ["korean"], additionalProperties: false },
        maxTokens: 260, timeoutMs: deps.timeoutMs,
      });
      deps.onCall?.("translate_summary", tr.ok, tr.latencyMs, tr.failure);
      if (tr.ok && hasHangul((tr.json as any).korean)) (r.json as any).summary = (tr.json as any).korean;
    }
    if (r.ok) {
      const j = r.json as { title: string; doc_type: string; summary: string };
      j.title = (j.title || info.title || "").replace(/\s+/g, " ").trim();
      if (kind === "code") j.doc_type = "code";
      items.push({ info, title: j.title, docType: j.doc_type, summary: j.summary.replace(/\s+/g, " ").trim(), source: "afm" });
      const langOk = !korean || hasHangul(j.summary);
      if (langOk) deps.memory?.remember(deps.projectHash, {
        kind: "file_summary", text: JSON.stringify(j), paths: [f], keywords: [korean ? "lang:ko" : "lang:en", j.doc_type],
        importance: 0.6, fileStamp: stamp,
      });
    } else {
      const firstLine = info.text.split("\n").find((l) => l.trim().length > 10)?.trim().slice(0, 140) ?? "";
      items.push({ info, docType: kind, summary: firstLine, source: "metadata" });
    }
  }
  return { dir, items, skipped, total: files.length, korean };
}

function safeJson(s: string): any { try { return JSON.parse(s); } catch { return undefined; } }

const LABELS: Record<string, [string, string]> = {
  paper: ["논문", "Papers"], thesis: ["학위논문", "Theses"], slides: ["발표 자료", "Slides"], manuscript: ["원고", "Manuscripts"],
  certificate_or_letter: ["증명서·서신", "Certificates & letters"], report: ["보고서", "Reports"], code: ["코드", "Code"],
  data: ["데이터", "Data"], notes: ["노트", "Notes"], other: ["기타", "Other"],
  pdf: ["PDF", "PDF"], word: ["문서", "Documents"], sheet: ["스프레드시트", "Spreadsheets"], text: ["텍스트", "Text"], image: ["이미지", "Images"],
};

export function renderInventory(inv: Awaited<ReturnType<typeof buildInventory>>): string {
  const ko = inv.korean;
  const where = inv.dir === "." ? (ko ? "현재 폴더" : "this folder") : `\`${inv.dir}/\``;
  const groups = new Map<string, InventoryItem[]>();
  for (const it of inv.items) groups.set(it.docType, [...(groups.get(it.docType) ?? []), it]);
  const lines = [ko ? `**${where}의 파일 ${inv.total}개**` : `**${inv.total} files in ${where}**`, ""];
  for (const [type, its] of groups) {
    lines.push(`### ${(LABELS[type] ?? [type, type])[ko ? 0 : 1]} (${its.length})`);
    for (const it of its) {
      const i = it.info;
      const facts = [i.spotlightKind ?? i.kind, i.pages ? (ko ? `${i.pages}쪽` : `${i.pages} p.`) : "", humanSize(i.bytes), i.modified].filter(Boolean).join(" · ");
      const title = it.title && !i.path.includes(it.title) ? ` — *${it.title}*` : "";
      lines.push(`- **${i.path}**${title}`);
      lines.push(`  ${facts}${i.method.includes("ocr") ? (ko ? " · OCR" : " · OCR") : ""}`);
      if (it.summary) lines.push(`  ${it.summary}`);
      if (i.error) lines.push(`  ⚠ ${i.error}`);
    }
    lines.push("");
  }
  if (inv.skipped) lines.push(ko ? `_(보안 규칙이나 개수 제한으로 ${inv.skipped}개 항목은 생략했어요.)_` : `_(${inv.skipped} entries skipped by security rules or the size limit.)_`);
  const fromMemory = inv.items.filter((x) => x.source === "memory").length;
  if (fromMemory) lines.push(ko ? `_(${fromMemory}개 설명은 이전에 저장한 메모리에서 재사용 — 파일이 바뀌면 자동으로 다시 읽어요.)_` : `_(${fromMemory} descriptions reused from memory; re-read automatically when a file changes.)_`);
  return lines.join("\n").trim();
}
