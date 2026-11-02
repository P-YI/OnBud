// Local skills (2026-10-31): developer and text tasks the on-device model can do well when code does the rest.
// Pattern, as for documents/LaTeX/jobs: code gathers exactly the right input (git, a parsed traceback, the file's
// text), AFM fills a small schema, code checks the answer against the source and renders it. Nothing is written
// without the usual approval: docstrings come back as an edit proposal, CSV↔JSON as a command to approve.
//   commit_message   staged diff (or the working tree) → subject ≤ 72 chars + bullets
//   change_summary   git status + per-file diff → one line per changed file (every file listed by code)
//   release_notes    git log → bullets (deterministic), AFM writes only the one-line headline
//   error_triage     last traceback in a log → exception, project file:line and code (parsed), AFM: cause and fix
//   extract_table    action items → table; owner and due date must appear in the source text
//   translate        paragraph by paragraph, Markdown and code kept; the target script is checked
//   docstrings       Python ast finds functions without one; AFM writes them; code unchanged is verified (ast)
//   privacy_scan     regex detectors (email, phone, RRN, card with Luhn, IP, secrets); Decima flags names/addresses
//   csv_json         deterministic converter (python3 csv/json), run after approval
//   sheet_lookup     xlsx/csv lookups over every row: group heading rows understood (sheets.ts); AFM only picks columns
//   slides_outline   pptx titles in presentation order, slide count, or the Nth slide verbatim (code only)
//   git_overview     branch, upstream ahead/behind, worktrees, stash, branches (code); git fetch only after approval
//   open_app         a terminal (in the folder, or attached to a background session) or a file in the user's own app:
//                    named in the request, ~/OpenAFM/config/apps.json, or the macOS default (apps.ts)
//   security_check   secrets in the project (git state), credential files and shell history, system security
//                    settings and exposed ports; all decided in code, values masked (security-check.ts)
//   mac_health       this Mac's status from its own tools (mac-health.ts); no project folder needed, nothing leaves the Mac
//   github_status    open PRs, this branch's PR and checks, recent workflow runs, issues: gh read-only, signed-in user
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { readDocument } from "../context-builder/documents.ts";
import { candidateTerms, lookup, missingNames, norm, readTable, type Match } from "../context-builder/sheets.ts";
import type { DecimaClient } from "../laya-router/decima.ts";
import { redact } from "../security/gate.ts";
import { sha, type EditProposal } from "./edit-loop.ts";
import { projectFiles } from "./jobs.ts";

export type LocalSkill = "commit_message" | "change_summary" | "release_notes" | "error_triage" | "extract_table" | "translate" | "docstrings" | "privacy_scan" | "csv_json" | "sheet_lookup" | "slides_outline" | "git_overview" | "github_status" | "mac_health" | "open_app" | "security_check";
export interface SkillContext { afm: AFMProvider; root: string; prompt: string; files: { path: string }[]; ko: boolean; history?: string; decima?: DecimaClient; timeoutMs?: number }
export interface SkillResult { answer: string; verified: boolean; pendingEdit?: { edit: EditProposal; testCmd?: string }; pendingCommand?: string; detail: string; declined?: boolean }   // declined: not this skill after all; the controller goes on

const LOG_EXT = /\.(log|txt|out|err)$/i;
// Repository state questions (not how-to questions, not requests to change anything: those go to help or a job).
const GIT_STATE = /((git|깃|저장소|레포|\brepo\b|브랜치|\bbranch(es)?\b).{0,20}(상태|상황|현황|status|state|overview)|worktrees?|워크\s?트리|(원격|remote|origin|upstream|github|깃허브).{0,30}(비교|차이|다른|다르|다릅|앞서|뒤처|뒤쳐|동기화|최신|compare|differ|sync|ahead|behind|up to date)|\b(ahead|behind)\b.{0,20}\b(origin|remote|upstream)\b|(push|pull|푸시).{0,20}(전에|before|해야|need|필요))/i;
const GIT_HOWTO = /(사용법|명령어|어떻게\s?(써|사용|만들|하는|해)|how (do|to|can) i|usage|syntax|뭐야|what is|what does|만들어|추가해|생성해|삭제해|제거해|지워|create|remove|delete|prune)/i;
// GitHub (pull requests, checks, workflow runs, issues): read with the signed-in gh CLI, never written.
const GH_REQ = /(\bPRs?\b|pull requests?|풀\s?리퀘(스트)?|\bCI\b|github actions|workflow runs?|워크플로|(github|깃허브).{0,20}(이슈|issues?|체크|checks?|리뷰|reviews?|상태|status|빌드|build))/i;
const SLIDE_NTH = /(\d+)\s?(번째|번|쪽|페이지|장)\s?(슬라이드|페이지|장)?|(첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s?번째|\bslide\s?#?(\d+)\b|\b(\d+)(st|nd|rd|th) slide\b|\b(first|second|third|fourth|fifth|last) slide\b|마지막\s?(슬라이드|장)/i;
const SECURITY_CHECK = /((보안|security)\s?.{0,10}(점검|검사|진단|취약|감사|check|audit|scan|review)|(비밀번호|암호|패스워드|password|api\s?키|키|토큰|token|secrets?|시크릿|자격\s?증명|credentials?)\S*\s?.{0,12}(유출|노출|새|leak|exposed|exposure|점검|검사|스캔|scan)|secret scan|vulnerabilit|취약점|\b(leak(ed|s)?|exposed|hard-?coded)\s+(api\s)?(secrets?|keys?|tokens?|passwords?|credentials?))/i;
const OPEN_TERMINAL = /((터미널|terminal|iterm2?|아이텀|셸|warp|ghostty)[^\n?]{0,15}(열어|띄워|켜\s?줘|열기)|\b(open|launch|start)\s+(a\s+|the\s+|new\s+)*(terminal|shell|iterm2?)\b|\b(open|show|attach)\b.{0,25}\bsession\b.{0,25}\b(terminal|iterm)|(세션|session)\S*.{0,20}(터미널|iterm|아이텀)\S*.{0,10}(열어|띄워|붙어|attach|보여))/i;
const OPEN_EDITOR = /((에디터|편집기|editor|vs\s?code|cursor|zed|textedit|커서)\S*\s?(에서|으로|로)?\s?(열어|띄워)|\bopen\b.{0,40}\b(in|with)\s+(my\s+)?(editor|vs\s?code|cursor|zed|textedit)\b)/i;
const MAC_HEALTH = /((맥|맥북|mac|macbook|시스템|컴퓨터|노트북|기기).{0,12}(상태|점검|진단|건강|헬스|이상|문제)|(배터리|저장\s?공간|디스크|메모리|발열|보안\s?설정).{0,8}(상태|점검|확인|어때|괜찮)|\b(system|mac|macbook|computer)\b.{0,15}\b(health|status|check-?up|diagnostics?)\b|\bhealth check\b)/i;
const SHEET_EXT = /\.(xlsx|xlsm|csv|tsv)$/i;
const TEXT_EXT = /\.(md|markdown|txt|rst|tex|org|html?|csv|log|pdf|docx?|pptx?|rtf|pages)$/i;

/** Which local skill a request asks for (rules only; undefined = not one of these). */
export function detectLocalSkill(prompt: string, files: { path: string }[]): LocalSkill | undefined {
  const p = prompt;
  const has = (re: RegExp) => files.some((f) => re.test(f.path));
  // A message to write, not a question about existing commits ("What are the 3 most recent commit messages?").
  if (/(커밋\s?메시지|commit\s+message)/i.test(p) && /(써|작성|만들|추천|제안|지어|write|draft|suggest|generate|propose|create)/i.test(p) && !/(최근|이전|지난|마지막|recent|last|previous|past|history)/i.test(p)) return "commit_message";
  if (/(릴리[스즈]\s?노트|release\s+notes?|changelog|변경\s?이력)/i.test(p)) return "release_notes";
  if ((/((변경\s?사항|변경된|바뀐|수정된|uncommitted|working tree|changes|diff).{0,30}(요약|정리|설명|summar|overview|describe))|(summari[sz]e|describe).{0,30}(changes|diff)/i.test(p)
      || /(what (did|have) (i|we) (change|changed|modif)|since the last commit|마지막 커밋 (이후|뒤|다음)|(뭘|뭐|무엇을?) (바꿨|고쳤|수정했))/i.test(p)) && !files.some((f) => !LOG_EXT.test(f.path) && TEXT_EXT.test(f.path))) return "change_summary";
  if (SECURITY_CHECK.test(p) && !GIT_HOWTO.test(p)) return "security_check";
  if (OPEN_TERMINAL.test(p) || (OPEN_EDITOR.test(p) && files.length)) return "open_app";
  if (MAC_HEALTH.test(p) && !GIT_HOWTO.test(p)) return "mac_health";
  if (GH_REQ.test(p)) return "github_status";
  if (GIT_STATE.test(p) && !GIT_HOWTO.test(p)) return "git_overview";
  if (/(docstring|독스트링|문서화\s?주석)/i.test(p) && /(추가|달아|넣어|써|작성|add|write|generate)/i.test(p) && has(/\.py$/)) return "docstrings";
  if (/\.csv\b/i.test(p) && /\bjson\b/i.test(p) && /(변환|바꿔|저장|만들어|convert|export|save|write)/i.test(p)) return "csv_json";
  if (/(개인\s?정보|민감한?\s?정보|\bPII\b|personal (data|info)|sensitive|privacy|외부.{0,10}공유|(공유|전송|보내|올려|첨부)해?도\s?(될|돼|되|괜찮)|safe to (share|send|post))/i.test(p) && has(TEXT_EXT)) return "privacy_scan";
  if (/(영어|영문|English|한국어|한글|Korean|일본어|Japanese|중국어|Chinese)(로|으로)\s?(번역|옮겨)|translate\b.{0,60}\b(to|into)\s+(English|Korean|Japanese|Chinese)/i.test(p) && has(TEXT_EXT)) return "translate";
  if (has(/\.pptx$/i) && (SLIDE_NTH.test(p) || /(제목|목차|개요|아웃라인|구성|순서|몇\s?장|슬라이드\s?(목록|수|개수)|outline|titles?|agenda|table of contents|how many slides)/i.test(p))) return "slides_outline";
  if (has(SHEET_EXT) && !/(요약|개요|구조|설명해|summar|overview|describe|structure)/i.test(p)) return "sheet_lookup";
  if (has(LOG_EXT) && /(에러|오류|error|exception|traceback|원인|cause|crash|실패|fail|왜)/i.test(p)) return "error_triage";
  if (/(Traceback \(most recent call last\)|^\s*File ".+", line \d+)/m.test(p)) return "error_triage";
  if (has(TEXT_EXT) && /(할\s?일|담당|마감|action items?|to-?dos?|deadlines?|owners?)/i.test(p) && /(표|테이블|table|목록|list|정리|추출|extract)/i.test(p)) return "extract_table";
  return undefined;
}

// ---------------------------------------------------------------- helpers
function run(cmd: string, args: string[], cwd: string, input?: string, timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: process.env.HOME ?? "", LANG: "en_US.UTF-8", GIT_TERMINAL_PROMPT: "0" } },
      (err: any, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: String(stdout ?? "") + (err ? String(stderr ?? "") : "") }));
    if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
  });
}
const git = (root: string, ...a: string[]) => run("git", ["-c", "core.quotepath=off", ...a], root);
const hangulShare = (s: string) => (s.match(/[가-힣]/g)?.length ?? 0) / Math.max(1, s.replace(/[\s\d\p{P}]/gu, "").length);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…" : s);
async function ask<T>(c: SkillContext, system: string, user: string, schema: object, maxTokens = 600): Promise<T | undefined> {
  const r = await c.afm.generate({ system, user, schema: schema as any, maxTokens, timeoutMs: c.timeoutMs ?? 60_000 });
  return r.ok ? (r.json as T) : undefined;
}
async function text(c: SkillContext, rel: string, maxChars = 20_000): Promise<string | undefined> {
  const d = await readDocument(c.root, rel, { maxChars });
  return d.error ? undefined : redact(d.text).text;
}
const str = (s: unknown) => (typeof s === "string" ? s.trim() : "");

