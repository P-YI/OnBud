// "Find my file" across the home folder: names only, on-device only, results go to the user and
// nowhere else (no memory note, no Codex hand-off, telemetry stores counts, not paths).
//   1. Spotlight (mdfind) by file name — fast, covers indexed folders.
//   2. Hidden folders (~/.cache, ~/.config, …) are not indexed by Spotlight, so a bounded `find`
//      walks them (and the hidden folders of the open project) by name.
// Secret locations (.ssh, keychains, tokens, shell history, ~/Library, …) are never listed.
// Each hit links to its folder (file:// URL → opens in Finder) and can be revealed with `open -R`.

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { gatePath } from "../security/gate.ts";
import { humanSize, kindOf } from "./documents.ts";

export interface Found { path: string; dir: boolean; bytes: number; modified: string; hidden: boolean }

// Places a name search must not reveal, on top of the gate's secret paths.
const PRIVATE = /(^|\/)(\.Trash|Library|\.[A-Za-z_]*history[^/]*|[^/]*(token|cookie|password|passwd|secret)[^/]*|\.codex\/(auth|sessions)[^/]*|\.claude\.json[^/]*|\.claude\/(projects|shell-snapshots)|\.local\/share\/opencode|OpenAFM\/config|\.git)(\/|$)/i;
const SKIP_DIRS = ["node_modules", ".git", "__pycache__", ".venv", "venv", "site-packages", ".npm", ".Trash"];

export function isPrivate(abs: string, home = homedir()): boolean {
  const rel = abs.startsWith(home + "/") ? abs.slice(home.length + 1) : abs;
  return PRIVATE.test(rel) || gatePath(abs, home, "read").verdict === "deny";
}

