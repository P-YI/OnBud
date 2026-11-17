// Common Mac tasks (skills plan P6, 2026-11-06). Code nodes first; AFM is not needed for any of them.
//   convert       images (sips: format, size), PDFs (merge, images → PDF: tools/pdftool), documents (textutil),
//                 zip (ditto). Inputs: files the user named, through the security gate. Output: a NEW file next
//                 to the first input ("name (converted).png"); nothing is overwritten or deleted. Size cap
//                 (skills.json options.convert.maxMB, default 500). The result is checked (exists, format, pages).
//   shortcuts     list the user's shortcuts; run one by its exact name (approval: the command flow asks); install
//                 one from the vetted catalogue (skills/shortcuts/catalog: signed, then Apple's import dialog). AFM
//                 never writes shortcut actions.
//   mac_control   dark/light mode, volume, mute, screenshot to a new file (approval: the command flow asks);
//                 clipboard text when asked (shown once, secrets masked, never stored)
//   browser_tab   the front Safari/Chrome tab's title and URL, when asked (macOS asks once for Automation access)
//   personal      Calendar events and Reminders, read-only (tools/pim, EventKit; macOS asks once). Off until the
//                 user turns it on (skills.json). Shown to the user only: no memory, no hand-off, counts in logs.
// None of these run for a delegated (read-only) task: the controller refuses them before they start.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { gatePath, redact } from "../security/gate.ts";
import { option } from "../skills/settings.ts";
import type { Choice } from "./choices.ts";
import { Staging } from "./atomic.ts";
import { recordCreated } from "./undo.ts";
import { pageExprs, pageRanges, pdfPlan, resolvePdfPlan } from "./pdf-plan.ts";

export interface TaskCtx { root: string; prompt: string; files: { path: string }[]; ko: boolean; history?: string }
export interface TaskResult { answer: string; verified: boolean; detail: string; pendingCommand?: string; declined?: boolean; choices?: Choice[] }

const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const run = (cmd: string, args: string[], timeout = 60_000) => new Promise<{ code: number; out: string; err: string }>((res) =>
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin", HOME: homedir(), LANG: "en_US.UTF-8" } },
    (e: any, out, err) => res({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(out ?? ""), err: String(err ?? "") })));
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const T = (ko: boolean, k: string, e: string) => (ko ? k : e);

// ---------------------------------------------------------------- Swift helpers, built on first use
async function helper(name: "pdftool" | "pim"): Promise<string | undefined> {
  const src = new URL(`../../tools/${name}/${name === "pdftool" ? "PDFTool" : "PIM"}.swift`, import.meta.url).pathname;
  const bin = join(HOME, "runtime", "bin", `afm-${name}`);
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return bin;
  mkdirSync(dirname(bin), { recursive: true });
  const extra = name === "pim" ? ["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", join(dirname(src), "Info.plist")] : [];
  const r = await run("/usr/bin/swiftc", ["-O", "-parse-as-library", ...extra, "-o", bin, src], 240_000);
  return r.code === 0 && existsSync(bin) ? bin : undefined;
}

// ---------------------------------------------------------------- convert
const IMG = /\.(png|jpe?g|heic|heif|tiff?|gif|bmp|webp)$/i;
const DOC = /\.(txt|rtf|rtfd|html?|docx?|odt|webarchive)$/i;
const SIPS_FMT: Record<string, string> = { png: "png", jpg: "jpeg", jpeg: "jpeg", heic: "heic", tiff: "tiff", tif: "tiff", gif: "gif", bmp: "bmp" };
const TEXTUTIL_FMT = ["txt", "html", "rtf", "rtfd", "doc", "docx", "odt", "wordml", "webarchive"];

/** A path next to `like` that does not exist yet: "name (converted).ext", "name (converted 2).ext", … */
export function freshPath(dir: string, stem: string, tag: string, ext: string, taken?: Set<string>): string {
  stem = stem.replace(/(\s\((converted|compressed|merged|pages|archive)(\s\d+)?\))+$/, "");   // "a (converted) (compressed)" → "a (compressed)"
  for (let i = 1; ; i++) {
    const p = join(dir, `${stem} (${tag}${i > 1 ? ` ${i}` : ""}).${ext}`);
    if (!existsSync(p) && !taken?.has(p)) return p;
  }
}

