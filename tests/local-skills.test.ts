import { test } from "node:test";
import assert from "node:assert/strict";
const { detectLocalSkill, runLocalSkill, parseTraceback, dateMentions, findPersonalData } = await import("../services/controller/local-skills.ts");

test("detectLocalSkill: one skill per request type, none for unrelated requests", () => {
  const F = (p: string) => [{ path: p }];
  assert.equal(detectLocalSkill("스테이징된 변경사항으로 커밋 메시지 써줘", []), "commit_message");
  assert.equal(detectLocalSkill("아직 커밋 안 된 변경사항을 요약해줘", []), "change_summary");
  assert.equal(detectLocalSkill("최근 커밋 3개로 릴리스 노트 만들어줘", []), "release_notes");
  assert.equal(detectLocalSkill("logs/error.log 에러 원인이 뭐야?", F("logs/error.log")), "error_triage");
  assert.equal(detectLocalSkill("docs/meeting.md에서 할 일, 담당자, 마감일을 표로 정리해줘", F("docs/meeting.md")), "extract_table");
  assert.equal(detectLocalSkill("docs/intro.ko.md를 영어로 번역해줘", F("docs/intro.ko.md")), "translate");
  assert.equal(detectLocalSkill("src/billing.py 함수들에 docstring 추가해줘", F("src/billing.py")), "docstrings");
  assert.equal(detectLocalSkill("docs/contacts.md를 외부에 공유해도 될까?", F("docs/contacts.md")), "privacy_scan");
  assert.equal(detectLocalSkill("data.csv를 JSON으로 변환해서 저장해줘", F("data.csv")), "csv_json");
  assert.equal(detectLocalSkill("What are the 3 most recent commit messages?", []), undefined);   // own suite C5
  assert.equal(detectLocalSkill("What did I change since the last commit? Give me a short overview.", []), "change_summary");   // Q2
  assert.equal(detectLocalSkill("docs/contacts.md에 민감한 정보 있어? 메일로 보내도 되나", F("docs/contacts.md")), "privacy_scan");   // Q8
  assert.equal(detectLocalSkill("Write a commit message for the staged changes", []), "commit_message");
  assert.equal(detectLocalSkill("src/stats.py의 mean 함수 고쳐줘", F("src/stats.py")), undefined);
  assert.equal(detectLocalSkill("notes.md 요약해줘", F("notes.md")), undefined);
  assert.equal(detectLocalSkill("논문 컴파일해줘", []), undefined);
});

test("parseTraceback: last traceback, frames, exception", () => {
  const t = `noise\nTraceback (most recent call last):\n  File "/srv/a.py", line 1, in <module>\n    x()\n  File "/srv/src/stats.py", line 2, in mean\n    return 1 / 0\nZeroDivisionError: division by zero\nmore`;
  const r = parseTraceback(t)!;
  assert.equal(r.exc, "ZeroDivisionError");
  assert.equal(r.msg, "division by zero");
  assert.deepEqual(r.frames.map((f) => [f.file, f.line, f.fn]), [["/srv/a.py", 1, "<module>"], ["/srv/src/stats.py", 2, "mean"]]);
  assert.equal(parseTraceback("no trace here"), undefined);
});

test("dateMentions: Korean, numeric, English month and ISO forms share one key", () => {
  const keys = (s: string) => dateMentions(s).map((d) => d.key);
  assert.deepEqual(keys("11월 5일까지"), ["11-5"]);
  assert.deepEqual(keys("by Nov 7."), ["11-7"]);
  assert.deepEqual(keys("11/10까지"), ["11-10"]);
  assert.deepEqual(keys("2026-11-05"), ["11-5"]);
  assert.deepEqual(keys("version 1.2/3.4"), []);
});

test("findPersonalData: email, phones, resident id, Luhn card, IP, secret; not plain numbers", () => {
  const t = "a: minsu.kim@example.com, 010-1234-5678\nb: +1 415 555 0134\nc: 900101-1234567\nd: 4111 1111 1111 1111\ne: 1234 5678 9012 3456\nf: 192.168.0.12\ng: OPENAI_API_KEY=sk-proj-" + "q".repeat(40) + "\nh: room 401, 2026";
  const k = findPersonalData(t).map((x) => `${x.line}:${x.kind}`);
  for (const want of ["1:email", "1:phone", "2:phone", "3:resident_id", "4:card", "6:ip", "7:secret"]) assert.ok(k.includes(want), `${want} in ${k}`);
  assert.ok(!k.includes("5:card"), "non-Luhn number is not a card");
  assert.ok(!k.some((x) => x.startsWith("8:")), "room numbers and years are not personal data");
});