const FIND_VERB = /(찾아|찾기|찾을|어디\s*(에\s*)?있|어딨|위치|경로\s*(알려|좀)|\bfind\b|\blocate\b|\bwhere('?s| is| are)\b|\bsearch for\b)/i;
const FILE_NOUN = /(파일|폴더|디렉토리|디렉터리|문서|논문|사진|이미지|슬라이드|발표|\bfiles?\b|\bfolders?\b|\bdirector(y|ies)\b|\bdocuments?\b|\bpdf\b|\bslides?\b|\bimages?\b|\bphotos?\b)/i;
const NAME_TOKEN = /(?:^|[\s`'"(])(\.[\w.-]{2,}|[\w-][\w.-]*\.[A-Za-z0-9]{1,6})(?=$|[\s`'")?,])/g;

/** Is this a request to locate files or folders by name (not a code-definition search)? */
export function isFindRequest(prompt: string): boolean {
  if (!FIND_VERB.test(prompt)) return false;
  if (/\b(defined|definition|implemented|called|used)\b|정의|구현|호출/.test(prompt)) return false;
  return FILE_NOUN.test(prompt) || [...prompt.matchAll(NAME_TOKEN)].length > 0;
}

/** Name terms stated literally in the request: quoted text, dot-folders, file names. */
export function literalTerms(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/["'`“”‘’]([^"'`“”‘’\n]{2,60})["'`“”‘’]/g)) out.add(m[1].trim());
  for (const m of prompt.matchAll(NAME_TOKEN)) out.add(m[1]);
  return [...out].filter((t) => !/^\.{1,2}$/.test(t)).slice(0, 3);
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((res) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } },
      (_err, stdout) => res(String(stdout ?? "")));   // partial output on timeout is still useful
    child.stdin?.end();
  });
}

const escapeMd = (s: string) => s.replace(/(["\\])/g, "\\$1");

/** Spotlight name search under `scope` (case- and diacritic-insensitive substring). */
async function spotlightNames(term: string, scope: string, max: number): Promise<string[]> {
  const q = `kMDItemFSName == "*${escapeMd(term)}*"cd`;
  const out = await run("/usr/bin/mdfind", ["-onlyin", scope, q], 6000);
  return out.split("\n").filter(Boolean).slice(0, max * 4);
}

/** Bounded walk of hidden folders (Spotlight skips them). */
async function hiddenNames(term: string, roots: string[], max: number): Promise<string[]> {
  if (!roots.length) return [];
  const prune = SKIP_DIRS.flatMap((d, i) => [...(i ? ["-o"] : []), "-name", d]);
  const args = [...roots, "-maxdepth", "4", "(", ...prune, ")", "-prune", "-o", "-iname", `*${term}*`, "-print"];
  const out = await run("/usr/bin/find", args, 6000);
  return out.split("\n").filter(Boolean).slice(0, max * 4);
}

/** Top-level hidden folders of `dir` worth searching (not secret, not private, not huge caches of others). */
export function hiddenRoots(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(".") && e.isDirectory() && !SKIP_DIRS.includes(e.name))
      .map((e) => join(dir, e.name))
      .filter((p) => !isPrivate(p));
  } catch { return []; }
}

export type FindKind = "any" | "folder" | "pdf" | "word" | "slides" | "sheet" | "image" | "code" | "text";

/** File type the request asks for, if any ("pdf 파일", "폴더", "slides" …). */
export function kindFromPrompt(prompt: string): FindKind {
  const p = prompt.toLowerCase();
  if (/\bpdf\b|논문/.test(p)) return "pdf";
  if (/폴더|디렉토리|디렉터리|\bfolders?\b|\bdirector(y|ies)\b/.test(p)) return "folder";
  if (/슬라이드|발표|\bslides?\b|pptx?|keynote/.test(p)) return "slides";
  if (/엑셀|스프레드시트|\bxlsx?\b|spreadsheet/.test(p)) return "sheet";
  if (/사진|이미지|\bimages?\b|\bphotos?\b|png|jpe?g/.test(p)) return "image";
  if (/워드|\bdocx?\b|\bword\b|한글 문서|hwp/.test(p)) return "word";
  return "any";
}

const STOP_WORDS = new Set(["find", "file", "files", "folder", "folders", "directory", "where", "the", "is", "are", "my", "a", "an", "for", "search", "locate",
  "pdf", "document", "documents", "slides", "image", "images", "photo", "photos", "please", "me", "can", "you", "named", "called", "in", "on", "mac", "this"]);

/** Name-like words without asking a model: literal terms, else Latin words that are not request words. */
export function nameTerms(prompt: string): string[] {
  const lit = literalTerms(prompt);
  if (lit.length) return lit;
  return (prompt.match(/[A-Za-z0-9][A-Za-z0-9_.-]{2,}/g) ?? []).filter((w) => !STOP_WORDS.has(w.toLowerCase())).slice(0, 3);
}

export async function findByName(terms: string[], opts: { scope?: string; project?: string; max?: number; kind?: FindKind } = {}): Promise<Found[]> {
  const home = homedir();
  const scope = opts.scope ?? home;
  const max = opts.max ?? 15;
  const seen = new Map<string, Found>();
  const add = (abs: string) => {
    if (seen.has(abs) || seen.size >= max * 6 || isPrivate(abs, home)) return;
    try {
      const st = statSync(abs);
      seen.set(abs, { path: abs, dir: st.isDirectory(), bytes: st.size, modified: st.mtime.toISOString().slice(0, 10), hidden: /\/\./.test(abs.slice(home.length)) });
    } catch { /* vanished or not readable */ }
  };
  for (const term of terms.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 3)) {
    const bare = term.replace(/^\*+|\*+$/g, "");
    // A dot-folder named exactly (".cache") is usually right under home or the project.
    if (bare.startsWith(".")) for (const base of [home, opts.project].filter(Boolean) as string[]) add(join(base, bare));
    const [spot, hidden] = await Promise.all([
      spotlightNames(bare, scope, max),
      hiddenNames(bare, [...hiddenRoots(home), ...(opts.project ? hiddenRoots(opts.project) : [])], max),
    ]);
    for (const p of [...spot, ...hidden]) add(p);
  }
  // Exact name, then name starts with the term, then shorter names (less noise), then newest.
  const lc = terms.map((t) => t.toLowerCase().normalize("NFC"));
  const rank = (f: Found) => {
    const n = basename(f.path).toLowerCase().normalize("NFC");
    const stem = n.replace(/\.[^.]+$/, "");
    return lc.some((t) => n === t || stem === t) ? 0 : lc.some((t) => n.startsWith(t)) ? 1 : 2;
  };
  const inPath = (f: Found) => lc.filter((t) => f.path.toLowerCase().normalize("NFC").includes(t)).length;   // all terms matched beats one
  const kind = opts.kind ?? "any";
  return [...seen.values()]
    .filter((f) => kind === "any" || (kind === "folder" ? f.dir : !f.dir && kindOf(f.path) === kind))
    .sort((a, b) => inPath(b) - inPath(a) || rank(a) - rank(b) || basename(a.path).length - basename(b.path).length || b.modified.localeCompare(a.modified))
    .slice(0, max);
}

export const fileUrl = (abs: string, dir = false) => "file://" + encodeURI(abs + (dir && !abs.endsWith("/") ? "/" : "")).replace(/[()#?]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Markdown list: name, a link to the folder that holds it (opens Finder), size and date. */
export function renderFound(found: Found[], terms: string[], ko: boolean): string {
  const home = homedir();
  const short = (p: string) => (p.startsWith(home + "/") ? "~/" + relative(home, p) : p).normalize("NFC");
  if (!found.length) {
    return ko
      ? `"${terms.join('", "')}" 이름의 파일이나 폴더를 찾지 못했어요. 이름 일부만 다시 알려 주세요 (예: 확장자 빼고).`
      : `No files or folders named like "${terms.join('", "')}". Try part of the name (e.g. without the extension).`;
  }
  const rows = found.map((f, i) => {
    const folder = f.dir ? f.path : dirname(f.path);
    const what = f.dir ? (ko ? "폴더" : "folder") : `${kindOf(f.path)}, ${humanSize(f.bytes)}`;
    return `${i + 1}. **${basename(f.path).normalize("NFC")}**${f.hidden ? (ko ? " (숨김)" : " (hidden)") : ""} — ${what}, ${f.modified}\n   [${short(folder)}](${fileUrl(folder, true)})`;
  });
  const tail = ko
    ? `\n\n링크를 누르면 Finder에서 해당 폴더가 열려요. 링크가 열리지 않으면 번호로 답해 주세요 (예: \`1\`) — Finder에서 그 항목을 선택해서 보여 드려요.`
    : `\n\nClick a link to open the folder in Finder. If links do not open, reply with a number (e.g. \`1\`) and I will reveal that item in Finder.`;
  return (ko ? `"${terms.join('", "')}" 검색 결과 (${found.length}개, 이름 기준, 이 Mac 안에서만 검색):\n\n` : `Results for "${terms.join('", "')}" (${found.length}, by name, searched on this Mac only):\n\n`) + rows.join("\n") + tail;
}

/** Reveal one path in Finder (selects it in its folder). Only paths this finder returned are accepted by the caller. */
export function revealInFinder(abs: string): Promise<boolean> {
  return new Promise((res) => execFile("/usr/bin/open", ["-R", abs], { timeout: 5000 }, (err) => res(!err)));
}