const MERGE_WORDS = /(merge|combine|join|concatenate|stitch|합쳐|합치|합친|병합|하나로|이어\s?붙)/i;
const INSERT_WORDS = /(insert|\bput\b|\bplace\b|append|attach|넣어|넣고|끼워|삽입|붙여)/i;
/** One PDF, pages to remove or keep: page words and an edit verb, not a question about the text on them. */
export function pdfPageEdit(prompt: string): boolean {
  const ask = prompt.split(/\n\n(Files|Text \()/)[0];
  if (!pageExprs(ask).length) return false;
  if (/(요약|번역|설명|읽어|내용|텍스트|글자|무슨|뭐라고|summar|translat|explain|read|what does|text|words|table|표로)/i.test(ask) && !/(빼|삭제|지워|제외|without|remove|delete|drop)/i.test(ask)) return false;
  return /(빼|뺀|삭제|지워|지우|제외|없애|제거|만\s?(남겨|남기|뽑|추출|저장|따로|골라)|뽑아|추출|골라|따로\s?저장|분리|remove|delete|drop|skip|exclude|without|get rid of|take out|keep only|keep pages|keep just|extract|pull out|save (only )?pages?|split out|new pdf)/i.test(ask);
}

/** What the request asks for, from its words (en/ko): a target format, a size, merging, zipping. */
/** "under 5MB", "5 MB 이하", "max 800 KB", "2메가 미만" → bytes, or undefined. */
export function sizeTarget(prompt: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s?(gb|mb|kb|기가|메가|킬로|m\b|k\b)/i.exec(prompt);
  if (!m) return undefined;
  const n = Number(m[1]), u = m[2].toLowerCase();
  // decimal units, as Finder shows sizes (5 MB = 5,000,000 bytes): a "5 MB" result must read ≤ 5 MB in Finder
  const bytes = n * (/^(gb|기가)$/.test(u) ? 1e9 : /^(mb|메가|m)$/.test(u) ? 1e6 : 1e3);
  return bytes >= 10_000 ? Math.round(bytes) : undefined;
}

export function convertPlan(prompt: string, inputs: string[]): { op: "merge_pdf" | "pdf_pages" | "images_pdf" | "image" | "shrink" | "doc" | "zip"; fmt?: string; px?: number; pct?: number; maxBytes?: number } | undefined {
  // format names people use: "a Word file" → docx, "plain text" → txt, "web page" → html
  const p = prompt.toLowerCase().replace(/\b(ms\s)?word\b|워드/g, " docx ").replace(/plain text|text file|텍스트/g, " txt ").replace(/web ?page|웹\s?페이지/g, " html ");
  const fmt = /\b(png|jpe?g|heic|tiff?|gif|bmp|pdf|txt|html|rtf|docx?|odt)\b/.exec(p.replace(/\.[a-z0-9]+\b/g, " "))?.[1];
  const px = Number(/(\d{2,5})\s?(px|픽셀|pixels?)/.exec(p)?.[1] ?? 0) || undefined;
  const pct = Number(/(\d{1,3})\s?%/.exec(p)?.[1] ?? 0) || undefined;
  const imgsAll = inputs.filter((f) => IMG.test(f));
  const maxBytes = sizeTarget(p);
  const squeeze = /(용량|파일\s?크기|가볍게|작게|줄여|줄이|compress|smaller|reduce\b.{0,20}\bsize|shrink|optimi[sz]e|under|below|less than|at most|이하|미만|넘지)/.test(p);
  // images: "compress" or a size limit wins over the word 압축 meaning zip, and keeps the format asked for
  // ("Compress under 5MB, but jpg format" → JPEG at the size, not a plain conversion that grew the file)
  const resizeOnly = (px || pct) && !maxBytes && !/(compress|용량|압축|file size|파일\s?크기)/.test(p);   // "300px로 줄여줘" is a resize
  if (imgsAll.length && imgsAll.length === inputs.length && !resizeOnly && (maxBytes || ((squeeze || /압축/.test(p)) && !/(\bzip\b|묶)/.test(p))) && fmt !== "pdf") return { op: "shrink", fmt: fmt && SIPS_FMT[fmt] ? fmt : undefined, maxBytes, px, pct };
  if (/(zip|압축)/.test(p)) return { op: "zip" };
  const pdfs = inputs.filter((f) => /\.pdf$/i.test(f)), imgs = inputs.filter((f) => IMG.test(f));
  // PDFs (pdf-plan.ts): merge in an order, with pages left out or picked; images named with them become pages;
  // one PDF with pages to remove or keep ("a.pdf에서 3쪽 빼줘", "keep only pages 1-2") is a new PDF of those pages
  const pageable = inputs.filter((f) => /\.pdf$/i.test(f) || IMG.test(f));
  if (pdfs.length && pageable.length >= 2 && (MERGE_WORDS.test(p) || INSERT_WORDS.test(p))) return { op: "merge_pdf" };
  if (pdfs.length === 1 && inputs.length === 1 && pdfPageEdit(prompt)) return { op: "pdf_pages" };
  if (imgs.length && fmt === "pdf") return { op: "images_pdf" };
  if (imgs.length && (fmt && SIPS_FMT[fmt] || px || pct)) return { op: "image", fmt: fmt && SIPS_FMT[fmt] ? fmt : undefined, px, pct };
  // "make it smaller" with no format or size named: the file size, chosen per image in convert()
  if (imgs.length && /(용량|파일\s?크기|가볍게|작게|줄여|줄이|compress|smaller|reduce\b.{0,20}\bsize|shrink|optimi[sz]e)/.test(p)) return { op: "shrink" };
  if (inputs.some((f) => DOC.test(f)) && fmt && TEXTUTIL_FMT.includes(fmt === "doc" ? "doc" : fmt)) return { op: "doc", fmt };
  return undefined;
}

/** The file a follow-up means: when the last answer created a file from this input ("IMG_6729 (converted).jpg"
 *  from "IMG_6729.HEIC") and the request names no file itself ("Compress the file under 5MB"), that newest file.
 *  Spotlight keeps the original attached, so before, the follow-up worked on the original again. */
export function followUpFile(prompt: string, inputs: string[], history: string | undefined): string | undefined {
  if (!history || inputs.length !== 1) return undefined;
  const ask = prompt.split(/\n\n(Files|Text \()/)[0];
  const stem = basename(inputs[0], extname(inputs[0]));
  if (ask.toLowerCase().includes(stem.toLowerCase())) return undefined;   // the original named on purpose
  const home = homedir();
  const made = [...history.matchAll(/- `((?:~\/|\/)[^`]+)`/g)].map((m) => m[1].startsWith("~") ? join(home, m[1].slice(2)) : m[1]);
  const last = made.reverse().find((f) => basename(f).startsWith(`${stem} (`) && existsSync(f));
  return last;
}

/** Outputs appear only when the conversion succeeded (atomic.ts): written under hidden temporary names, moved into
 *  place together at the end, removed on a failure or when the request is stopped. Recorded for undo (undo.ts). */
export async function convert(c: TaskCtx): Promise<TaskResult> {
  const st = new Staging();
  try {
    const r = await convertStaged(c, st);
    if (r.verified) { const made = st.commit(); if (made.length) recordCreated(c.prompt, made); }
    return r;
  } finally { st.discardAll(); }
}

async function convertStaged(c: TaskCtx, st: Staging): Promise<TaskResult> {
  const fresh = (dir: string, stem: string, tag: string, ext: string) => st.reserve(freshPath(dir, stem, tag, ext, st.taken()));
  let abs = c.files.map((f) => resolve(c.root || homedir(), f.path)).filter((p) => existsSync(p));
  const follow = followUpFile(c.prompt, abs, c.history);
  if (follow) abs = [follow];
  if (!abs.length) return { answer: T(c.ko, "어떤 파일을 변환할까요? 파일 이름을 알려 주세요.", "Which file should I convert? Name the file."), verified: false, detail: "no_input" };
  for (const p of abs) {
    const g = gatePath(p, dirname(p), "read");
    if (g.verdict === "deny") return { answer: T(c.ko, `\`${basename(p)}\`는 보안 정책상 다룰 수 없어요.`, `\`${basename(p)}\` is blocked by the security gate.`), verified: false, detail: "gate_denied" };
  }
  const maxMB = option("convert", "maxMB", 500);
  const total = abs.reduce((n, p) => n + statSync(p).size, 0) / 1024 / 1024;
  if (total > maxMB) return { answer: T(c.ko, `파일이 너무 커요 (${total.toFixed(0)} MB, 한도 ${maxMB} MB).`, `Too large (${total.toFixed(0)} MB, limit ${maxMB} MB).`), verified: false, detail: "too_large" };
  const plan = convertPlan(c.prompt, abs);
  if (!plan) return { answer: "", verified: false, detail: "no_plan", declined: true };
  const dir = dirname(abs[0]), stem = basename(abs[0], extname(abs[0]));
  const outs: string[] = [];
  let check = "";
  if (plan.op === "merge_pdf" || plan.op === "pdf_pages") return pdfAssemble(c, abs.filter((f) => /\.pdf$/i.test(f) || IMG.test(f)), plan.op, follow, fresh, st);
  if (plan.op === "images_pdf") {
    const bin = await helper("pdftool");
    if (!bin) return { answer: T(c.ko, "PDF 도구를 만들지 못했어요 (Xcode Command Line Tools 필요: `xcode-select --install`).", "Could not build the PDF tool (needs the Command Line Tools: `xcode-select --install`)."), verified: false, detail: "no_pdftool" };
    const out = fresh(dir, stem, "converted", "pdf");
    const r = await run(bin, ["images", out, ...abs]);
    if (r.code !== 0) return { answer: T(c.ko, `변환 실패: ${r.err.trim()}`, `Conversion failed: ${r.err.trim()}`), verified: false, detail: "failed" };
    const want = abs.length;
    const got = Number((await run(bin, ["pages", out])).out.trim());
    check = `${got}/${want} pages`;
    if (got !== want) return { answer: T(c.ko, `만든 PDF의 쪽수가 맞지 않아요 (${check}).`, `The new PDF has the wrong page count (${check}).`), verified: false, detail: "check_failed" };
    outs.push(out);
  } else if (plan.op === "image") {
    for (const p of abs.filter((f) => IMG.test(f))) {
      const ext = plan.fmt ? (plan.fmt === "jpeg" ? "jpg" : plan.fmt) : extname(p).slice(1);
      const out = fresh(dirname(p), basename(p, extname(p)), "converted", ext);
      const args = [...(plan.fmt ? ["-s", "format", SIPS_FMT[plan.fmt]] : [])];
      // "800 px wide" sets the width, "600 px tall" the height, a bare "800 px" the longer side
      if (plan.px) args.push(...(/(wide|width|너비|가로)/i.test(c.prompt) ? ["--resampleWidth"] : /(tall|height|높이|세로)/i.test(c.prompt) ? ["--resampleHeight"] : ["-Z"]), String(plan.px));
      if (plan.pct) { const w = Number(/pixelWidth: (\d+)/.exec((await run("/usr/bin/sips", ["-g", "pixelWidth", p])).out)?.[1] ?? 0); if (w) args.push("--resampleWidth", String(Math.max(1, Math.round(w * plan.pct / 100)))); }
      const r = await run("/usr/bin/sips", [...args, p, "--out", out]);
      if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, `변환 실패: ${basename(p)}`, `Conversion failed: ${basename(p)}`), verified: false, detail: "failed" };
      outs.push(out);
    }
    const g = (await run("/usr/bin/sips", ["-g", "format", "-g", "pixelWidth", outs[0]])).out;
    const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e6 ? 2 : 1)} MB`;   // Finder's decimal MB
    const src = abs.find((f) => IMG.test(f))!;
    check = `${/format: (\w+)/.exec(g)?.[1] ?? "?"}, ${/pixelWidth: (\d+)/.exec(g)?.[1] ?? "?"} px, ${mb(statSync(src).size)} → ${mb(statSync(outs[0]).size)}`;
  } else if (plan.op === "shrink") {
    // Without a target: JPEG/HEIC re-encoded at quality 70; opaque PNG and others → JPEG 80; transparent → PNG at 75%.
    // With a target ("under 5MB") or a format ("as jpg"): quality is searched (sips formatOptions) and, if quality 40
    // is still too big, the image is scaled down in steps until it fits; the result is checked against the target.
    const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e6 ? 2 : 1)} MB`;   // Finder's decimal MB
    const notes: string[] = [];
    const tmp = join(HOME, "runtime", "tmp"); mkdirSync(tmp, { recursive: true });
    for (const p of abs.filter((f) => IMG.test(f))) {
      const info = (await run("/usr/bin/sips", ["-g", "format", "-g", "hasAlpha", "-g", "pixelWidth", "-g", "pixelHeight", p])).out;
      const format = /format: (\w+)/.exec(info)?.[1] ?? "", alpha = /hasAlpha: yes/.test(info);
      const side = Math.max(Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 0), Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 0));
      const before = statSync(p).size;
      // the output format: the one asked for, else lossy formats stay, opaque others become JPEG, transparent stay PNG
      const target = plan.fmt ? SIPS_FMT[plan.fmt] : format === "jpeg" || format === "heic" ? format : !alpha ? "jpeg" : "png";
      const ext = plan.fmt ? (plan.fmt === "jpeg" ? "jpg" : plan.fmt) : target === format ? extname(p).slice(1) : target === "jpeg" ? "jpg" : target;
      // already under the size asked for, in the format asked for: nothing to do (re-encoding a JPEG can make it larger)
      if (plan.maxBytes && before <= plan.maxBytes && target === format) { notes.push(T(c.ko, `\`${basename(p)}\`은(는) 이미 ${mb(plan.maxBytes)} 이하예요 (${mb(before)}). 새 파일을 만들지 않았어요.`, `\`${basename(p)}\` is already under ${mb(plan.maxBytes)} (${mb(before)}); no new file.`)); continue; }
      const out = fresh(dirname(p), basename(p, extname(p)), "compressed", ext);
      const lossy = target === "jpeg" || target === "heic";
      const attempt = async (q: number | undefined, px: number | undefined, dst: string) => {
        const args = ["-s", "format", target, ...(lossy && q ? ["-s", "formatOptions", String(q)] : []), ...(px ? ["-Z", String(px)] : [])];
        const r = await run("/usr/bin/sips", [...args, p, "--out", dst]);
        return r.code === 0 && existsSync(dst) ? statSync(dst).size : Infinity;
      };
      let how = "", size = Infinity;
      if (!plan.maxBytes) {
        const q = lossy ? (format === target ? 70 : 80) : undefined, px = !lossy && side > 64 ? Math.round(side * 0.75) : undefined;
        size = await attempt(q, px, out);
        how = lossy ? T(c.ko, `${target === "jpeg" ? "JPEG" : "HEIC"} 품질 ${q}`, `${target === "jpeg" ? "JPEG" : "HEIC"} quality ${q}`) : T(c.ko, "투명 배경이라 PNG, 크기 75%", "PNG kept for transparency, 75% size");
      } else {
        // quality first (binary search between 40 and 90), then the size in 15% steps
        const probe = join(tmp, `probe-${process.pid}.${ext}`);
        let best: { q?: number; px?: number; size: number } | undefined;
        if (lossy) {
          let lo = 40, hi = 90;
          if ((await attempt(hi, undefined, probe)) <= plan.maxBytes) best = { q: hi, size: statSync(probe).size };
          else {
            while (hi - lo > 5) { const mid = Math.round((lo + hi) / 2); const s2 = await attempt(mid, undefined, probe); if (s2 <= plan.maxBytes) { best = { q: mid, size: s2 }; lo = mid; } else hi = mid; }
            if (!best) { const s2 = await attempt(lo, undefined, probe); if (s2 <= plan.maxBytes) best = { q: lo, size: s2 }; }
          }
        }
        for (let px = Math.round(side * 0.85); !best && px >= 320; px = Math.round(px * 0.85)) {
          const s2 = await attempt(lossy ? 70 : undefined, px, probe);
          if (s2 <= plan.maxBytes) best = { q: lossy ? 70 : undefined, px, size: s2 };
        }
        try { unlinkSync(probe); } catch { /* gone */ }
        if (!best) { notes.push(T(c.ko, `\`${basename(p)}\`: ${mb(plan.maxBytes)} 이하로 줄이지 못했어요.`, `\`${basename(p)}\`: could not get it under ${mb(plan.maxBytes)}.`)); continue; }
        size = await attempt(best.q, best.px, out);
        how = [best.q ? T(c.ko, `품질 ${best.q}`, `quality ${best.q}`) : "", best.px ? T(c.ko, `긴 변 ${best.px} px`, `long side ${best.px} px`) : ""].filter(Boolean).join(", ");
        if (size > plan.maxBytes) { try { unlinkSync(out); } catch { /* gone */ } notes.push(T(c.ko, `\`${basename(p)}\`: 확인 결과 ${mb(size)}로 목표보다 커요.`, `\`${basename(p)}\`: the check found ${mb(size)}, over the target.`)); continue; }
      }
      if (!isFinite(size)) return { answer: T(c.ko, `변환 실패: ${basename(p)}`, `Conversion failed: ${basename(p)}`), verified: false, detail: "failed" };
      // no target and no new format: a result that is not smaller is not kept
      if (!plan.maxBytes && !plan.fmt && size >= before) { unlinkSync(out); notes.push(T(c.ko, `\`${basename(p)}\`: 더 작게 만들지 못했어요 (${mb(before)}).`, `\`${basename(p)}\`: could not make it smaller (${mb(before)}).`)); continue; }
      outs.push(out);
      notes.push(`\`${basename(st.finalOf(out))}\`: ${mb(before)} → ${mb(size)}${plan.maxBytes ? ` (≤ ${mb(plan.maxBytes)} ✓)` : ""}, ${how}${size >= before ? T(c.ko, " — 형식을 바꾸느라 원본보다 커요", " — larger than the original because of the format change") : ""}`);
    }
    if (!outs.length) return { answer: notes.join("\n"), verified: notes.every((n) => /(already under|이미 .* 이하)/.test(n)), detail: "not_smaller" };
    check = notes.join("; ");
  } else if (plan.op === "doc") {
    for (const p of abs.filter((f) => DOC.test(f))) {
      const out = fresh(dirname(p), basename(p, extname(p)), "converted", plan.fmt!);
      const r = await run("/usr/bin/textutil", ["-convert", plan.fmt!, "-output", out, p]);
      if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, `변환 실패: ${basename(p)}`, `Conversion failed: ${basename(p)}`), verified: false, detail: "failed" };
      outs.push(out);
    }
    check = `${outs.length} document(s)`;
  } else {
    const out = fresh(dir, stem, "archive", "zip");
    const r = await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", abs[0], out]);
    if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, "압축 실패", "Zip failed"), verified: false, detail: "failed" };
    outs.push(out); check = "zip";
  }
  const home = homedir();
  const short = (p: string) => (p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p);
  const from = follow ? T(c.ko, `방금 만든 \`${basename(follow)}\`로 작업했어요.\n\n`, `Worked on \`${basename(follow)}\`, the file made in the last step.\n\n`) : "";
  return { answer: from + T(c.ko, "새 파일을 만들었어요 (원본은 그대로예요):", "Created (the originals are unchanged):") + "\n\n" + outs.map((o) => `- \`${short(st.finalOf(o))}\``).join("\n") + `\n\n_${T(c.ko, "확인", "Check")}: ${check}_`,
    verified: true, detail: `${plan.op}: ${outs.length} file(s), ${check}` };
}