export async function runLocalSkill(skill: LocalSkill, c: SkillContext): Promise<SkillResult> {
  switch (skill) {
    case "commit_message": return commitMessage(c);
    case "change_summary": return changeSummary(c);
    case "release_notes": return releaseNotes(c);
    case "error_triage": return errorTriage(c);
    case "extract_table": return extractTable(c);
    case "translate": return translate(c);
    case "docstrings": return docstrings(c);
    case "privacy_scan": return privacyScan(c);
    case "csv_json": return csvJson(c);
    case "sheet_lookup": return sheetLookup(c);
    case "slides_outline": return slidesOutline(c);
    case "git_overview": return gitOverview(c);
    case "github_status": return githubStatus(c);
    case "open_app": return openApp(c);
    case "security_check": { const { securityCheckAnswer } = await import("./security-check.ts"); const r = await securityCheckAnswer(c.root || undefined, c.ko); return { ...r, verified: true }; }
    case "mac_health": { const { macHealthAnswer } = await import("./mac-health.ts"); const r = await macHealthAnswer(c.ko); return { ...r, verified: true }; }
  }
}

// ---------------------------------------------------------------- git
async function commitMessage(c: SkillContext): Promise<SkillResult> {
  let diff = (await git(c.root, "diff", "--cached", "--no-color", "-U3")).out, staged = true;
  if (!diff.trim()) { diff = (await git(c.root, "diff", "--no-color", "-U3")).out; staged = false; }
  if (!diff.trim()) return { answer: c.ko ? "커밋할 변경사항이 없어요 (스테이징된 것도, 작업 중인 것도 없음)." : "Nothing to commit: no staged or unstaged changes.", verified: true, detail: "no_changes" };
  const stat = (await git(c.root, "diff", ...(staged ? ["--cached"] : []), "--stat")).out.trim();
  const recent = (await git(c.root, "log", "-8", "--format=%s")).out;
  const koRepo = hangulShare(recent) > 0.3;
  const j = await ask<{ subject: string; body: string[] }>(c,
    `Write a git commit message for this diff${koRepo ? " in Korean" : " in English"}. Subject: imperative mood, at most 60 characters, says what changed and why; no file list, no trailing period. Body: 0 to 3 short bullets with notable details. Describe only what the diff shows.`,
    `DIFF STAT:\n${stat}\n\nDIFF:\n${clip(redact(diff).text, 6000)}`,
    { type: "object", properties: { subject: { type: "string" }, body: { type: "array", items: { type: "string" } } }, required: ["subject", "body"], additionalProperties: false });
  let subject = str(j?.subject).replace(/\.$/, "").split("\n")[0];
  if (!subject) return { answer: c.ko ? "커밋 메시지를 만들지 못했어요." : "Could not write a commit message.", verified: false, detail: "afm_failed" };
  if (subject.length > 72) subject = subject.slice(0, 72).replace(/\s+\S*$/, "");
  const body = (j?.body ?? []).map(str).filter(Boolean).slice(0, 3);
  const msg = `${subject}${body.length ? `\n\n${body.map((b) => `- ${b.replace(/^[-*]\s*/, "")}`).join("\n")}` : ""}`;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `git commit -m ${q(subject)}${body.length ? ` -m ${q(body.map((b) => `- ${b.replace(/^[-*]\s*/, "")}`).join("\n"))}` : ""}`;
  return { verified: true, detail: staged ? "staged" : "working_tree",
    answer: (c.ko ? `${staged ? "스테이징된" : "아직 스테이징되지 않은"} 변경 기준 커밋 메시지 제안:\n\n` : `Suggested commit message (${staged ? "staged" : "unstaged"} changes):\n\n`)
      + "```\n" + msg + "\n```\n\n```\n" + stat + "\n```\n\n" + (c.ko ? `이 메시지로 커밋하려면: \`${cmd}\`` : `To commit with it: \`${cmd}\``) };
}

async function changeSummary(c: SkillContext): Promise<SkillResult> {
  // -uall lists the files inside new folders; plain --porcelain names the new folders themselves ("apps/x/").
  const parse = (out: string) => out.split("\n").filter(Boolean).map((l) => ({ code: l.slice(0, 2).trim(), path: l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "") }));
  const st = parse((await git(c.root, "status", "--porcelain", "-uall")).out);
  if (!st.length) return { answer: c.ko ? "커밋 안 된 변경사항이 없어요." : "No uncommitted changes.", verified: true, detail: "clean" };
  const newDirs = parse((await git(c.root, "status", "--porcelain")).out).filter((f) => f.code === "??" && f.path.endsWith("/")).map((f) => f.path);
  // One row per changed file, and one per new folder (its files counted, not listed one by one).
  type Item = { path: string; code: string; files?: string[] };
  const items: Item[] = [];
  for (const f of st) {
    const dir = f.code === "??" ? newDirs.find((d) => f.path.startsWith(d)) : undefined;
    if (!dir) { items.push(f); continue; }
    const it = items.find((x) => x.path === dir);
    if (it) it.files!.push(f.path); else items.push({ path: dir, code: "??", files: [f.path] });
  }
  const numstat = new Map((await git(c.root, "diff", "HEAD", "--numstat")).out.split("\n").filter(Boolean).map((l) => { const [a, d, ...p] = l.split("\t"); return [p.join("\t"), `+${a} −${d}`]; }));
  const isFile = (rel: string) => { try { return statSync(join(c.root, rel)).isFile(); } catch { return false; } };
  const head = (rel: string, n: number) => (isFile(rel) && statSync(join(c.root, rel)).size < 2_000_000 ? readFileSync(join(c.root, rel), "utf8").split("\n").slice(0, n).join("\n") : "");
  const DEF = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|func|struct|enum|protocol|interface|type|final class|actor)\s+([A-Za-z_][\w]*)/gm;
  // Size column, from code: lines added/removed, or the new file's length and definitions, or the folder's contents.
  const fact = (it: Item): string => {
    if (it.files) {
      const ext = new Map<string, number>();
      for (const f of it.files) ext.set(extname(f) || basename(f), (ext.get(extname(f) || basename(f)) ?? 0) + 1);
      return (c.ko ? `${it.files.length}개 파일` : `${it.files.length} files`) + ` (${[...ext].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${e} ${n}`).join(", ")})`;
    }
    if (it.code === "??") {
      const t = head(it.path, 100_000);
      const defs = [...t.matchAll(DEF)].map((m) => m[1]).slice(0, 4);
      return `${t.split("\n").length}${c.ko ? "줄" : " lines"}${defs.length ? ` · ${defs.join(", ")}` : ""}`;
    }
    return numstat.get(it.path) ?? (it.code === "D" ? (c.ko ? "삭제" : "deleted") : "");
  };
  const evidence = async (it: Item): Promise<string> => {
    if (it.files) {
      const key = it.files.filter((f) => /readme|package\.json|package\.swift|makefile|pyproject|cargo\.toml|main\./i.test(f)).slice(0, 2);
      return `(new folder, ${it.files.length} files: ${it.files.slice(0, 15).map((f) => f.slice(it.path.length)).join(", ")})\n${key.map((k) => `--- ${k}\n${head(k, 15)}`).join("\n")}`;
    }
    if (it.code === "??") return `(new file)\n${head(it.path, 30)}`;
    return (await git(c.root, "diff", "HEAD", "--no-color", "-U2", "--", it.path)).out;
  };
  // AFM in batches of four (one call for every file overflowed its output and lost all descriptions).
  const SCHEMA = { type: "object", properties: { files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, change: { type: "string" } }, required: ["path", "change"], additionalProperties: false } } }, required: ["files"], additionalProperties: false };
  const by = new Map<string, string>();
  const described = items.slice(0, 24);
  for (let i = 0; i < described.length; i += 4) {
    const batch = described.slice(i, i + 4);
    const parts = [];
    for (const it of batch) parts.push(`=== ${it.path} (${it.code === "??" ? "new" : it.code})\n${clip(redact(await evidence(it)).text, 1200)}`);
    const j = await ask<{ files: { path: string; change: string }[] }>(c,
      `For each of these ${batch.length} uncommitted changes, one short sentence${c.ko ? " in Korean" : ""} saying what changed or what the new file/folder is for (behaviour, not line counts). Use only what is shown. Paths: ${batch.map((x) => x.path).join(", ")}.`,
      parts.join("\n\n"), SCHEMA, 120 * batch.length + 80);
    for (const x of j?.files ?? []) {
      const k = str(x.path).replace(/^\.\//, "").replace(/\/$/, "");
      // Exact, a folder named with or without "/", a file inside a new folder, or the same file name.
      const it = batch.find((b) => b.path.replace(/\/$/, "") === k) ?? batch.find((b) => (b.files && k.startsWith(b.path)) || (!b.files && basename(b.path) === basename(k)));
      if (it && str(x.change)) by.set(it.path, str(x.change));
    }
  }
  // AFM often skips some of four large diffs: those are asked about one at a time (at most eight retries).
  for (const it of described.filter((x) => !by.has(x.path)).slice(0, 8)) {
    const j = await ask<{ change: string }>(c,
      `One short sentence${c.ko ? " in Korean" : ""}: what changed in ${it.path}, or what this new file/folder is for (behaviour, not line counts). Use only what is shown.`,
      clip(redact(await evidence(it)).text, 1800), { type: "object", properties: { change: { type: "string" } }, required: ["change"], additionalProperties: false }, 150);
    if (str(j?.change)) by.set(it.path, str(j!.change));
  }
  const label: Record<string, string> = c.ko ? { M: "수정", A: "추가", D: "삭제", R: "이름 변경", "??": "새 파일" } : { M: "modified", A: "added", D: "deleted", R: "renamed", "??": "new" };
  const kind = (it: Item) => (it.files ? (c.ko ? "새 폴더" : "new folder") : label[it.code] ?? it.code);
  const rows = items.map((it) => `| \`${it.path}\` | ${kind(it)} | ${(by.get(it.path) ?? "–").replace(/\|/g, "\\|")} | ${fact(it).replace(/\|/g, "\\|")} |`);
  let overall = "";
  if (by.size >= 2) {
    const j = await ask<{ overall: string }>(c, `One sentence${c.ko ? " in Korean" : ""}: what these uncommitted changes do together.`,
      [...by].map(([p, ch]) => `${p}: ${ch}`).join("\n"), { type: "object", properties: { overall: { type: "string" } }, required: ["overall"], additionalProperties: false }, 120);
    overall = str(j?.overall);
  }
  const note = items.length > described.length ? `\n\n_${c.ko ? `설명은 앞의 ${described.length}개 항목만 (AFM 호출 수 제한), 나머지는 규모만 표시` : `Descriptions for the first ${described.length} items (AFM call limit); the rest show size only`}._` : "";
  return { verified: true, detail: `${st.length} files, ${items.length} rows, ${by.size} described`,
    answer: `${overall ? `${overall}\n\n` : ""}| ${c.ko ? "파일 | 상태 | 변경 | 규모" : "File | Status | Change | Size"} |\n|---|---|---|---|\n${rows.join("\n")}${note}` };
}

