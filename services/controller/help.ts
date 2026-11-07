// Command help in Korean or English: the framework's chat commands, terminal scripts, git basics and MCP
// tools, from a fixed catalogue (instant, always correct). A command that is not in the catalogue (e.g.
// "git cherry-pick 설명해줘") is explained by AFM, marked as such.

export type Lang = "ko" | "en";
export type Topic = "chat" | "scripts" | "git" | "mcp" | "all";

interface Entry { cmd: string; ko: string; en: string; cmdEn?: string }
const CATALOG: Record<Exclude<Topic, "all">, { title: { ko: string; en: string }; items: Entry[] }> = {
  chat: { title: { ko: "채팅에서 쓰는 말 (AFM 에이전트)", en: "Things to say in chat (AFM agent)" }, items: [
    { cmd: "<이름> 파일/폴더 찾아줘", cmdEn: "find the <name> file/folder", ko: "Mac 전체에서 이름으로 찾기(숨김 폴더 포함). 번호로 답하면 Finder에서 열어요", en: "Find files/folders by name across the Mac (hidden folders too); reply with a number to reveal in Finder" },
    { cmd: "이 폴더 문서 정리해줘 / <문서> 요약해줘", cmdEn: "describe the documents in this folder / summarize <doc>", ko: "문서 목록·요약, PDF·Word·PPT·이미지(OCR) 읽기", en: "Folder overview and document Q&A (PDF, Word, slides, images via OCR)" },
    { cmd: "<질문> 웹에서 찾아줘", cmdEn: "search the web for <question>", ko: "검색어를 보여 주고 승인 후 검색(SearXNG → DuckDuckGo, 논문은 arXiv)", en: "Web search after you approve the query (SearXNG → DuckDuckGo; papers via arXiv)" },
    { cmd: "`명령` 실행해줘", cmdEn: "run `command`", ko: "읽기 전용은 바로, 나머지는 승인 후 실행. 서버처럼 계속 도는 건 tmux 세션", en: "Read-only commands run now, others after approval; long-running ones in a tmux session" },
    { cmd: "세션 목록 / 로그 보여줘 / 세션 종료해줘", cmdEn: "list sessions / show the log / stop the session", ko: "백그라운드(tmux) 세션 관리", en: "Manage background (tmux) sessions" },
    { cmd: "<파일> 고쳐줘", cmdEn: "fix <file>", ko: "한 파일 작은 수정: diff → 샌드박스 테스트 → 승인 후 적용", en: "Small single-file fix: diff → sandbox test → apply on approval" },
    { cmd: "<파일> 만들어줘 / 함수·섹션 추가해줘", cmdEn: "create <file> / add a function or section to <file>", ko: "로컬 작업: 할 일 목록을 별도 git 브랜치에서 실행, 단계별 커밋·기록", en: "Local job: a to-do list run on its own git branch, a commit and journal entry per step" },
    { cmd: "로컬 작업 목록 / 작업 <id> 반영·검토·이어서·폐기", cmdEn: "local jobs / job <id> apply | review | continue | discard", ko: "작업 브랜치 관리. 검토는 Codex가 그 브랜치에서", en: "Manage job branches; review = Codex works inside that branch" },
    { cmd: "작업 비교 / 작업 <id> <id> 비교", cmdEn: "compare jobs / compare job <id> <id>", ko: "브랜치마다 테스트 실행 + 변경 규모 + Decima 판단", en: "Run the checks in each branch, show change size and Decima's pick" },
    { cmd: "논문 컴파일해줘 / 인용 확인해줘 / data.csv로 표 만들어줘", cmdEn: "compile the paper / check citations / make a table from data.csv", ko: "LaTeX 컴파일·오류 수정, 인용·참조 점검, booktabs 표", en: "LaTeX compile + fixes, citation/reference check, booktabs tables" },
    { cmd: "<file>.tex 3번째 줄 다듬어줘", cmdEn: "polish line 3 of <file>.tex", ko: "명령·인용·수식은 가리고 문장만 다듬기", en: "Polish prose with commands, citations and math masked" },
    { cmd: "Codex 제안에: 예 / 전환 / 브랜치 / 로컬 / 분석만 / 아니요", cmdEn: "to a Codex offer: yes / switch / branch / local / analyse only / no", ko: "예=Codex로 진행, 전환=이 대화를 codex로, 브랜치=Codex가 별도 브랜치에서, 로컬=AFM 작업, 분석만=읽기 전용", en: "yes = Codex, switch = this chat to codex, branch = Codex on its own branch, local = AFM job, analyse only = read-only" },
    { cmd: "명령어 알려줘 [영어로]", cmdEn: "show commands [in Korean]", ko: "이 도움말", en: "This help" },
  ] },
  scripts: { title: { ko: "터미널 스크립트 (~/OnBud/adaptive-coding-agent)", en: "Terminal scripts (~/OnBud/adaptive-coding-agent)" }, items: [
    { cmd: "scripts/doctor.sh", ko: "전체 상태 점검(서비스, 권한, TeX, Decima, SearXNG)", en: "Health check (services, permissions, TeX, Decima, SearXNG)" },
    { cmd: "scripts/afm-launchagent.sh restart|status [apfel|agent]", ko: "apfel·에이전트 서버 재시작/상태. 대상 없으면 둘 다", en: "Restart/status of apfel and the agent server (both if none given)" },
    { cmd: "scripts/decima-setup.sh start|stop|status|test", ko: "Decima(Ollaya, 11436) 실행·점검", en: "Run/check Decima (Ollaya on 11436)" },
    { cmd: "scripts/searxng-setup.sh start|stop|status", ko: "SearXNG(8888) 실행·점검", en: "Run/check SearXNG (8888)" },
    { cmd: "scripts/build-tools.sh", ko: "pdftext(PDF·OCR 도우미) 다시 빌드", en: "Rebuild pdftext (PDF/OCR helper)" },
    { cmd: "node --experimental-strip-types --experimental-sqlite bin/report.ts --days 7", ko: "텔레메트리 보고서(경로, 실패, Decima 일치율)", en: "Telemetry report (routes, failures, rules vs Decima)" },
    { cmd: "npm test", ko: "전체 테스트", en: "Run all tests" },
    { cmd: "tmux -L onbud attach -t <세션>", ko: "백그라운드 세션 직접 보기 (빠져나오기: Ctrl-b d)", en: "Watch a background session (detach: Ctrl-b d)" },
    { cmd: "/Applications/OpenCode.app/Contents/Resources/opencode-cli service restart", ko: "OpenCode 서비스 재시작(설정·플러그인 반영)", en: "Restart the OpenCode service (reload config/plugins)" },
  ] },
  git: { title: { ko: "git 기본 명령", en: "git basics" }, items: [
    { cmd: "git status", ko: "변경·스테이징 상태 보기", en: "Show changed and staged files" },
    { cmd: "git log --oneline -10", ko: "최근 커밋 10개", en: "Last 10 commits" },
    { cmd: "git diff [파일] / git diff --staged", ko: "아직 커밋 안 한 변경 / 스테이징된 변경", en: "Unstaged / staged changes" },
    { cmd: "git add <파일> && git commit -m \"메시지\"", ko: "변경을 스테이징하고 커밋", en: "Stage and commit" },
    { cmd: "git switch -c <브랜치> / git switch <브랜치>", ko: "새 브랜치 만들어 이동 / 브랜치 이동", en: "Create and switch / switch branch" },
    { cmd: "git branch -a", ko: "브랜치 목록 (AFM 작업은 afm/<id>)", en: "List branches (AFM jobs are afm/<id>)" },
    { cmd: "git worktree list", ko: "작업 폴더(worktree) 목록 — 로컬 작업마다 하나", en: "List worktrees — one per local job" },
    { cmd: "git worktree add <폴더> -b <브랜치> / git worktree remove <폴더>", ko: "별도 폴더에 브랜치 체크아웃 / 제거", en: "Check out a branch in another folder / remove it" },
    { cmd: "git stash / git stash pop", ko: "변경을 잠시 치워 두기 / 되돌리기", en: "Shelve changes / bring them back" },
    { cmd: "git apply -R <patch>", ko: "적용한 패치 되돌리기 (작업 반영 취소: runtime/jobs/<id>/changes.patch)", en: "Undo an applied patch (undo a job: runtime/jobs/<id>/changes.patch)" },
    { cmd: "git restore <파일>", ko: "⚠ 파일의 커밋 안 한 변경을 버림", en: "⚠ Discard uncommitted changes in a file" },
    { cmd: "git revert <커밋>", ko: "커밋을 되돌리는 새 커밋(이력 보존)", en: "New commit that undoes one (history kept)" },
    { cmd: "git reset --hard / git push --force", ko: "⚠ 되돌릴 수 없음 — 보안 게이트가 차단해요", en: "⚠ Irreversible — blocked by the security gate" },
  ] },
  mcp: { title: { ko: "Codex가 쓰는 로컬 도구 (MCP onbud)", en: "Local tools for Codex (MCP onbud)" }, items: [
    { cmd: "read_document", ko: "문서 읽기(OCR, 관련 쪽 찾기)", en: "Read documents (OCR, relevant pages)" },
    { cmd: "find_files", ko: "이름으로 파일 찾기", en: "Find files by name" },
    { cmd: "afm_summarize / afm_write", ko: "AFM 요약·초안(원문은 Mac에 남음)", en: "On-device summaries and drafts (raw text stays on the Mac)" },
    { cmd: "latex_check / latex_table / latex_polish", ko: "LaTeX 컴파일·점검, 표, 문장 다듬기", en: "LaTeX compile/check, tables, prose polish" },
  ] },
};