/** Merging PDFs (and images as pages) in the order asked, with pages left out or picked, or one PDF's pages
 *  (pdf-plan.ts). The new PDF is checked page by page against its sources (text, size and rotation of each page). */
async function pdfAssemble(c: TaskCtx, ins: string[], op: "merge_pdf" | "pdf_pages", follow: string | undefined, fresh: (dir: string, stem: string, tag: string, ext: string) => string, st: Staging): Promise<TaskResult> {
  const bin = await helper("pdftool");
  if (!bin) return { answer: T(c.ko, "PDF 도구를 만들지 못했어요 (Xcode Command Line Tools 필요: `xcode-select --install`).", "Could not build the PDF tool (needs the Command Line Tools: `xcode-select --install`)."), verified: false, detail: "no_pdftool" };
  const plan = pdfPlan(c.prompt, ins);
  const isPdf = (f: string) => /\.pdf$/i.test(f);
  if (plan.unbound.length && ins.filter(isPdf).length >= 2) {
    const w = plan.unbound[0];
    // the options: that page of each PDF, or of the merged result; each is the request with the file written in
    const at = c.prompt.indexOf(w);
    const said = (x: string) => (at >= 0 ? c.prompt.slice(0, at) + x + c.prompt.slice(at + w.length) : `${c.prompt} (${x})`);
    const choices: Choice[] = [
      ...ins.filter(isPdf).slice(0, 5).map((f) => ({ label: T(c.ko, `${basename(f)}의 ${w}`, `${w} of ${basename(f)}`), prompt: said(T(c.ko, `${basename(f)}의 ${w}`, `${w} of ${basename(f)}`)) })),
      { label: T(c.ko, `합친 결과의 ${w}`, `${w} of the merged file`), prompt: said(T(c.ko, `합친 파일에서 ${w}`, `${w} of the merged file`)) },
    ];
    return { verified: false, detail: "ambiguous_pages", choices, answer: T(c.ko, `"${w}"은(는) 어느 파일의 페이지인가요?`, `Which file is "${w}" in?`) };
  }
  // page counts (an image is one page); a PDF that cannot be opened is said plainly
  const counts: number[] = [];
  for (const f of ins) {
    if (!isPdf(f)) { counts.push(1); continue; }
    const r = await run(bin, ["pages", f]);
    if (r.code !== 0) return { verified: false, detail: "unreadable_pdf", answer: /locked/.test(r.err)
      ? T(c.ko, `\`${basename(f)}\`은(는) 암호가 걸려 있어 열 수 없어요. 미리보기에서 암호를 풀고 저장한 뒤 다시 요청해 주세요.`, `\`${basename(f)}\` is password-protected. Unlock it in Preview, save it, and ask again.`)
      : T(c.ko, `\`${basename(f)}\`을(를) PDF로 열 수 없어요.`, `\`${basename(f)}\` could not be opened as a PDF.`) };
    counts.push(Number(r.out.trim()) || 0);
  }
  const res = resolvePdfPlan(plan, ins, counts);
  if ("error" in res) return { verified: false, detail: res.error, answer: res.error === "empty"
    ? T(c.ko, "그렇게 하면 남는 페이지가 없어요. 뺄 페이지를 다시 확인해 주세요.", "That leaves no pages. Check the pages to remove.")
    : T(c.ko, `없는 페이지예요: ${res.bad.map((b) => b.replace(/\((\d+)\)$/, "(전체 $1쪽)")).join(", ")}. 새 파일은 만들지 않았어요.`, `Those pages do not exist: ${res.bad.map((b) => b.replace(/\((\d+)\)$/, "(has $1 pages)")).join(", ")}. No new file was made.`) };
  const segs = res.segments;
  const all = (s: { file: number; pages: number[] }) => s.pages.length === counts[s.file] && s.pages.every((p, i) => p === i + 1);
  if (op === "pdf_pages" && segs.length === 1 && all(segs[0])) return { verified: false, detail: "no_change", answer: T(c.ko, "바뀌는 페이지가 없어요. 뺄 페이지나 남길 페이지를 알려 주세요.", "Nothing changes. Say which pages to remove or keep.") };
  const first = ins[segs[0].file];
  const out = fresh(dirname(first), basename(first, extname(first)), op === "merge_pdf" ? "merged" : "pages", "pdf");
  const r = await run(bin, ["assemble", out, ...segs.flatMap((s) => [isPdf(ins[s.file]) ? s.pages.join(",") : "all", ins[s.file]])], 120_000);
  if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, `PDF를 만들지 못했어요: ${r.err.trim()}`, `Could not make the PDF: ${r.err.trim()}`), verified: false, detail: "failed" };
  // the check: every page of the new PDF is the page planned for it
  const sigs = new Map<number, string[]>();
  for (const s of segs) if (isPdf(ins[s.file]) && !sigs.has(s.file)) sigs.set(s.file, (await run(bin, ["sig", ins[s.file]])).out.trim().split("\n"));
  const want = segs.flatMap((s) => s.pages.map((p) => (isPdf(ins[s.file]) ? sigs.get(s.file)![p - 1] : "")));
  const got = (await run(bin, ["sig", out])).out.trim().split("\n").filter(Boolean);
  const wrong = want.findIndex((w, i) => w && w !== got[i]);
  if (got.length !== want.length || wrong >= 0) {
    try { unlinkSync(out); } catch { /* gone */ }
    return { answer: T(c.ko, `만든 PDF가 계획과 달라서 지웠어요 (${got.length}/${want.length}쪽${wrong >= 0 ? `, ${wrong + 1}쪽 불일치` : ""}).`, `The new PDF did not match the plan, so it was removed (${got.length}/${want.length} pages${wrong >= 0 ? `, page ${wrong + 1} differs` : ""}).`), verified: false, detail: "check_failed" };
  }
  const home = homedir();
  const short = (p: string) => (p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p);
  const lines = segs.map((s, i) => {
    const name = basename(ins[s.file]);
    if (!isPdf(ins[s.file])) return `${i + 1}. \`${name}\` — ${T(c.ko, "이미지 1쪽", "image, 1 page")}`;
    if (all(s)) return `${i + 1}. \`${name}\` — ${T(c.ko, `전체 ${counts[s.file]}쪽`, `all ${counts[s.file]} pages`)}`;
    return `${i + 1}. \`${name}\` — ${T(c.ko, `${pageRanges(s.pages)}쪽`, `page${s.pages.length > 1 ? "s" : ""} ${pageRanges(s.pages)}`)} ${T(c.ko, `(전체 ${counts[s.file]}쪽 중 ${s.pages.length}쪽)`, `(${s.pages.length} of ${counts[s.file]})`)}`;
  });
  const left = plan.left.length ? "\n\n" + T(c.ko, `요청에 없는 첨부 파일은 넣지 않았어요: ${plan.left.map((k) => `\`${basename(ins[k])}\``).join(", ")}`, `Attached but not named, so left out: ${plan.left.map((k) => `\`${basename(ins[k])}\``).join(", ")}`) : "";
  const from = follow ? T(c.ko, `방금 만든 \`${basename(follow)}\`로 작업했어요.\n\n`, `Worked on \`${basename(follow)}\`, the file made in the last step.\n\n`) : "";
  const check = T(c.ko, `${got.length}쪽, 모든 페이지가 원본과 일치`, `${got.length} pages, every page matches its source`);
  return { verified: true, detail: `${op}: ${segs.map((s) => `${basename(ins[s.file])}[${pageRanges(s.pages)}]`).join(" + ")}, ${got.length}/${want.length} pages`,
    answer: from + T(c.ko, "새 PDF를 만들었어요 (원본은 그대로예요):", "Created a new PDF (the originals are unchanged):") + `\n\n- \`${short(st.finalOf(out))}\`\n\n` + T(c.ko, "순서와 페이지:", "Order and pages:") + "\n" + lines.join("\n") + left + `\n\n_${T(c.ko, "확인", "Check")}: ${check}_` };
}