async function releaseNotes(c: SkillContext): Promise<SkillResult> {
  const n = Math.min(50, Number(/(\d+)\s*(개|commits?)/i.exec(c.prompt)?.[1] ?? 10));
  const log = (await git(c.root, "log", `-${n}`, "--format=%h%x09%s%x09%ad", "--date=short")).out.split("\n").filter(Boolean).map((l) => { const [h, s, d] = l.split("\t"); return { h, s, d }; });
  if (!log.length) return { answer: c.ko ? "커밋이 없어요." : "No commits.", verified: true, detail: "no_commits" };
  const kind = (s: string) => (/\b(fix|bug|hotfix|patch)\b|수정|버그|고침/i.test(s) ? "fixed" : /\b(add|new|introduce|feat|implement|create)\b|추가|새|구현/i.test(s) ? "added" : "changed");
  const titles = c.ko ? { added: "추가", fixed: "수정", changed: "변경" } : { added: "Added", fixed: "Fixed", changed: "Changed" };
  const groups = (["added", "fixed", "changed"] as const).map((k) => [k, log.filter((x) => kind(x.s) === k)] as const).filter(([, xs]) => xs.length);
  const j = await ask<{ headline: string }>(c, `Write one short headline sentence${c.ko ? " in Korean" : ""} for release notes made of these commits. No version numbers or dates that are not in the list.`,
    log.map((x) => `- ${x.s}`).join("\n"), { type: "object", properties: { headline: { type: "string" } }, required: ["headline"], additionalProperties: false }, 120);
  const head = str(j?.headline) && !/\d+\.\d+/.test(str(j?.headline)) ? `${str(j?.headline)}\n\n` : "";
  return { verified: true, detail: `${log.length} commits`,
    answer: head + groups.map(([k, xs]) => `**${titles[k]}**\n${xs.map((x) => `- ${x.s} (\`${x.h}\`, ${x.d})`).join("\n")}`).join("\n\n") };
}

// ---------------------------------------------------------------- error triage
interface Frame { file: string; line: number; fn: string; code?: string }
export function parseTraceback(t: string): { exc?: string; msg?: string; frames: Frame[] } | undefined {
  const i = t.lastIndexOf("Traceback (most recent call last)");
  if (i < 0) return undefined;
  const lines = t.slice(i).split("\n");
  const frames: Frame[] = [];
  let k = 1;
  for (; k < lines.length; k++) {
    const m = /^\s*File "(.+)", line (\d+), in (.+)$/.exec(lines[k]);
    if (!m) break;
    const code = lines[k + 1] && !/^\s*File "/.test(lines[k + 1]) ? lines[k + 1].trim() : undefined;
    frames.push({ file: m[1], line: Number(m[2]), fn: m[3].trim(), code });
    if (code) k++;
  }
  const em = /^([\w.]+(?:Error|Exception|Warning|Exit|Interrupt))(?::\s*(.*))?$/.exec((lines.slice(k).find((l) => l.trim()) ?? "").trim());
  return { exc: em?.[1], msg: em?.[2], frames };
}
/** Project file for a path from another machine (/srv/app/src/stats.py → src/stats.py): longest matching suffix. */
function projectPath(root: string, p: string): string | undefined {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let n = parts.length; n >= 1; n--) { const rel = parts.slice(-n).join("/"); if (existsSync(join(root, rel))) return rel; }
  const name = parts[parts.length - 1];
  return projectFiles(root, 400).find((f) => basename(f) === name);
}
async function errorTriage(c: SkillContext): Promise<SkillResult> {
  const logRel = c.files.find((f) => LOG_EXT.test(f.path))?.path;
  const src = logRel ? await text(c, logRel, 60_000) : c.prompt;
  if (!src) return { answer: c.ko ? "로그 파일을 읽지 못했어요." : "Could not read the log.", verified: false, detail: "unreadable" };
  const tb = parseTraceback(src);
  const lastErrors = src.split("\n").filter((l) => /\b(ERROR|FATAL|Exception|Error:)/.test(l)).slice(-5);
  let where = "", snippet = "", loc: { rel: string; line: number; fn: string } | undefined;
  if (tb?.frames.length) {
    for (const f of [...tb.frames].reverse()) { const rel = projectPath(c.root, f.file); if (rel) { loc = { rel, line: f.line, fn: f.fn }; break; } }
    if (loc) {
      const ls = readFileSync(join(c.root, loc.rel), "utf8").split("\n");
      const a = Math.max(0, loc.line - 4), b = Math.min(ls.length, loc.line + 3);
      snippet = ls.slice(a, b).map((l, i) => `${a + i + 1 === loc!.line ? ">" : " "}${String(a + i + 1).padStart(4)} ${l}`).join("\n");
      where = `${loc.rel}:${loc.line} (${loc.fn})`;
    }
  }
  if (!tb?.exc && !lastErrors.length) return { answer: c.ko ? "로그에서 에러나 traceback을 찾지 못했어요." : "No error or traceback found in the log.", verified: true, detail: "no_error" };
  const j = await ask<{ cause: string; fix: string }>(c,
    `Explain a failure from a log${c.ko ? " in Korean" : ""}. cause: why it failed, tied to the code and the values in the log (1-2 sentences). fix: the concrete change to make at the given location (1-2 sentences). Do not invent files or lines.`,
    `EXCEPTION: ${tb?.exc ?? "?"}: ${tb?.msg ?? ""}\nCALL CHAIN: ${(tb?.frames ?? []).map((f) => `${f.fn} (${basename(f.file)}:${f.line})`).join(" → ")}\nLOCATION IN THIS PROJECT: ${where || "not found"}\n${snippet ? `CODE:\n${snippet}\n` : ""}LOG LINES:\n${lastErrors.join("\n")}`,
    { type: "object", properties: { cause: { type: "string" }, fix: { type: "string" } }, required: ["cause", "fix"], additionalProperties: false }, 400);
  const head = tb?.exc ? `**${tb.exc}**${tb.msg ? `: ${tb.msg}` : ""}${where ? ` — \`${where}\`` : ""}` : `**${c.ko ? "로그의 마지막 에러" : "Last errors in the log"}**\n${lastErrors.map((l) => `- ${l.trim()}`).join("\n")}`;
  return { verified: !!where, detail: where || "no_project_frame",
    answer: `${head}\n\n${snippet ? "```\n" + snippet + "\n```\n\n" : ""}${str(j?.cause) ? `${c.ko ? "원인" : "Cause"}: ${str(j?.cause)}\n\n` : ""}${str(j?.fix) ? `${c.ko ? "고칠 곳" : "Fix"}: ${str(j?.fix)}` : ""}${tb?.frames.length ? `\n\n${c.ko ? "호출 순서" : "Call chain"}: ${tb.frames.map((f) => `\`${f.fn}\` (${basename(f.file)}:${f.line})`).join(" → ")}` : ""}` };
}