export function isHelpRequest(prompt: string): boolean {
  return /(명령어|커맨드|커멘드|사용법|도움말|쓰는 법|commands?\b|cheat ?sheet|usage|\bhelp\b|how (do|to) use)/i.test(prompt)
    || /^\s*git\s+[\w-]+.*(뭐야|설명|알려|무슨|뜻|what does|explain|meaning)/i.test(prompt) || /(설명|explain|뭐야|what does).*\bgit\s+[\w-]+/i.test(prompt);
}

export function helpLanguage(prompt: string): Lang {
  if (/(영어로|in english|english)/i.test(prompt)) return "en";
  if (/(한국어로|in korean|korean)/i.test(prompt)) return "ko";
  return /[\uac00-\ud7a3]/.test(prompt) ? "ko" : "en";
}

export function helpTopic(prompt: string): Topic {
  const p = prompt.toLowerCase();
  if (/\bgit\b|깃/.test(p)) return "git";
  if (/(스크립트|터미널|셸|쉘|script|terminal|shell|launchagent|doctor|decima|searxng)/.test(p)) return "scripts";
  if (/(mcp|codex.*도구|tools? for codex)/.test(p)) return "mcp";
  if (/(채팅|대화|chat|에이전트|agent|afm)/.test(p)) return "chat";
  return "all";
}