test("change_summary: a new folder is listed by its files, not read as one file", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "ls-dir-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q"); writeFileSync(join(root, "a.txt"), "a\n"); g("add", "."); g("commit", "-qm", "init");
  mkdirSync(join(root, "apps", "x"), { recursive: true }); writeFileSync(join(root, "apps", "x", "main.swift"), "print(1)\n");
  const afm = { generate: async () => ({ ok: true, json: { files: [{ path: "apps/x/", change: "new app" }], overall: "adds an app" } }) } as any;
  const r = await runLocalSkill("change_summary", { afm, root, prompt: "what did I change since the last commit?", files: [], ko: false });
  assert.match(r.answer, /\| `apps\/` \| new folder \| new app \| 1 files \(\.swift 1\) \|/);
});

test("change_summary: every changed file gets a row, AFM in batches of four, size from code when AFM fails", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "ls-many-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q");
  for (let i = 0; i < 14; i++) writeFileSync(join(root, `f${i}.py`), `def f${i}():\n    return ${i}\n`);
  g("add", "."); g("commit", "-qm", "init");
  for (let i = 0; i < 14; i++) writeFileSync(join(root, `f${i}.py`), `def f${i}():\n    return ${i + 1}\n`);
  let calls = 0;
  const afm = { generate: async (req: any) => { calls++; if (calls === 2) return { ok: false }; const paths = [...req.system.matchAll(/f\d+\.py/g)].map((m: any) => m[0]); return { ok: true, json: { files: paths.map((p: string) => ({ path: p, change: `changes ${p}` })), change: "one file", overall: "bumps values" } }; } } as any;
  const r = await runLocalSkill("change_summary", { afm, root, prompt: "summarize my uncommitted changes", files: [], ko: false });
  const rows = r.answer.split("\n").filter((l) => l.startsWith("| `"));
  assert.equal(rows.length, 14);
  assert.equal(calls, 9);   // 4 batches, 4 single retries for the failed batch, overall
  assert.ok(rows.every((l) => /\+1 −1 \|$/.test(l)));
  assert.equal(rows.filter((l) => l.includes("| – |")).length, 0);
});

test("detectLocalSkill: git state, worktrees, remote comparison, GitHub; how-to questions stay help", () => {
  assert.equal(detectLocalSkill("현재 git 상태를 설명해줘", []), "git_overview");
  assert.equal(detectLocalSkill("git worktree 상황을 알려줘", []), "git_overview");
  assert.equal(detectLocalSkill("GitHub 원격 저장소와 비교해서 로컬이 어떻게 다른지 설명해줘", []), "git_overview");
  assert.equal(detectLocalSkill("Am I ahead or behind origin? What would I need to do before pushing?", []), "git_overview");
  assert.equal(detectLocalSkill("git worktree 사용법 알려줘", []), undefined);
  assert.equal(detectLocalSkill("열린 PR 목록이랑 CI 상태 보여줘", []), "github_status");
  assert.equal(detectLocalSkill("깃허브 이슈 상태 알려줘", []), "github_status");
});