// ---------------------------------------------------------------- documents
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Month/day mentions: "11월 5일", "11/10", "Nov 7", "November 7", "2026-11-05". key = "m-d". */
export function dateMentions(t: string): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const m of t.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) out.push({ key: `${+m[2]}-${+m[3]}`, text: m[0] });
  for (const m of t.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) out.push({ key: `${+m[1]}-${+m[2]}`, text: m[0] });
  for (const m of t.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/]|\.\d)/g)) out.push({ key: `${+m[1]}-${+m[2]}`, text: m[0] });
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi)) out.push({ key: `${MONTHS.indexOf(m[1].toLowerCase()) + 1}-${+m[2]}`, text: m[0] });
  return out;
}
async function extractTable(c: SkillContext): Promise<SkillResult> {
  const rel = c.files.find((f) => TEXT_EXT.test(f.path))!.path;
  const src = await text(c, rel);
  if (!src) return { answer: c.ko ? `\`${rel}\`을 읽지 못했어요.` : `Could not read \`${rel}\`.`, verified: false, detail: "unreadable" };
  const j = await ask<{ items: { task: string; owner: string; due: string }[] }>(c,
    `Extract every action item (a task someone agreed to do) from the text${c.ko ? ", writing task in Korean" : ""}. owner: the person's name exactly as written in the text, or empty. due: the deadline exactly as written in the text, or empty. Skip plain facts and scheduled meetings.`,
    clip(src, 8000),
    { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { task: { type: "string" }, owner: { type: "string" }, due: { type: "string" } }, required: ["task", "owner", "due"], additionalProperties: false } } }, required: ["items"], additionalProperties: false }, 900);
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const inSrc = (s: string) => !!s && norm(src).includes(norm(s));
  // Grounding: the owner must be copied from the text; a due date must be a date that appears in the text (AFM
  // often normalises "Nov 7" to "11월 7일", so dates are compared as month/day and shown as written in the text).
  const srcDates = new Map(dateMentions(src).map((d) => [d.key, d.text]));
  const due = (s: string) => { if (!s) return ""; if (inSrc(s)) return s; const k = dateMentions(s)[0]?.key; return k && srcDates.has(k) ? srcDates.get(k)! : ""; };
  const items = (j?.items ?? []).map((x) => ({ task: str(x.task), owner: inSrc(str(x.owner)) ? str(x.owner) : "", due: due(str(x.due)) })).filter((x) => x.task);
  if (!items.length) return { answer: c.ko ? `\`${rel}\`에서 할 일을 찾지 못했어요.` : `No action items found in \`${rel}\`.`, verified: false, detail: "no_items" };
  const esc = (s: string) => (s || "–").replace(/\|/g, "\\|");
  return { verified: true, detail: `${items.length} items`,
    answer: `${c.ko ? `\`${rel}\`의 할 일` : `Action items in \`${rel}\``}\n\n| ${c.ko ? "할 일 | 담당자 | 마감일" : "Task | Owner | Due"} |\n|---|---|---|\n${items.map((x) => `| ${esc(x.task)} | ${esc(x.owner)} | ${esc(x.due)} |`).join("\n")}\n\n_${c.ko ? "담당자와 마감일은 원문에 있는 표기 그대로만 넣었어요." : "Owners and dates are copied from the text only."}_` };
}

async function translate(c: SkillContext): Promise<SkillResult> {
  const rel = c.files.find((f) => TEXT_EXT.test(f.path))!.path;
  const src = await text(c, rel, 30_000);
  if (!src) return { answer: c.ko ? `\`${rel}\`을 읽지 못했어요.` : `Could not read \`${rel}\`.`, verified: false, detail: "unreadable" };
  const lang = /(영어|영문|English)/i.test(c.prompt) ? "English" : /(한국어|한글|Korean)/i.test(c.prompt) ? "Korean" : /(일본어|Japanese)/i.test(c.prompt) ? "Japanese" : "Chinese";
  const ok = (s: string) => (lang === "English" ? hangulShare(s) < 0.05 : lang === "Korean" ? hangulShare(s) > 0.2 : true);
  // Paragraphs (code blocks kept whole and untranslated); a paragraph at a time keeps AFM inside its window.
  const blocks = src.split(/(```[\s\S]*?```)/).flatMap((b) => (b.startsWith("```") ? [b] : b.split(/\n{2,}/)));
  const out: string[] = [];
  let failed = 0;
  for (const b of blocks.slice(0, 40)) {
    if (!b.trim() || b.startsWith("```") || !/[\p{L}]/u.test(b)) { out.push(b); continue; }
    let t = "";
    for (let attempt = 0; attempt < 2 && !(t && ok(t)); attempt++) {
      const j = await ask<{ translation: string }>(c, `Translate the text into ${lang}. Keep Markdown markup (#, -, *, links, inline code) and technical terms; translate headings too. Output only the translation.${attempt ? ` Every word must be in ${lang}.` : ""}`,
        b, { type: "object", properties: { translation: { type: "string" } }, required: ["translation"], additionalProperties: false }, 1200);
      t = str(j?.translation);
    }
    if (!t || !ok(t)) failed++;
    out.push(t || b);
  }
  return { verified: failed === 0, detail: `${blocks.length} blocks, ${failed} unchecked`,
    answer: `${c.ko ? `\`${rel}\` ${lang === "English" ? "영어" : lang === "Korean" ? "한국어" : lang} 번역` : `\`${rel}\` in ${lang}`}${blocks.length > 40 ? (c.ko ? " (앞부분 40개 단락)" : " (first 40 paragraphs)") : ""}:\n\n${out.join("\n\n")}${failed ? `\n\n_${c.ko ? `${failed}개 단락은 번역 확인에 실패해 원문을 남겼어요.` : `${failed} paragraph(s) kept in the original: the translation check failed.`}_` : ""}` };
}

// ---------------------------------------------------------------- docstrings
const PY_FUNCS = `import ast, json, sys
src = sys.stdin.read()
t = ast.parse(src)
out = []
for n in ast.walk(t):
    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and not ast.get_docstring(n) and n.body:
        args = [a.arg for a in (n.args.posonlyargs + n.args.args + n.args.kwonlyargs)] if not isinstance(n, ast.ClassDef) else []
        args = [a for a in args if a not in ("self", "cls")]
        out.append({"name": n.name, "kind": "class" if isinstance(n, ast.ClassDef) else "function", "line": n.lineno, "end": n.end_lineno, "body_line": n.body[0].lineno, "body_col": n.body[0].col_offset, "args": args, "returns": bool(getattr(n, "returns", None)) or any(isinstance(x, ast.Return) and x.value is not None for x in ast.walk(n))})
print(json.dumps(out))`;
const PY_SAME = `import ast, sys, json
a, b = json.load(sys.stdin)
def strip(src):
    t = ast.parse(src)
    for n in ast.walk(t):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)) and n.body and isinstance(n.body[0], ast.Expr) and isinstance(getattr(n.body[0], "value", None), ast.Constant) and isinstance(n.body[0].value.value, str):
            n.body = n.body[1:] or [ast.Pass()]
    return ast.dump(t)
print("same" if strip(a) == strip(b) else "different")`;
async function docstrings(c: SkillContext): Promise<SkillResult> {
  const rel = c.files.find((f) => f.path.endsWith(".py"))!.path;
  const orig = readFileSync(join(c.root, rel), "utf8");
  const f = await run("/usr/bin/python3", ["-I", "-c", PY_FUNCS], c.root, orig);
  let todo: { name: string; kind: string; line: number; end: number; body_line: number; body_col: number; args: string[]; returns: boolean }[];
  try { todo = JSON.parse(f.out); } catch { return { answer: c.ko ? `\`${rel}\`을 파이썬으로 해석하지 못했어요.` : `Could not parse \`${rel}\` as Python.`, verified: false, detail: "parse_failed" }; }
  if (!todo.length) return { answer: c.ko ? `\`${rel}\`의 함수와 클래스에는 이미 docstring이 있어요.` : `Every function and class in \`${rel}\` already has a docstring.`, verified: true, detail: "none_missing" };
  const lines = orig.split("\n");
  const inserts: { at: number; text: string }[] = [];
  for (const d of todo.slice(0, 20)) {
    const code = lines.slice(d.line - 1, d.end).join("\n");
    const j = await ask<{ summary: string; args: { name: string; description: string }[]; returns: string }>(c,
      `Write a docstring for this Python ${d.kind}: summary is one sentence in English saying what it does (from the code, not the name alone). Describe each argument in a few words. returns: what is returned, or empty if nothing.`,
      clip(code, 3000),
      { type: "object", properties: { summary: { type: "string" }, args: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"], additionalProperties: false } }, returns: { type: "string" } }, required: ["summary", "args", "returns"], additionalProperties: false }, 400);
    const summary = str(j?.summary).replace(/"""/g, "'''");
    if (!summary) continue;
    const desc = new Map((j?.args ?? []).map((a) => [str(a.name), str(a.description).replace(/"""/g, "'''")]));
    const pad = " ".repeat(d.body_col);
    const args = d.args.length ? `\n\n${pad}Args:\n${d.args.map((a) => `${pad}    ${a}: ${desc.get(a) || "…"}`).join("\n")}` : "";   // the real parameter names, not AFM's
    const ret = d.kind === "function" && d.returns && str(j?.returns) ? `\n\n${pad}Returns:\n${pad}    ${str(j?.returns).replace(/"""/g, "'''")}` : "";
    const one = !args && !ret;
    inserts.push({ at: d.body_line - 1, text: one ? `${pad}"""${summary.replace(/\.?$/, ".")}"""` : `${pad}"""${summary.replace(/\.?$/, ".")}${args}${ret}\n${pad}"""` });
  }
  if (!inserts.length) return { answer: c.ko ? "docstring을 만들지 못했어요." : "Could not write the docstrings.", verified: false, detail: "afm_failed" };
  const next = [...lines];
  for (const ins of inserts.sort((a, b) => b.at - a.at)) next.splice(ins.at, 0, ins.text);
  const newText = next.join("\n");
  // Only docstrings may change: the two files must have the same AST once docstrings are removed.
  const same = (await run("/usr/bin/python3", ["-I", "-c", PY_SAME], c.root, JSON.stringify([orig, newText]))).out.trim() === "same";
  if (!same) return { answer: c.ko ? "docstring을 넣는 중 코드가 바뀌어서 중단했어요." : "Stopped: inserting the docstrings changed the code.", verified: false, detail: "ast_changed" };
  const edit: EditProposal = { path: rel, oldText: orig, newText, explanation: c.ko ? `\`${rel}\`에 docstring ${inserts.length}개 추가 (코드는 그대로인지 AST로 확인)` : `Add ${inserts.length} docstring(s) to \`${rel}\` (code unchanged, checked with the AST)`, baseHash: sha(orig), preservesBehaviour: true };
  return { verified: true, detail: `${inserts.length} docstrings`, pendingEdit: { edit },
    answer: `${edit.explanation}\n\n${inserts.length < todo.length ? (c.ko ? `(${todo.length}개 중 ${inserts.length}개)\n\n` : `(${inserts.length} of ${todo.length})\n\n`) : ""}` };
}