/** A specific git subcommand the catalogue does not cover ("git cherry-pick"), if asked. */
export function unknownGitCommand(prompt: string): string | undefined {
  const m = /\bgit\s+([a-z][\w-]*)/i.exec(prompt);
  if (!m) return undefined;
  const known = CATALOG.git.items.map((i) => i.cmd).join(" ");
  return new RegExp(`git ${m[1]}\\b`).test(known) ? undefined : `git ${m[1]}`;
}

export function renderHelp(topic: Topic, lang: Lang): string {
  const topics = topic === "all" ? (["chat", "scripts", "git", "mcp"] as const) : [topic];
  return topics.map((t) => {
    const c = CATALOG[t];
    const PH: Record<string, string> = { "<파일>": "<file>", "[파일]": "[file]", "<브랜치>": "<branch>", "<폴더>": "<dir>", "<커밋>": "<commit>", "\"메시지\"": "\"message\"", "<세션>": "<session>" };
    const cmdOf = (i: Entry) => (lang === "en" ? (i.cmdEn ?? Object.entries(PH).reduce((t, [k, v]) => t.split(k).join(v), i.cmd)) : i.cmd);
    const code = (t: string) => (t.includes("`") ? `\`\` ${t} \`\`` : `\`${t}\``).replace(/\|/g, "\\|");
    return `### ${c.title[lang]}\n\n| ${lang === "ko" ? "명령" : "Command"} | ${lang === "ko" ? "설명" : "What it does"} |\n|---|---|\n` + c.items.map((i) => `| ${code(cmdOf(i))} | ${i[lang].replace(/\|/g, "\\|")} |`).join("\n");
  }).join("\n\n");
}