// ---------------------------------------------------------------- shortcuts
export interface CatalogEntry { id: string; name: string; description: string; file: string; lane: "contained" | "wide" | "irreversible" }
export function catalog(dir = new URL("../../skills/shortcuts/catalog/", import.meta.url).pathname): CatalogEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => ({ ...JSON.parse(readFileSync(join(dir, n), "utf8")), file: join(dir, JSON.parse(readFileSync(join(dir, n), "utf8")).file) }));
}

export async function shortcutsSkill(c: TaskCtx): Promise<TaskResult> {
  const list = (await run("/usr/bin/shortcuts", ["list"], 20_000)).out.split("\n").map((s) => s.trim()).filter(Boolean);
  const p = c.prompt;
  if (/(만들어|생성|작성|\b(create|make|write|build)\b)/i.test(p) && !/(설치|install)/i.test(p))
    return { answer: T(c.ko, "새 단축어는 단축어 앱에서 만들어 주세요. OnBud은 단축어 동작을 직접 작성하지 않아요 (형식이 공개돼 있지 않고, 단축어는 보내기·삭제까지 할 수 있어서요). 검증된 단축어 목록에 있는 것은 설치를 도와드릴 수 있어요.",
      "Please create new shortcuts in the Shortcuts app: OnBud does not write shortcut actions (the format is undocumented, and a shortcut can send or delete). It can install shortcuts from its vetted catalogue."), verified: true, detail: "create_refused" };
  if (/(설치|install|받아|다운로드|download|\bget\b|추가해|\badd\b|갤러리|gallery)/i.test(p)) {
    const cat = catalog();
    const hit = cat.find((e) => p.toLowerCase().includes(e.name.toLowerCase()) || p.toLowerCase().includes(e.id));
    // not in the vetted catalogue: Apple's Shortcuts Gallery, searched for it (adding stays the user's click)
    if (!hit && /(갤러리|gallery|받아|다운로드|download|\bget\b|설치|install|추가|\badd\b)/i.test(p)) {
      const want = (/["“'‘]([^"”'’]{2,60})["”'’]/.exec(p)?.[1] ?? p.replace(/(단축어|shortcuts?|갤러리에서|갤러리|gallery|from the|설치해?\s?줘?|받아\s?줘?|다운로드해?\s?줘?|추가해?\s?줘?|\b(install|download|get|add|a|an|the|me|for|please|from)\b)/gi, " ").replace(/\s+/g, " ").trim()).slice(0, 60);
      if (want) return missingShortcut(c, want, list, true);
    }
    if (!hit) return { answer: T(c.ko, cat.length ? `검증된 단축어: ${cat.map((e) => e.name).join(", ")}` : "아직 검증된 단축어 템플릿이 없어요.", cat.length ? `Vetted shortcuts: ${cat.map((e) => e.name).join(", ")}` : "No vetted shortcut templates yet."), verified: true, detail: "catalog" };
    if (hit.lane === "irreversible") return { answer: T(c.ko, "이 단축어는 보내기·삭제를 할 수 있어 자동 설치하지 않아요.", "This shortcut can send or delete, so it is not installed automatically."), verified: true, detail: "closed_lane" };
    const out = join(HOME, "runtime", "tmp", `${hit.id}.shortcut`);
    return { answer: T(c.ko, `**${hit.name}** — ${hit.description}\n서명한 뒤 단축어 앱의 가져오기 창을 열어요. 거기서 추가를 눌러 주세요.`, `**${hit.name}** — ${hit.description}\nIt is signed, then the Shortcuts import dialog opens; confirm there.`),
      verified: true, detail: "install", pendingCommand: `mkdir -p ${q(dirname(out))} && shortcuts sign -m people-who-know-me -i ${q(hit.file)} -o ${q(out)} && open ${q(out)}` };
  }
  const named = /["“'‘]([^"”'’]{2,80})["”'’]/.exec(p)?.[1] ?? list.filter((n) => p.toLowerCase().includes(n.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  if (/(실행|돌려|\b(run|start)\b)/i.test(p)) {
    const exact = named && list.find((n) => n.toLowerCase() === named.toLowerCase());
    if (!exact) return missingShortcut(c, named ?? p.replace(/(단축어|shortcuts?|실행해?\s?줘?|돌려\s?줘?|\b(run|start|my|the)\b)/gi, "").trim(), list);
    return { answer: T(c.ko, `단축어 **${exact}**를 실행할까요?`, `Run the shortcut **${exact}**?`), verified: true, detail: "run", pendingCommand: `shortcuts run ${q(exact)}` };
  }
  return { answer: (list.length ? T(c.ko, `단축어 ${list.length}개:`, `${list.length} shortcuts:`) + "\n\n" + list.slice(0, 60).map((n) => `- ${n}`).join("\n") : T(c.ko, "단축어가 없어요.", "You have no shortcuts.")), verified: true, detail: `list ${list.length}` };
}

/** A shortcut the user does not have: similar names first, then Apple's Shortcuts Gallery searched for it (the
 *  `shortcuts://gallery/search` link; adding a Gallery shortcut is one click in the Shortcuts app; nothing is
 *  downloaded or signed by OnBud, and no app-control permission is needed). */
async function missingShortcut(c: TaskCtx, want: string, list: string[], asked = false): Promise<TaskResult> {
  want = want.replace(/^(that|which|to|for|a|an)\s+/i, "").trim();
  const words = want.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const similar = list.filter((n) => words.some((w) => n.toLowerCase().includes(w))).slice(0, 5);
  const url = `shortcuts://gallery/search?query=${encodeURIComponent(want)}`;
  const ok = process.env.ONBUD_DRY_ACTIONS === "1" || (await run("/usr/bin/open", [url])).code === 0;
  // what OnBud already does itself for the same need
  const BUILTIN: [RegExp, string, string][] = [
    [/(heic|jpe?g|png|webp|pdf|convert|변환|resize|크기)/i, "OnBud도 파일 변환을 직접 해요: \"~/Pictures/a.heic를 jpg로 변환해줘\"", "OnBud converts files itself: \"convert ~/Pictures/a.heic to jpg\""],
    [/(timer|타이머|pomodoro|뽀모도로|focus timer)/i, "OnBud도 타이머를 직접 맞춰요: \"25분 타이머 맞춰줘\" / \"set a 25 minute timer\"", "OnBud sets timers itself: \"set a 25 minute timer\""],
    [/(remind|reminder|알림|리마인더|water|물)/i, "OnBud도 미리 알림을 직접 만들어요: \"오후 3시에 물 마시라고 알려줘\"", "OnBud creates reminders itself: \"remind me to drink water at 3pm\""],
    [/(screenshot|스크린샷|캡처)/i, "OnBud도 스크린샷을 직접 찍어요: \"스크린샷 찍어줘\"", "OnBud takes screenshots itself: \"take a screenshot\""],
    [/(wi-?fi|와이파이|share wi)/i, "OnBud도 Wi-Fi를 직접 켜고 꺼요: \"turn off wi-fi\"", "OnBud switches Wi-Fi itself: \"turn off wi-fi\""],
  ];
  const b = BUILTIN.find(([re]) => re.test(want));
  const builtin = b ? `\n\n${c.ko ? b[1] : b[2]}` : "";
  const sim = similar.length ? T(c.ko, `\n\n비슷한 단축어: ${similar.map((n) => `**${n}**`).join(", ")}`, `\n\nSimilar shortcuts you have: ${similar.map((n) => `**${n}**`).join(", ")}`) : "";
  // running one: the similar shortcuts the user has are options (picking one runs it, after the usual approval)
  const choices: Choice[] | undefined = !asked && similar.length ? similar.map((n) => ({ label: n, prompt: T(c.ko, `단축어 "${n}" 실행해줘`, `run the "${n}" shortcut`) })) : undefined;
  return { verified: ok, detail: `gallery_search ${want}`, choices, answer: (asked
      ? T(c.ko, `단축어 갤러리에서 "${want}"을(를) 검색해 열었어요.`, `Opened the Shortcuts Gallery searching for "${want}".`)
      : T(c.ko, `"${want}" 단축어가 없어서 단축어 갤러리에서 검색해 열었어요.`, `You have no "${want}" shortcut, so I opened the Shortcuts Gallery searching for it.`))
    + T(c.ko, " 마음에 드는 단축어에서 **단축어 추가**를 누르면, 다음부터 \"단축어 '이름' 실행해줘\"로 바로 실행할 수 있어요. 갤러리 단축어는 Apple이 제공하는 것이라 OnBud이 대신 설치하지는 않아요.", " Click **Add Shortcut** on the one you want; after that, \"run my '<name>' shortcut\" runs it. Gallery shortcuts come from Apple, so adding one stays your click.") + sim + builtin };
}

// ---------------------------------------------------------------- mac_control
const plainEn = (s: string) => s.trim().replace(/[.!?]+$/, "").replace(/^(could|can|would) you( please)?\s+|^please\s+/i, "").replace(/\s+(for me|please|now)$/i, "");

export async function macControl(c: TaskCtx): Promise<TaskResult> {
  const p = c.prompt.toLowerCase();
  const ask = (cmd: string, k: string, e: string, detail: string): TaskResult => ({ answer: T(c.ko, k, e), verified: true, detail, pendingCommand: cmd });
  if (/(다크\s?모드|dark mode)/.test(p) && !/(끄|해제|off|disable)/.test(p)) return ask(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'`, "다크 모드로 바꿀까요?", "Switch to Dark Mode?", "dark_on");
  if (/(라이트\s?모드|light mode)/.test(p) || /(다크\s?모드|dark mode).*(끄|해제|off|disable)/.test(p)) return ask(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to false'`, "라이트 모드로 바꿀까요?", "Switch to Light Mode?", "dark_off");
  if (/(all the way down|to (zero|0)|minimum volume|볼륨\s?(0|최소)|소리\s?(완전히\s?)?(끄|꺼))/.test(p) && /(volume|sound|볼륨|소리|음량|turn)/.test(p)) return ask(`osascript -e 'set volume output volume 0'`, "음량을 0%로 바꿀까요?", "Set the volume to 0%?", "volume 0");
  if (/(all the way up|max(imum)? volume|full volume|볼륨\s?최대|소리\s?최대)/.test(p)) return ask(`osascript -e 'set volume output volume 100'`, "음량을 100%로 바꿀까요?", "Set the volume to 100%?", "volume 100");
  if (/(\bsilence\b)/.test(p)) return ask(`osascript -e 'set volume with output muted'`, "음소거할까요?", "Mute?", "mute");
  if (/(음소거 해제|unmute)/.test(p)) return ask(`osascript -e 'set volume without output muted'`, "음소거를 해제할까요?", "Unmute?", "unmute");
  if (/(음소거|mute)/.test(p)) return ask(`osascript -e 'set volume with output muted'`, "음소거할까요?", "Mute?", "mute");
  const vol = /(볼륨|음량|volume)\D{0,12}(\d{1,3})/.exec(p);
  if (vol) { const n = Math.min(100, Number(vol[2])); return ask(`osascript -e 'set volume output volume ${n}'`, `음량을 ${n}%로 바꿀까요?`, `Set the volume to ${n}%?`, `volume ${n}`); }
  if (/(스크린\s?샷|화면\s?캡처|screenshot|screen ?(capture|grab))/.test(p)) {
    const out = freshPath(join(homedir(), "Desktop"), `Screenshot ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`, "OnBud", "png");
    return ask(`screencapture -x ${q(out)}`, `화면을 \`${basename(out)}\`로 저장할까요? (데스크탑)`, `Save the screen as \`${basename(out)}\` on the Desktop?`, "screenshot");
  }
  // relative volume ("make it louder", "소리 줄여줘"): ±15 of the current level
  const bright = /(brightness|밝기|screen (brighter|dimmer|darker)|(brighter|dimmer|darker) screen)/.test(p);
  if (!bright && /(louder|turn (it |the volume |the sound )?up|volume up|raise the volume|소리\s?(키워|올려|크게)|볼륨\s?(올려|키워|높여)|음량\s?(올려|키워|높여))/.test(p)) return ask(`osascript -e 'set volume output volume ((output volume of (get volume settings)) + 15)'`, "소리를 키울까요? (+15%)", "Turn the volume up (+15%)?", "volume_up");
  if (!bright && /(quieter|softer|turn (it |the volume |the sound )?down|volume down|lower the volume|소리\s?(줄여|낮춰|작게)|볼륨\s?(내려|줄여|낮춰)|음량\s?(내려|줄여|낮춰))/.test(p)) return ask(`osascript -e 'set volume output volume ((output volume of (get volume settings)) - 15)'`, "소리를 줄일까요? (−15%)", "Turn the volume down (−15%)?", "volume_down");
  // brightness: the brightness keys (works on built-in displays)
  if (/(brighter|brightness up|(increase|raise|turn up) (the |screen )?brightness|밝기\s?(올려|높여|키워)|화면\s?밝게)/.test(p)) return ask(`osascript -e 'tell application "System Events"' -e 'key code 144' -e 'key code 144' -e 'end tell'`, "화면을 더 밝게 할까요?", "Make the screen brighter?", "brightness_up");
  if (/(dimmer|\bdim\b|darker screen|screen (darker|dimmer)|brightness down|(decrease|lower|reduce|turn down) (the |screen )?brightness|밝기\s?(내려|낮춰|줄여)|화면\s?어둡게)/.test(p)) return ask(`osascript -e 'tell application "System Events"' -e 'key code 145' -e 'key code 145' -e 'end tell'`, "화면을 더 어둡게 할까요?", "Make the screen dimmer?", "brightness_down");
  if (/(lock (my |the )?(screen|mac|computer)|화면\s?잠가|화면\s?잠금|잠금\s?화면으로)/.test(p) && !/(단축키|shortcut|\bhow\b)/.test(p)) return ask(`osascript -e 'tell application "System Events" to keystroke "q" using {control down, command down}'`, "화면을 잠글까요?", "Lock the screen?", "lock_screen");
  // Wi-Fi and Bluetooth power
  const off = /(\boff\b|disable|disconnect|끄|꺼|해제|끊어)/.test(p), on = /(\bon\b|enable|\bconnect\b|켜|연결)/.test(p);
  if (/(wi-?fi|와이\s?파이|무선\s?랜)/.test(p) && (on || off) && !/(비밀\s?번호|비번|암호|password|설정\s?(열|보여)|settings)/.test(p)) {
    const st = off ? "off" : "on";
    return ask(`/usr/sbin/networksetup -setairportpower "$(/usr/sbin/networksetup -listallhardwareports | awk '/Wi-Fi|AirPort/{getline; print $2; exit}')" ${st}`, off ? "Wi-Fi를 끌까요?" : "Wi-Fi를 켤까요?", off ? "Turn Wi-Fi off?" : "Turn Wi-Fi on?", `wifi_${st}`);
  }
  if (/(bluetooth|블루투스)/.test(p) && (on || off) && !/(설정\s?(열|보여)|settings)/.test(p)) {
    const st = off ? "off" : "on";
    const bu = ["/opt/homebrew/bin/blueutil", "/usr/local/bin/blueutil"].find((x) => existsSync(x));
    if (bu) return ask(`${bu} --power ${off ? 0 : 1}`, off ? "블루투스를 끌까요?" : "블루투스를 켤까요?", off ? "Turn Bluetooth off?" : "Turn Bluetooth on?", `bluetooth_${st}`);
    if (process.env.ONBUD_DRY_ACTIONS !== "1") await run("/usr/bin/open", ["x-apple.systempreferences:com.apple.BluetoothSettings"]);
    return { verified: true, detail: "bluetooth_pane", answer: T(c.ko, `macOS에는 블루투스를 켜고 끄는 기본 명령이 없어서 **시스템 설정 › Bluetooth**를 열었어요. 스위치를 눌러 ${off ? "끄세요" : "켜세요"}. (\`brew install blueutil\`을 설치하면 다음부터 바로 바꿔 드려요.)`, `macOS has no built-in command for Bluetooth power, so I opened **System Settings › Bluetooth**; flip the switch there. (With \`brew install blueutil\` I can switch it directly next time.)`) };
  }
  // Finder: empty the Trash (cannot be undone), hidden files
  if (/((empty|wipe) (the |my )?trash|clear (out )?(the |my )?trash|휴지통\s?비워)/.test(p) && !/(단축키|shortcut|\bhow\b)/.test(p)) return ask(`osascript -e 'tell application "Finder" to empty trash'`, "휴지통을 비울까요? **되돌릴 수 없어요.**", "Empty the Trash? **This cannot be undone.**", "empty_trash");
  if (/(hidden files|숨김\s?파일|숨긴\s?파일)/.test(p) && !/(단축키|shortcut|\bhow\b)/.test(p)) {
    // Finder's own ⇧⌘. toggle (no `defaults write` + `killall Finder`, which the command gate refuses)
    const hide = /(hide|숨겨|안\s?보이게|끄)/.test(p);
    return ask(`osascript -e 'tell application "Finder" to activate' -e 'tell application "System Events" to keystroke "." using {command down, shift down}'`,
      `Finder에서 숨김 파일 표시를 ${hide ? "끌까요" : "켤까요"}? (Finder의 ⇧⌘. 전환과 같아요. 이미 그 상태면 반대로 바뀌어요)`,
      `${hide ? "Hide" : "Show"} hidden files in Finder? (Same as Finder's ⇧⌘. toggle; if it is already that way, it flips back.)`, hide ? "hidden_hide" : "hidden_show");
  }
  // quit an app (it may ask to save its documents)
  const quit = /^(?:quit|close|exit|kill|force quit|shut down)\s+(?:the\s+)?(.+?)(?:\s+app)?$/i.exec(plainEn(c.prompt)) ?? /^(.+?)\s*(?:앱|어플)?\s*(?:을|를)?\s*(?:종료해|꺼|닫아)\s*(?:줘|주세요)?$/.exec(c.prompt.trim().replace(/[.!?]+$/, ""));
  if (quit && !/(window|창|tab|탭|terminal session|세션)/i.test(quit[1])) {
    const A = await import("../context-builder/apps.ts");
    const r = await A.findInstalledApp(quit[1].trim());
    if (r.app) return ask(`osascript -e ${q(`tell application "${r.app.name.replace(/"/g, "")}" to quit`)}`, `**${r.app.name}**을(를) 종료할까요? (저장하지 않은 문서가 있으면 앱이 물어봐요)`, `Quit **${r.app.name}**? (It asks about unsaved documents.)`, `quit ${r.app.name}`);
    if (/^(quit|kill|force quit|exit)\b/i.test(plainEn(c.prompt)) && quit[1].split(/\s+/).length <= 3)
      return { verified: true, detail: "quit_no_app", answer: T(c.ko, `"${quit[1].trim()}"라는 앱을 찾지 못했어요. 앱 이름을 확인해 주세요.`, `No installed app matches "${quit[1].trim()}"; check the app's name.`) };
  }
  if (/(클립보드|clipboard)/.test(p)) {
    const r = await run("/usr/bin/pbpaste", []);
    const text = redact(r.out).text.slice(0, 2000);
    return { answer: text.trim() ? T(c.ko, "클립보드 내용 (저장하지 않아요):", "Clipboard (not stored):") + "\n\n```\n" + text + "\n```" : T(c.ko, "클립보드에 텍스트가 없어요.", "The clipboard has no text."), verified: true, detail: `clipboard ${text.length} chars` };
  }
  return { answer: "", verified: false, detail: "no_action", declined: true };
}

// ---------------------------------------------------------------- browser_tab
export async function browserTab(c: TaskCtx): Promise<TaskResult> {
  const apps = /chrome|크롬/i.test(c.prompt) ? ["Google Chrome"] : /safari|사파리/i.test(c.prompt) ? ["Safari"] : ["Safari", "Google Chrome"];
  for (const app of apps) {
    const script = app === "Safari"
      ? `if application "Safari" is running then tell application "Safari" to return (URL of front document) & linefeed & (name of front document)`
      : `if application "Google Chrome" is running then tell application "Google Chrome" to return (URL of active tab of front window) & linefeed & (title of active tab of front window)`;
    const r = await run("/usr/bin/osascript", ["-e", script], 10_000);
    const [url, title] = r.out.trim().split("\n");
    if (r.code === 0 && url) return { answer: `**${title ?? ""}**\n${url}\n\n_${T(c.ko, `${app}의 현재 탭. 페이지 내용이 필요하면 웹 검색 승인 후 읽어요.`, `${app}'s current tab. To read the page, approve a web step.`)}_`, verified: true, detail: app };
    if (/not allowed|-1743/.test(r.err)) return { answer: T(c.ko, `${app} 제어 권한이 없어요. 시스템 설정 > 개인정보 보호 및 보안 > 자동화에서 허용해 주세요.`, `No permission to read ${app}. Allow it in System Settings > Privacy & Security > Automation.`), verified: false, detail: "no_permission" };
  }
  return { answer: T(c.ko, "열려 있는 Safari나 Chrome 창이 없어요.", "No Safari or Chrome window is open."), verified: true, detail: "none_open" };
}

// ---------------------------------------------------------------- personal
export interface PimSource { events(days: number): Promise<any[] | { error: string }>; reminders(): Promise<any[] | { error: string }> }
export const pimSource: PimSource = {
  async events(days) { const b = await helper("pim"); if (!b) return { error: "no helper" }; const r = await run(b, ["events", String(days)], 30_000); try { return JSON.parse(r.out); } catch { return { error: r.err.trim() || "failed" }; } },
  async reminders() { const b = await helper("pim"); if (!b) return { error: "no helper" }; const r = await run(b, ["reminders"], 30_000); try { return JSON.parse(r.out); } catch { return { error: r.err.trim() || "failed" }; } },
};

export async function personal(c: TaskCtx, src: PimSource = pimSource): Promise<TaskResult> {
  const p = c.prompt.toLowerCase();
  const rem = /(미리\s?알림|리마인더|reminders?|할 일|to-?dos?)/.test(p);
  const days = /(이번\s?주|this week|일주일|week)/.test(p) ? 7 : /(내일|tomorrow)/.test(p) ? 2 : 1;
  const res = rem ? await src.reminders() : await src.events(days);
  if (!Array.isArray(res)) {
    const denied = /denied/.test(res.error);
    return { answer: denied ? T(c.ko, "캘린더/미리 알림 접근이 허용되지 않았어요. 시스템 설정 > 개인정보 보호 및 보안에서 허용해 주세요.", "Access to Calendar/Reminders was not allowed. Allow it in System Settings > Privacy & Security.") : T(c.ko, `읽지 못했어요: ${res.error}`, `Could not read them: ${res.error}`), verified: false, detail: denied ? "denied" : "failed" };
  }
  const fmt = (iso: string) => (iso ? new Date(iso).toLocaleString(c.ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const rows = rem ? res.map((r: any) => `- ${r.title}${r.due ? ` — ${fmt(r.due)}` : ""} _(${r.list})_`) : res.map((e: any) => `- ${e.allDay ? T(c.ko, "종일", "all day") : fmt(e.start)} **${e.title}**${e.location ? ` · ${e.location}` : ""} _(${e.calendar})_`);
  const head = rem ? T(c.ko, `미리 알림 ${res.length}개`, `${res.length} reminders`) : T(c.ko, `${days === 1 ? "오늘" : days === 2 ? "내일까지" : "이번 주"} 일정 ${res.length}개`, `${res.length} events ${days === 1 ? "today" : days === 2 ? "through tomorrow" : "this week"}`);
  // only the count leaves this function in the detail (telemetry): never titles
  return { answer: `${head}${T(c.ko, " (이 Mac에서만 읽고, 저장하지 않아요)", " (read on this Mac, not stored)")}:\n\n${rows.join("\n") || "-"}`, verified: true, detail: `${rem ? "reminders" : "events"} ${res.length}` };
}