// ---------------------------------------------------------------- privacy
const luhn = (d: string) => { let s = 0; for (let i = 0; i < d.length; i++) { let n = Number(d[d.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; };
export function findPersonalData(t: string): { kind: string; value: string; line: number }[] {
  const out: { kind: string; value: string; line: number }[] = [];
  const DET: [string, RegExp, ((m: string) => boolean)?][] = [
    ["email", /[\w.+-]+@[\w-]+(\.[\w-]+)+/g],
    ["phone", /(?<![\w-])(0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|\+\d{1,3}[ -]?\(?\d{1,4}\)?[ -]?\d{3,4}[ -]?\d{3,4})(?![\w-])/g],
    ["resident_id", /(?<!\d)\d{6}-[1-8]\d{6}(?!\d)/g],
    ["card", /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, (m) => luhn(m.replace(/\D/g, "")) && m.replace(/\D/g, "").length >= 13],
    ["ip", /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g],
  ];
  t.split("\n").forEach((l, i) => {
    for (const [kind, re, ok] of DET) for (const m of l.matchAll(re)) if (!ok || ok(m[0])) out.push({ kind, value: m[0].trim(), line: i + 1 });
    if (redact(l).found.length) out.push({ kind: "secret", value: redact(l).found.join(","), line: i + 1 });
  });
  return out.filter((x, i, a) => !(x.kind === "phone" && a.some((y) => y.kind === "card" && y.line === x.line && y.value.includes(x.value))));
}
const mask = (k: string, v: string) => (k === "email" ? v.replace(/^(.).*?(@.*)$/, "$1***$2") : k === "secret" ? v : v.replace(/\d(?=(?:\D*\d){4})/g, "*"));
async function privacyScan(c: SkillContext): Promise<SkillResult> {
  const rel = c.files.find((f) => TEXT_EXT.test(f.path))!.path;
  const d = await readDocument(c.root, rel, { maxChars: 200_000 });
  if (d.error) return { answer: c.ko ? `\`${rel}\`을 읽지 못했어요.` : `Could not read \`${rel}\`.`, verified: false, detail: "unreadable" };
  const hits = findPersonalData(d.text);
  // Names and postal addresses have no reliable pattern: Decima (when on) scores the document for them.
  let names: number | undefined;
  if (c.decima && (await c.decima.available()) && c.decima.pinOk()) {
    try {
      const r = await fetch(`${c.decima.cfg.url}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(c.decima.cfg.timeoutMs),
        body: JSON.stringify({ model: c.decima.cfg.model, state: `document:\n${redact(d.text).text.slice(0, 6000)}`, questions: { personal: { type: "noul", instructions: "The document names private individuals or contains a home or postal address." } } }) });
      names = ((await r.json()) as any)?.answers?.personal?.noul;
    } catch { /* advisory */ }
  }
  const kinds = c.ko ? { email: "이메일", phone: "전화번호", resident_id: "주민등록번호", card: "카드번호", ip: "IP 주소", secret: "비밀값(키/토큰)" } : { email: "email", phone: "phone number", resident_id: "resident ID", card: "card number", ip: "IP address", secret: "secret (key/token)" };
  const rows = hits.slice(0, 30).map((h) => `| ${h.line} | ${(kinds as any)[h.kind]} | \`${mask(h.kind, h.value)}\` |`);
  const verdict = hits.length
    ? (c.ko ? `**공유 전에 가리세요.** \`${rel}\`에 개인정보 ${hits.length}건이 있어요.` : `**Redact before sharing.** \`${rel}\` contains ${hits.length} item(s) of personal data.`)
    : (c.ko ? `자동 검사로는 이메일·전화번호·주민번호·카드번호·IP·비밀키를 찾지 못했어요.` : `No email, phone, ID, card, IP or secret found by the automatic check.`);
  const nameNote = names !== undefined ? `\n\n${c.ko ? `Decima: 개인 이름이나 주소가 있을 가능성 ${names.toFixed(2)}${names >= 0.5 ? " (높음) — 이름도 가리는 게 좋아요." : ""}` : `Decima: likelihood of personal names or addresses ${names.toFixed(2)}${names >= 0.5 ? " (high): consider removing names too." : ""}`}` : `\n\n_${c.ko ? "이름과 주소는 패턴으로 찾을 수 없어 직접 확인해 주세요." : "Names and addresses cannot be found by pattern; check them yourself."}_`;
  return { verified: true, detail: `${hits.length} hits`,
    answer: `${verdict}${rows.length ? `\n\n| ${c.ko ? "줄 | 종류 | 값(가림)" : "Line | Kind | Value (masked)"} |\n|---|---|---|\n${rows.join("\n")}` : ""}${nameNote}` };
}

// ---------------------------------------------------------------- CSV ↔ JSON
const PY_CONVERT = `import csv, json, sys
src, dst = sys.argv[1], sys.argv[2]
def num(v):
    try: return int(v)
    except ValueError:
        try: return float(v)
        except ValueError: return v
if src.lower().endswith(".csv"):
    with open(src, newline="", encoding="utf-8-sig") as f: rows = [{k: num(v) for k, v in r.items()} for r in csv.DictReader(f)]
    with open(dst, "w", encoding="utf-8") as f: json.dump(rows, f, ensure_ascii=False, indent=2)
else:
    with open(src, encoding="utf-8") as f: rows = json.load(f)
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(dst, "w", newline="", encoding="utf-8") as f: w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)
print(f"wrote {len(rows)} records to {dst}")`;
async function csvJson(c: SkillContext): Promise<SkillResult> {
  const done = /wrote (\d+) records to (\S+)/.exec(c.history ?? "");
  if (done) return { verified: true, detail: "converted", answer: c.ko ? `\`${done[2]}\`에 레코드 ${done[1]}개를 저장했어요.` : `Wrote ${done[1]} records to \`${done[2]}\`.` };
  const src = /([\w./-]+\.(?:csv|json))\b/i.exec(c.prompt)?.[1];
  if (!src || !existsSync(join(c.root, src))) return { answer: c.ko ? "변환할 CSV/JSON 파일을 찾지 못했어요." : "Could not find the CSV/JSON file to convert.", verified: false, detail: "no_source" };
  const toJson = extname(src).toLowerCase() === ".csv";
  const named = [...c.prompt.matchAll(/([\w./-]+\.(?:csv|json))\b/gi)].map((m) => m[1]).find((x) => x !== src && extname(x).toLowerCase() === (toJson ? ".json" : ".csv"));
  const dst = named ?? src.replace(/\.(csv|json)$/i, toJson ? ".json" : ".csv");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `python3 -I -c ${q(PY_CONVERT)} ${q(src)} ${q(dst)}`;
  return { verified: true, detail: `${src} → ${dst}`, pendingCommand: cmd,
    answer: c.ko ? `\`${src}\`를 ${toJson ? "JSON 배열" : "CSV"}로 바꿔 \`${dst}\`에 저장할게요 (파이썬 표준 csv/json 모듈, 숫자는 숫자로).${existsSync(join(c.root, dst)) ? ` ⚠ \`${dst}\`가 이미 있어서 덮어써요.` : ""}\n\n실행할까요? (\`예\` / \`아니요\`)`
      : `Convert \`${src}\` to ${toJson ? "a JSON array" : "CSV"} in \`${dst}\` (Python csv/json, numbers kept as numbers).${existsSync(join(c.root, dst)) ? ` ⚠ \`${dst}\` exists and will be overwritten.` : ""}\n\nRun it? (\`yes\` / \`no\`)` };
}

// ---------------------------------------------------------------- spreadsheets
const ASKED_COLUMN: [RegExp, RegExp][] = [
  [/(업체|회사|제조사|제약사|공급처|공급사|공급하는|만드는|제조하는|판매하는|파는|who (makes|sells|supplies|manufactures)|compan(y|ies)|suppliers?|vendors?|manufacturers?|makers?)/i, /(업체|회사|제조사|제약사|공급|vendor|supplier|company|manufacturer|maker)/i],
  [/(가격|금액|단가|얼마|비용|price|cost|how much)/i, /(가격|금액|단가|price|cost|amount)/i],
  [/(담당자?|누가|owner|assignee|who)/i, /(담당|owner|assignee|person|name)/i],
  [/(날짜|일자|언제|마감|기한|date|when|deadline|due)/i, /(날짜|일자|마감|기한|date|due|deadline)/i],
  [/(코드|code)/i, /(코드|code)/i],
];
async function sheetLookup(c: SkillContext): Promise<SkillResult> {
  const f = c.files.find((x) => SHEET_EXT.test(x.path))!;
  const decline = (detail: string): SkillResult => ({ answer: "", verified: false, detail, declined: true });
  let t;
  try { t = await readTable(join(c.root, f.path)); } catch { return decline("unreadable"); }
  const allHeaders = [...new Set(t.sheets.flatMap((s) => s.header))];
  // Words of the file's name and folders ("약제급여목록" in a request about 약제급여목록….xlsx) are not search terms.
  const fileWords = f.path.normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => [...w].length >= 2);
  const skip = [...allHeaders, ...fileWords];
  const terms = candidateTerms(c.prompt, t, skip).filter((x) => !fileWords.some((w) => norm(w).includes(norm(x.term))));
  const total = t.sheets.reduce((n, s) => n + s.rows.length, 0);
  // A Korean request names the thing in Latin letters ("zzfictinol 제조 업체"): if that name is in no row, say so
  // instead of answering from a weaker Korean word.
  const missing = c.ko ? missingNames(c.prompt, t, skip) : [];
  if (missing.length && !terms.some((x) => /[A-Za-z]/.test(x.term)))
    return { answer: `표에서 **${missing.join(", ")}**을(를) 찾지 못했어요. \`${f.path}\`의 ${t.sheets.length}개 시트, ${total.toLocaleString()}개 행을 모두 검색했어요 (그룹 머리 행 포함). 철자나 다른 이름(성분명·제품명·코드)으로 다시 물어보세요.`, verified: true, detail: `not_found ${missing.join(",")}` };
  if (!terms.length) return decline("no_term_in_table");
  // The longest phrase found in the table, then narrowed by other specific words that still leave rows
  // ("doxepin 6mg" → doxepin rows that also say 6mg). Short Korean words only narrow when 3+ syllables.
  let used = [terms[0].term], rows: Match[] = lookup(t, terms[0].term);
  for (const o of terms.slice(1)) {
    if (/^[가-힣]{1,2}$/.test(o.term)) continue;
    const q = norm(o.term);
    const narrowed = rows.filter((m) => m.row.cells.some((x) => norm(x).includes(q)) || norm(m.row.group ?? "").includes(q));
    if (narrowed.length && narrowed.length < rows.length) { rows = narrowed; used.push(o.term); }
  }
  // Columns that answer the question: named in the request, else AFM picks from the header (enum).
  // From here on only the sheets the rows came from; the request without the file's path and name words
  // ("부품 단가표.xlsx" must not select the 단가 column).
  const hit = new Set(rows.map((m) => m.sheet));
  const headers = [...new Set(t.sheets.filter((s) => hit.has(s.name)).flatMap((s) => s.header))];
  const sheetOf = new Map(t.sheets.map((s) => [s.name, s]));
  const val = (m: Match, h: string) => m.row.cells[sheetOf.get(m.sheet)!.header.indexOf(h)] ?? "";
  let asked = c.prompt.normalize("NFC").split(f.path.normalize("NFC")).join(" ");
  for (const w of fileWords) asked = asked.split(w).join(" ");
  const P = norm(asked).replace(/\s/g, "");
  let cols = headers.filter((h) => [...h].length >= 2 && P.includes(norm(h).replace(/\s/g, "")));
  const counting = /(몇\s?(개|건|종|가지)|개수|how many|count)/i.test(c.prompt);
  // What is asked for → which column (AFM picked the product name for "공급하는 업체" / "suppliers").
  if (!cols.length && !counting) for (const [ask_, col] of ASKED_COLUMN) {
    if (!ask_.test(asked)) continue;
    const hits = headers.filter((h) => col.test(h));
    if (hits.length) { cols = [hits[0]]; break; }
  }
  if (!cols.length && !counting) {
    const j = await ask<{ columns: string[] }>(c,
      "A spreadsheet lookup: the code already found the rows. Pick the column(s) whose values answer the question (for 'who makes X' the company/manufacturer column, for 'how much' the price column). Use only the given column names.",
      `Question: ${c.prompt}\nColumns: ${headers.join(" | ")}\nExample row: ${headers.map((h) => `${h}=${val(rows[0], h)}`).join(" | ")}`,
      { type: "object", properties: { columns: { type: "array", items: { type: "string", enum: headers }, maxItems: 3 } }, required: ["columns"], additionalProperties: false }, 120);
    cols = (j?.columns ?? []).filter((x) => headers.includes(x));
    // AFM tends to add related columns (the price next to the company); more than one only when the request joins two asks.
    if (!/(과|와|이랑|랑|하고|및|그리고|\band\b|,)/i.test(c.prompt)) cols = cols.slice(0, 1);
  }
  cols = cols.filter((h) => rows.some((m) => val(m, h)));   // a column empty in every matched row answers nothing
  // Descriptive column for the row table: the longest text among the matched rows, not an answer column.
  const desc = headers.filter((h) => !cols.includes(h)).map((h) => ({ h, len: rows.slice(0, 50).reduce((n, m) => n + val(m, h).length, 0) })).sort((a, b) => b.len - a.len)[0]?.h;
  const groups = [...new Set(rows.map((m) => m.row.group).filter(Boolean))] as string[];
  const distinct = (h: string, rs = rows) => [...new Set(rs.map((m) => val(m, h)).filter(Boolean))];
  const L = c.ko ? { rows: "행", groups: "그룹", uniq: "중복 제외", byGroup: "그룹별", src: "출처", more: "외", narrow: "결과가 많아요. 용량·제형·업체명 같은 조건을 더 넣으면 좁혀져요." }
    : { rows: "rows", groups: "groups", uniq: "distinct", byGroup: "By group", src: "Source", more: "and", narrow: "Many rows match; add a strength, form or company to narrow it down." };
  const lines: string[] = [];
  lines.push(c.ko ? `**${used.join(" + ")}**: ${rows.length}개 행${groups.length ? `, ${groups.length}개 그룹` : ""}` : `**${used.join(" + ")}**: ${rows.length} rows${groups.length ? ` in ${groups.length} groups` : ""}`);
  for (const h of cols) {
    const d = distinct(h);
    lines.push(`\n**${h}** (${L.uniq} ${d.length}): ${d.slice(0, 40).join(", ")}${d.length > 40 ? ` … (${L.more} ${d.length - 40})` : ""}`);
  }
  if (groups.length > 1 && cols.length && groups.length <= 15) {
    lines.push(`\n${L.byGroup}:`);
    for (const g of groups) lines.push(`- ${g}: ${cols.map((h) => distinct(h, rows.filter((m) => m.row.group === g)).join(", ")).join(" / ")}`);
  }
  // Row label: the sheet's own running number column (연번, No, …) when it has one, else the sheet row.
  const idCol = /^(연번|번호|순번|일련번호|no\.?|#|id|seq)$/i.test(headers[0] ?? "") ? headers[0] : undefined;
  const show = [desc, ...cols].filter((h): h is string => !!h && h !== idCol);
  const multiSheet = new Set(rows.map((m) => m.sheet)).size > 1;
  lines.push(`\n| ${idCol ?? L.rows} |${multiSheet ? " sheet |" : ""}${groups.length ? ` ${L.groups} |` : ""} ${show.join(" | ")} |\n|---|${multiSheet ? "---|" : ""}${groups.length ? "---|" : ""}${show.map(() => "---").join("|")}|`);
  for (const m of rows.slice(0, 30)) lines.push(`| ${idCol ? val(m, idCol) : m.row.n} |${multiSheet ? ` ${m.sheet} |` : ""}${groups.length ? ` ${(m.row.group ?? "").replace(/\|/g, "\\|")} |` : ""} ${show.map((h) => val(m, h).replace(/\|/g, "\\|")).join(" | ")} |`);
  if (rows.length > 30) lines.push(`\n${c.ko ? `외 ${rows.length - 30}개 행. ` : `${rows.length - 30} more rows. `}${rows.length > 100 ? L.narrow : ""}`);
  lines.push(`\n_${L.src}: \`${f.path}\`, ${c.ko ? "시트" : "sheet"} ${[...new Set(rows.map((m) => m.sheet))].join(", ")}${c.ko ? " (모든 행을 코드로 검색, 그룹 머리 행 반영)" : " (every row searched by code, group heading rows applied)"}_`);
  return { answer: lines.join("\n"), verified: true, detail: `${rows.length} rows, ${groups.length} groups, cols ${cols.join(",") || "-"}` };
}

// ---------------------------------------------------------------- repository state
async function gitOverview(c: SkillContext): Promise<SkillResult> {
  if ((await git(c.root, "rev-parse", "--is-inside-work-tree")).out.trim() !== "true")
    return { answer: c.ko ? "이 폴더는 git 저장소가 아니에요." : "This folder is not a git repository.", verified: true, detail: "not_a_repo" };
  const out = async (...a: string[]) => { const r = await git(c.root, ...a); return r.code === 0 ? r.out.trim() : ""; };
  const top = await out("rev-parse", "--show-toplevel");
  const short = await out("rev-parse", "--short", "HEAD");
  const branch = (await out("symbolic-ref", "--short", "-q", "HEAD")) || `(detached ${short})`;
  const upstream = await out("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  // Remote URLs without credentials (https://user:token@host → https://host).
  const remotes = [...new Map((await out("remote", "-v")).split("\n").filter((l) => l.endsWith("(fetch)")).map((l) => { const [n, u] = l.split(/\s+/); return [n, u.replace(/\/\/[^@/]+@/, "//")]; }))];
  const gitDir = resolve(top, await out("rev-parse", "--git-common-dir"));
  let lastFetch: Date | undefined;
  try { lastFetch = statSync(join(gitDir, "FETCH_HEAD")).mtime; } catch { /* never fetched */ }
  const fetchedNow = /\$ git fetch\b[\s\S]*\[exit 0\]/.test(c.history ?? "");
  const wantsRemote = /(원격|remote|origin|upstream|github|깃허브|gitlab|push|pull|푸시|앞서|뒤처|뒤쳐|ahead|behind|동기화|sync|최신|up to date)/i.test(c.prompt);
  const stale = !lastFetch || Date.now() - lastFetch.getTime() > 10 * 60_000;
  const askFetch = wantsRemote && remotes.length > 0 && stale && !fetchedNow;

  const [ahead, behind] = upstream ? (await out("rev-list", "--left-right", "--count", "HEAD...@{u}")).split(/\s+/).map(Number) : [0, 0];
  const log = async (range: string) => (await out("log", "--format=%h %s", "-10", range)).split("\n").filter(Boolean);
  const aheadLog = upstream && ahead ? await log("@{u}..HEAD") : [], behindLog = upstream && behind ? await log("HEAD..@{u}") : [];
  const st = (await out("status", "--porcelain")).split("\n").filter(Boolean);
  const conflicts = st.filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l)).length;
  const staged = st.filter((l) => !l.startsWith("??") && l[0] !== " ").length - conflicts;
  const unstaged = st.filter((l) => !l.startsWith("??") && l[1] !== " ").length - conflicts;
  const untracked = st.filter((l) => l.startsWith("??")).length;
  const stashes = (await out("stash", "list")).split("\n").filter(Boolean).length;
  const branches = (await out("for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:short)", "refs/heads")).split("\n").filter(Boolean).map((l) => { const [n, u, t, d] = l.split("\t"); return { n, u, t, d }; });
  const wts: { path: string; branch: string; head: string; flags: string[]; changes?: number }[] = [];
  for (const blk of (await out("worktree", "list", "--porcelain")).split("\n\n").filter(Boolean)) {
    const kv = Object.fromEntries(blk.split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]));
    const w = { path: kv.worktree, branch: (kv.branch ?? "").replace(/^refs\/heads\//, "") || (c.ko ? "(분리된 HEAD)" : "(detached)"), head: (kv.HEAD ?? "").slice(0, 7), flags: ["locked", "prunable", "bare"].filter((f) => f in kv), changes: undefined as number | undefined };
    if (!kv.bare && existsSync(kv.worktree)) w.changes = (await run("git", ["-C", kv.worktree, "status", "--porcelain"], c.root)).out.split("\n").filter(Boolean).length;
    wts.push(w);
  }
  const home = process.env.HOME ?? "";
  const tilde = (p: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  const ago = (d?: Date) => { if (!d) return c.ko ? "없음" : "never"; const m = Math.round((Date.now() - d.getTime()) / 60_000); return m < 60 ? `${m}${c.ko ? "분 전" : " min ago"}` : m < 2880 ? `${Math.round(m / 60)}${c.ko ? "시간 전" : " h ago"}` : `${Math.round(m / 1440)}${c.ko ? "일 전" : " days ago"}`; };

  // Next steps, from the numbers (deterministic).
  const next: string[] = [];
  const K = c.ko;
  if (conflicts) next.push(K ? `충돌 ${conflicts}개를 먼저 해결하세요 (\`git status\`에서 파일 확인).` : `Resolve ${conflicts} conflicts first (see \`git status\`).`);
  if (staged + unstaged > 0 && (behind > 0 || wantsRemote)) next.push(K ? `커밋 안 된 변경 ${staged + unstaged}개가 있어요. 받아오기 전에 커밋하거나 \`git stash\`로 치워 두세요.` : `${staged + unstaged} uncommitted changes: commit or \`git stash\` them before pulling.`);
  if (ahead && behind) next.push(K ? `원격과 갈라졌어요 (앞섬 ${ahead}, 뒤처짐 ${behind}). \`git pull --rebase\`(또는 merge)로 합친 뒤 \`git push\`하세요.` : `Diverged from ${upstream} (ahead ${ahead}, behind ${behind}): \`git pull --rebase\` (or merge), then \`git push\`.`);
  else if (behind) next.push(K ? `원격에 새 커밋 ${behind}개가 있어요. \`git pull\`로 받아오세요.` : `${behind} new commits on ${upstream}: \`git pull\`.`);
  else if (ahead) next.push(K ? `올리지 않은 커밋 ${ahead}개: \`git push\`.` : `${ahead} commits not pushed: \`git push\`.`);
  if (!upstream && remotes.length && !branch.startsWith("(")) next.push(K ? `이 브랜치는 원격과 연결돼 있지 않아요: \`git push -u ${remotes[0][0]} ${branch}\`.` : `No upstream for this branch: \`git push -u ${remotes[0][0]} ${branch}\`.`);
  if (!remotes.length) next.push(K ? "원격 저장소가 없어요 (`git remote -v`가 비어 있음). GitHub와 비교하려면 먼저 `git remote add origin <주소>`로 연결하세요." : "No remote configured; add one with `git remote add origin <url>` to compare with GitHub.");
  for (const w of wts) if (w.path !== top && w.changes) next.push(K ? `worktree \`${tilde(w.path)}\`(${w.branch})에 커밋 안 된 변경 ${w.changes}개.` : `Worktree \`${tilde(w.path)}\` (${w.branch}) has ${w.changes} uncommitted changes.`);
  for (const w of wts) if (w.flags.includes("prunable")) next.push(K ? `\`${tilde(w.path)}\`는 폴더가 사라진 worktree예요 (\`git worktree prune\`으로 정리 가능).` : `\`${tilde(w.path)}\` is a stale worktree (\`git worktree prune\`).`);
  if (!next.length) next.push(K ? "정리돼 있어요: 커밋 안 된 변경도, 올리거나 받아올 커밋도 없어요." : "All clean: nothing uncommitted, nothing to push or pull.");

  const L: string[] = [];
  L.push(K ? `**${branch}** @ \`${short}\`${upstream ? ` → \`${upstream}\`: 앞섬 ${ahead}, 뒤처짐 ${behind}` : " (upstream 없음)"}` : `**${branch}** @ \`${short}\`${upstream ? ` → \`${upstream}\`: ahead ${ahead}, behind ${behind}` : " (no upstream)"}`);
  L.push(K ? `작업 트리: 스테이징 ${staged}, 수정 ${unstaged}, 새 파일 ${untracked}${conflicts ? `, 충돌 ${conflicts}` : ""} · stash ${stashes}개 · 마지막 fetch: ${ago(lastFetch)}`
    : `Working tree: staged ${staged}, modified ${unstaged}, untracked ${untracked}${conflicts ? `, conflicts ${conflicts}` : ""} · ${stashes} stashes · last fetch: ${ago(lastFetch)}`);
  if (remotes.length) L.push(`${K ? "원격" : "Remotes"}: ${remotes.map(([n, u]) => `\`${n}\` ${u}`).join(", ")}`);
  if (aheadLog.length) L.push(`\n${K ? "올리지 않은 커밋" : "Not pushed"}:\n${aheadLog.map((x) => `- ${x}`).join("\n")}`);
  if (behindLog.length) L.push(`\n${K ? "원격에만 있는 커밋" : "Only on the remote"}:\n${behindLog.map((x) => `- ${x}`).join("\n")}`);
  if (wts.length > 1 || /worktree|워크\s?트리|작업\s?트리/i.test(c.prompt)) {
    L.push(`\n| worktree | ${K ? "브랜치 | 커밋 | 변경 | 상태" : "branch | commit | changes | state"} |\n|---|---|---|---|---|`);
    for (const w of wts) L.push(`| \`${tilde(w.path)}\`${w.path === top ? (K ? " (지금 폴더)" : " (this)") : ""} | ${w.branch} | ${w.head} | ${w.changes ?? "–"} | ${w.flags.join(", ") || "ok"} |`);
  }
  const others = branches.filter((b) => b.n !== branch && (b.t || !b.u));
  if (others.length) {
    L.push(`\n| ${K ? "다른 브랜치 | 원격 | 차이 | 마지막 커밋" : "other branch | upstream | track | last commit"} |\n|---|---|---|---|`);
    for (const b of others.slice(0, 12)) L.push(`| ${b.n} | ${b.u || "–"} | ${b.t.replace(/[[\]]/g, "") || (b.u ? "=" : K ? "원격 없음" : "local only")} | ${b.d} |`);
  }
  L.push(`\n**${K ? "다음 할 일" : "Next"}**\n${next.map((x) => `- ${x}`).join("\n")}`);
  if (askFetch) {
    L.push(K ? `\n위 원격 비교는 마지막 fetch(${ago(lastFetch)}) 기준이에요. **\`git fetch --prune\`으로 원격 최신 상태를 받아와서 다시 비교할까요?** (네트워크에서 읽기만 하고 로컬 브랜치와 파일은 바꾸지 않아요) \`예\` / \`아니요\``
      : `\nThe remote comparison is as of the last fetch (${ago(lastFetch)}). **Run \`git fetch --prune\` to get the remote's current state and compare again?** (reads from the network; local branches and files are not changed) \`yes\` / \`no\``);
    return { answer: L.join("\n"), verified: true, detail: "fetch_asked", pendingCommand: "git fetch --prune" };
  }
  return { answer: L.join("\n"), verified: true, detail: `ahead ${ahead} behind ${behind} worktrees ${wts.length}` };
}

// ---------------------------------------------------------------- GitHub (read-only)
async function githubStatus(c: SkillContext): Promise<SkillResult> {
  const K = c.ko;
  const remotes = (await git(c.root, "remote", "-v")).out;
  const all = [...remotes.matchAll(/^(\S+)\s+\S*github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s+\(fetch\)/gm)];
  const m = all.find((x) => x[1] === "origin") ?? all[0];
  if (!m) return { answer: K ? "이 저장소에는 GitHub 원격이 없어요 (`git remote -v`에 github.com 주소가 없음). `git remote add origin https://github.com/<owner>/<repo>.git`로 연결한 뒤 다시 물어보세요." : "This repository has no GitHub remote (no github.com URL in `git remote -v`). Connect one with `git remote add origin https://github.com/<owner>/<repo>.git` and ask again.", verified: true, detail: "no_github_remote" };
  const repo = `${m[2]}/${m[3]}`;
  const gh = (...a: string[]) => run("gh", a, c.root, undefined, 20_000);
  if ((await gh("auth", "status", "--hostname", "github.com")).code !== 0)
    return { answer: K ? "GitHub CLI가 로그인돼 있지 않아요. 터미널에서 `gh auth login`을 한 번 실행한 뒤 다시 물어보세요 (이 기능은 읽기만 해요)." : "The GitHub CLI is not signed in. Run `gh auth login` once in a terminal, then ask again (this only reads).", verified: true, detail: "gh_not_signed_in" };
  const json = async <T>(...a: string[]): Promise<T | undefined> => { const r = await gh(...a); if (r.code !== 0) return undefined; try { return JSON.parse(r.out) as T; } catch { return undefined; } };
  const branch = (await git(c.root, "symbolic-ref", "--short", "-q", "HEAD")).out.trim();
  const L: string[] = [];
  if (/(만들어|생성|열어|닫아|머지|병합|승인|댓글|코멘트|create|open a|close|merge|approve|comment|re-?run|재실행)/i.test(c.prompt))
    L.push(K ? "_이 기능은 GitHub를 **읽기만** 해요. 만들기·머지·댓글 같은 작업은 직접 `gh` 명령으로 하거나 codex 에이전트에게 맡겨 주세요._\n" : "_This only **reads** GitHub. To create, merge or comment, use `gh` yourself or the codex agent._\n");
  L.push(`**${repo}**${branch ? ` · ${K ? "현재 브랜치" : "branch"} \`${branch}\`` : ""}`);
  type Check = { conclusion?: string; state?: string; status?: string };
  const checks = (r?: Check[]) => { const n = new Map<string, number>(); for (const x of r ?? []) { const k = (x.conclusion || x.state || x.status || "pending").toLowerCase(); n.set(k, (n.get(k) ?? 0) + 1); } return [...n].map(([k, v]) => `${k} ${v}`).join(", ") || "–"; };
  if (branch) {
    const pr = await json<{ number: number; title: string; state: string; url: string; reviewDecision: string; isDraft: boolean; statusCheckRollup: Check[] }>("pr", "view", branch, "-R", repo, "--json", "number,title,state,url,reviewDecision,isDraft,statusCheckRollup");
    L.push(pr ? `\n${K ? "이 브랜치의 PR" : "This branch's PR"}: [#${pr.number} ${pr.title}](${pr.url}) · ${pr.isDraft ? "draft · " : ""}${pr.state} · ${K ? "리뷰" : "review"} ${pr.reviewDecision || "–"} · checks ${checks(pr.statusCheckRollup)}`
      : `\n${K ? "이 브랜치에는 PR이 없어요." : "No PR for this branch."}`);
  }
  const prs = await json<{ number: number; title: string; author: { login: string }; headRefName: string; isDraft: boolean; reviewDecision: string; updatedAt: string }[]>("pr", "list", "-R", repo, "--state", "open", "--limit", "10", "--json", "number,title,author,headRefName,isDraft,reviewDecision,updatedAt");
  if (prs === undefined) L.push(K ? "\nPR 목록을 읽지 못했어요 (권한 또는 네트워크)." : "\nCould not read pull requests (access or network).");
  else if (!prs.length) L.push(K ? "\n열린 PR 없음." : "\nNo open pull requests.");
  else {
    L.push(`\n| PR | ${K ? "제목 | 작성자 | 브랜치 | 리뷰 | 갱신" : "title | author | branch | review | updated"} |\n|---|---|---|---|---|---|`);
    for (const p of prs) L.push(`| #${p.number}${p.isDraft ? " (draft)" : ""} | ${p.title.replace(/\|/g, "\\|")} | ${p.author?.login ?? ""} | ${p.headRefName} | ${p.reviewDecision || "–"} | ${p.updatedAt.slice(0, 10)} |`);
  }
  const runs = await json<{ name: string; status: string; conclusion: string; headBranch: string; event: string; createdAt: string }[]>("run", "list", "-R", repo, "--limit", "5", "--json", "name,status,conclusion,headBranch,event,createdAt");
  if (runs?.length) {
    L.push(`\n| ${K ? "최근 워크플로 | 브랜치 | 이벤트 | 결과 | 시각" : "recent workflow | branch | event | result | at"} |\n|---|---|---|---|---|`);
    for (const r of runs) L.push(`| ${r.name} | ${r.headBranch} | ${r.event} | ${r.conclusion || r.status} | ${r.createdAt.slice(0, 16).replace("T", " ")} |`);
  }
  if (/(이슈|issues?)/i.test(c.prompt)) {
    const iss = await json<{ number: number; title: string; labels: { name: string }[]; updatedAt: string }[]>("issue", "list", "-R", repo, "--limit", "10", "--json", "number,title,labels,updatedAt");
    if (iss?.length) {
      L.push(`\n| ${K ? "이슈 | 제목 | 라벨 | 갱신" : "issue | title | labels | updated"} |\n|---|---|---|---|`);
      for (const i of iss) L.push(`| #${i.number} | ${i.title.replace(/\|/g, "\\|")} | ${i.labels.map((l) => l.name).join(", ")} | ${i.updatedAt.slice(0, 10)} |`);
    } else if (iss) L.push(K ? "\n열린 이슈 없음." : "\nNo open issues.");
  }
  L.push(`\n_${K ? "GitHub CLI(로그인된 계정)로 읽기만 했어요" : "Read with the signed-in GitHub CLI; nothing was changed"}._`);
  return { answer: L.join("\n"), verified: true, detail: `${repo} prs ${prs?.length ?? "?"} runs ${runs?.length ?? "?"}` };
}

// ---------------------------------------------------------------- slides
const ORD: Record<string, number> = { 첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
async function slidesOutline(c: SkillContext): Promise<SkillResult> {
  const f = c.files.find((x) => /\.pptx$/i.test(x.path))!;
  const d = await readDocument(c.root, f.path, { maxChars: 200_000 });
  if (d.error) return { answer: "", verified: false, detail: d.error, declined: true };
  // documents.ts renders "[slide N]\n# Title\nline…" in presentation order.
  const slides = d.text.split(/\n\n(?=\[slide \d+\])/).filter(Boolean).map((b) => {
    const lines = b.split("\n").slice(1);
    return { title: (lines.find((l) => l.startsWith("# ")) ?? "").slice(2), lines };
  });
  const total = d.pages ?? slides.length;
  const asked = c.prompt.normalize("NFC").split(f.path.normalize("NFC")).join(" ");   // "발표 자료/…pptx" is not a request for a table (표)
  const m = SLIDE_NTH.exec(asked);
  if (m) {
    const n = /마지막|last/i.test(m[0]) ? total : Number(m[1] ?? m[5] ?? m[6] ?? ORD[(m[4] ?? m[8] ?? "").toLowerCase()] ?? 0);
    const sl = slides[n - 1];
    if (!sl) return { answer: c.ko ? `이 발표 자료는 ${total}장이라 ${n}번째 슬라이드가 없어요.` : `The deck has ${total} slides; there is no slide ${n}.`, verified: true, detail: "no_such_slide" };
    // Only the title asked: answer with it; otherwise the slide as written.
    if (/(제목|title)/i.test(asked) && !/(내용|본문|표|노트|content|body|table|notes)/i.test(asked))
      return { answer: c.ko ? `${n}번째 슬라이드 제목: **${sl.title || "(제목 없음)"}**` : `Slide ${n} title: **${sl.title || "(no title)"}**`, verified: true, detail: `slide ${n} title` };
    return { answer: `**${c.ko ? `${n}번째 슬라이드` : `Slide ${n}`}${sl.title ? `: ${sl.title}` : ""}**\n\n${sl.lines.filter((l) => !l.startsWith("# ")).map((l) => (l.startsWith("|") || l.startsWith("(notes)") ? l : `- ${l}`)).join("\n").replace(/^\(notes\) /m, c.ko ? "\n발표자 노트: " : "\nSpeaker notes: ")}`, verified: true, detail: `slide ${n}` };
  }
  const rows = slides.map((sl, i) => `${i + 1}. ${sl.title || (c.ko ? "(제목 없음)" : "(no title)")}${sl.lines.some((l) => l.startsWith("|")) ? (c.ko ? " · 표" : " · table") : ""}${sl.lines.some((l) => l.startsWith("(notes)")) ? (c.ko ? " · 노트" : " · notes") : ""}`);
  return { answer: `${c.ko ? `\`${f.path}\`: ${total}장 (발표 순서)` : `\`${f.path}\`: ${total} slides (presentation order)`}\n\n${rows.join("\n")}`, verified: true, detail: `${total} slides` };
}

// ---------------------------------------------------------------- the user's own apps
async function openApp(c: SkillContext): Promise<SkillResult> {
  const A = await import("../context-builder/apps.ts");
  const K = c.ko;
  const why = (w: string) => (w === "request" ? (K ? "요청한 앱" : "the app you named") : w === "config" ? (K ? "~/OpenAFM/config/apps.json 설정" : "~/OpenAFM/config/apps.json") : (K ? "시스템 기본 앱" : "the system default"));
  const hint = K ? "\n\n_기본 앱을 바꾸려면 시스템 설정(브라우저·텍스트 파일), iTerm 메뉴의 **Make iTerm2 Default Term**(터미널), 또는 `~/OpenAFM/config/apps.json`에 `{\"terminal\": \"iTerm\", \"editor\": \"Cursor\"}`처럼 적으면 돼요._"
    : "\n\n_To change it: System Settings (browser, text files), iTerm's **Make iTerm2 Default Term** (terminal), or `~/OpenAFM/config/apps.json` such as `{\"terminal\": \"iTerm\", \"editor\": \"Cursor\"}`._";
  const doc = c.files.find((f) => existsSync(join(c.root, f.path)));
  if (OPEN_EDITOR.test(c.prompt) && doc && !OPEN_TERMINAL.test(c.prompt)) {
    const ch = await A.chooseApp("editor", c.prompt);
    if (!ch) return { answer: K ? "열 앱을 찾지 못했어요." : "No app found to open it with.", verified: false, detail: "no_editor" };
    const ok = await A.openWith(join(c.root, doc.path), ch);
    return { answer: (ok ? (K ? `\`${doc.path}\`를 **${A.appName(ch.app)}**에서 열었어요 (${why(ch.why)}).` : `Opened \`${doc.path}\` in **${A.appName(ch.app)}** (${why(ch.why)}).`) : (K ? "앱을 열지 못했어요." : "Could not open the app.")) + hint, verified: ok, detail: `editor ${A.appName(ch.app)} ${ch.why}` };
  }
  const ch = await A.chooseApp("terminal", c.prompt);
  if (!ch) return { answer: K ? "터미널 앱을 찾지 못했어요." : "No terminal app found.", verified: false, detail: "no_terminal" };
  const cwd = c.root || process.env.HOME || "/";
  // A background session of this project ("세션", "session", "로그"): attach to the newest one.
  let attach: string | undefined;
  if (/(세션|session|로그|log|tmux)/i.test(c.prompt) && c.root) {
    const { listSessions } = await import("../context-builder/sessions.ts");
    const { projectHash } = await import("../telemetry/telemetry.ts");
    const s = (await listSessions(projectHash(c.root))).find((x) => !x.dead);
    if (s) attach = s.name;
  }
  const ok = await A.openTerminal(cwd, attach ? `tmux -L openafm attach -t '${attach.replace(/'/g, "")}'` : undefined, ch);
  const where = c.root ? `\`${cwd.replace(process.env.HOME ?? "~", "~")}\`` : (K ? "홈 폴더" : "your home folder");
  return { answer: (ok ? (K ? `**${A.appName(ch.app)}**에서 ${where}를 열었어요${attach ? ` (백그라운드 세션 \`${attach}\`에 연결)` : ""} — ${why(ch.why)}.` : `Opened ${where} in **${A.appName(ch.app)}**${attach ? ` (attached to background session \`${attach}\`)` : ""}: ${why(ch.why)}.`) : (K ? "터미널을 열지 못했어요." : "Could not open the terminal.")) + hint,
    verified: ok, detail: `terminal ${A.appName(ch.app)} ${ch.why}${attach ? " attach" : ""}` };
}