test("git_overview: ahead/behind with commits, worktree changes, next steps; fetch asked when stale", async () => {
  const { mkdtempSync, writeFileSync, appendFileSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const base = mkdtempSync(join(tmpdir(), "ls-git-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, stdio: "pipe" });
  g(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  g(base, "init", "-q", "-b", "main", "repo");
  const repo = join(base, "repo");
  g(repo, "remote", "add", "origin", "../origin.git");
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n"); g(repo, "add", "."); g(repo, "commit", "-qm", "Add calc"); g(repo, "push", "-q", "-u", "origin", "main");
  g(base, "clone", "-q", "origin.git", "other"); writeFileSync(join(base, "other", "README.md"), "# Calc\n"); g(join(base, "other"), "add", "."); g(join(base, "other"), "commit", "-qm", "Add README"); g(join(base, "other"), "push", "-q", "origin", "main");
  appendFileSync(join(repo, "calc.py"), "def sub(a, b):\n    return a - b\n"); g(repo, "commit", "-qam", "Add sub");
  g(repo, "fetch", "-q");
  g(repo, "worktree", "add", "-q", "-b", "feat/mul", "../wt-mul"); appendFileSync(join(base, "wt-mul", "calc.py"), "def mul(a, b):\n    return a * b\n");
  writeFileSync(join(repo, "scratch.py"), "x = 1\n");
  const afm = { generate: async () => ({ ok: false }) } as any;
  const r = await runLocalSkill("git_overview", { afm, root: repo, prompt: "GitHub 원격과 비교해서 로컬이 어떻게 다른지 설명해줘", files: [], ko: true });
  assert.match(r.answer, /\*\*main\*\* @ `\w+` → `origin\/main`: 앞섬 1, 뒤처짐 1/);
  assert.match(r.answer, /올리지 않은 커밋:\n- \w+ Add sub/);
  assert.match(r.answer, /원격에만 있는 커밋:\n- \w+ Add README/);
  assert.match(r.answer, /\| feat\/mul \| \w+ \| 1 \| ok \|/);
  assert.match(r.answer, /git pull --rebase/);
  assert.equal(r.pendingCommand, undefined);   // fetched just now
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(repo, ".git", "FETCH_HEAD"), old, old);
  const r2 = await runLocalSkill("git_overview", { afm, root: repo, prompt: "Am I ahead or behind origin?", files: [], ko: false });
  assert.equal(r2.pendingCommand, "git fetch --prune");
  const r3 = await runLocalSkill("git_overview", { afm, root: repo, prompt: "Am I ahead or behind origin?", files: [], ko: false, history: "user approved and the controller ran:\n$ git fetch --prune\n(no output)\n[exit 0]" });
  assert.equal(r3.pendingCommand, undefined);
});

test("github_status: no GitHub remote is explained without calling gh", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "ls-gh-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  const r = await runLocalSkill("github_status", { afm: {} as any, root, prompt: "열린 PR 보여줘", files: [], ko: true });
  assert.match(r.answer, /GitHub 원격이 없어요/);
});

test("detectLocalSkill: Mac health check, Korean and English; not a how-to", () => {
  assert.equal(detectLocalSkill("맥북 상태 점검해줘", []), "mac_health");
  assert.equal(detectLocalSkill("배터리 상태 어때?", []), "mac_health");
  assert.equal(detectLocalSkill("Run a health check on my Mac", []), "mac_health");
  assert.equal(detectLocalSkill("시스템 상태 점검 명령어가 뭐야? 사용법 알려줘", []), undefined);
  assert.equal(detectLocalSkill("현재 git 상태를 설명해줘", []), "git_overview");
});

test("open_app: terminal and editor requests detected; named apps found; questions are not actions", async () => {
  const { appInRequest, chooseApp } = await import("../services/context-builder/apps.ts");
  assert.equal(detectLocalSkill("터미널 열어줘", []), "open_app");
  assert.equal(detectLocalSkill("iTerm으로 이 폴더 열어줘", []), "open_app");
  assert.equal(detectLocalSkill("open a terminal here", []), "open_app");
  assert.equal(detectLocalSkill("백그라운드 세션을 터미널에서 열어줘", []), "open_app");
  assert.equal(detectLocalSkill("README.md를 VS Code로 열어줘", [{ path: "README.md" }]), "open_app");
  assert.equal(detectLocalSkill("터미널에서 git log 보는 법 알려줘", []), undefined);
  assert.match(appInRequest("iTerm으로 열어줘") ?? "", /iTerm/);
  assert.equal(appInRequest("터미널 열어줘"), undefined);   // the generic word follows the default
  assert.match((await chooseApp("terminal", "터미널 열어줘"))?.app ?? "", /\.app$/);
});

test("security_check: real secrets with git state, placeholders and ignored files not reported as leaks", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { _test, placeholder } = await import("../services/controller/security-check.ts");
  assert.equal(detectLocalSkill("로컬 보안 점검해줘", []), "security_check");
  assert.equal(detectLocalSkill("비밀번호 유출 가능성 확인해줘", []), "security_check");
  assert.equal(detectLocalSkill("Scan this repo for leaked secrets", []), "security_check");
  assert.equal(detectLocalSkill("맥북 상태 점검해줘", []), "mac_health");
  const root = mkdtempSync(join(tmpdir(), "sec-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, env, stdio: "pipe" });
  g("init", "-q"); mkdirSync(join(root, "src")); mkdirSync(join(root, "keys"));
  writeFileSync(join(root, "src", "conf.py"), 'AWS = "AKIAQ3EGRT7XK4MZPL2N"\nDB_PASSWORD = "Xk9#mQ2vL!pR7zW4"\npassword = "changeme"\nAPI_KEY = "your-api-key-here"\n');
  writeFileSync(join(root, "README.md"), "export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n");
  writeFileSync(join(root, "keys", "deploy"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n");
  writeFileSync(join(root, ".gitignore"), ".env\n"); writeFileSync(join(root, ".env"), "LOCAL_SECRET=Gh7Lk2Pq9Zx4Vb8N\n");
  g("add", "."); g("commit", "-qm", "init");
  writeFileSync(join(root, "new.cfg"), "TOKEN=Zt8Qw3Er6Ty9Ui2Op\n");
  const f = await _test.projectFindings(root);
  const by = (where: string) => f.find((x) => x.where === where);
  assert.equal(by("src/conf.py:1")?.severity, "high");
  assert.equal(by("src/conf.py:2")?.severity, "medium");
  assert.equal(by("keys/deploy:1")?.severity, "high");
  assert.equal(by("new.cfg:1")?.severity, "medium");   // not committed yet
  assert.equal(by(".env:1")?.severity, "ok");          // ignored
  assert.equal(by("src/conf.py:3") ?? by("src/conf.py:4") ?? by("README.md:1"), undefined);   // placeholders
  assert.ok(f.every((x) => !/Xk9#mQ2v|AKIAQ3EG|Zt8Qw3/.test(x.what)));   // values masked
  assert.ok(placeholder("assignment", "${DB_PASS}") && !placeholder("assignment", "Xk9#mQ2vL!pR7zW4"));
});
