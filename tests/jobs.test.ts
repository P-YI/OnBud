import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ONBUD_HOME = mkdtempSync(join(tmpdir(), "onbud-home-"));
const J = await import("../services/controller/jobs.ts");
const { isJobRequest } = await import("../services/controller/controller.ts");
const { FakeAFM, makeRepo } = await import("./helpers.ts");

test("job intent, rename detection, test counting, test paths", () => {
  for (const p of ["utils.py에 is_valid_email 함수를 추가해줘", "Related Work 섹션을 새로 써서 넣어줘", "create a new file cli.py", "오프라인으로 작업 진행해줘", "textutil.py의 slugify와 word_count 함수를 구현해줘"]) assert.ok(isJobRequest(p), p);
  for (const p of ["conf2026_final.pdf는 몇 쪽이야?", "README.md 오타 고쳐줘", "논문 초록 작성법 알려줘", "함수 추가하는 방법 설명해줘", "How do I add a new file in git?", "새 파일 만드는 git 명령어가 뭐야?"]) assert.ok(!isJobRequest(p), p);
  assert.deepEqual(J.renameRequest("slugify 함수 이름을 make_slug로 바꿔줘"), { from: "slugify", to: "make_slug" });
  assert.deepEqual(J.renameRequest("rename the function parseRow to parse_row"), { from: "parseRow", to: "parse_row" });
  assert.equal(J.testCount("Ran 7 tests in 0.01s"), 7);
  assert.equal(J.testCount("==== 3 passed in 0.1s"), 3);
  assert.ok(J.isTestPath("tests/test_x.py") && J.isTestPath("src/a.test.ts") && !J.isTestPath("src/utils.py"));
});

test("anchors and inserts: Python blocks and LaTeX sections land in the right place", () => {
  const py = "import re\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n";
  const anchors = J.anchorsFor("m.py", py);
  assert.deepEqual(anchors.map((x) => x.label), ["top of file", "imports", "def a", "def b", "end of file"]);
  const out = J.insertAt("m.py", py, anchors.find((x) => x.label === "def a")!, "after", "def c():\n    return 3");
  assert.match(out, /return 1\n\n\ndef c\(\):\n    return 3\n\n\ndef b/);
  const tex = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nText.\n\\section{Method}\nM.\n\\bibliography{refs}\n\\end{document}\n";
  const ta = J.anchorsFor("main.tex", tex);
  const res = J.insertAt("main.tex", tex, ta.find((x) => x.label === "section: Intro")!, "after", "\\input{sections/related}");
  assert.match(res, /Text\.\n\n\\input\{sections\/related\}\n\n\\section\{Method\}/);
  const end = J.insertAt("main.tex", tex, ta.find((x) => x.label === "end{document}")!, "after", "X");
  assert.ok(end.indexOf("X") < end.indexOf("\\end{document}"));   // never after \end{document}
});

test("LaTeX blocks: citations only from .bib keys, special characters escaped", () => {
  const out = J.renderLatexBlock({ heading: "Related Work", paragraphs: [{ text: "Heads store 50% of facts & more \\cite{fake}.", cite_keys: ["k1", "invented"] }] }, ["k1", "k2"]);
  assert.match(out, /^\\section\{Related Work\}\nHeads store 50\\% of facts \\& more~\\cite\{k1\}\.\n$/);
});

test("offline job end to end: deterministic rename in a worktree branch, journal, apply only on request", async () => {
  const root = makeRepo({ "utils.py": "def slugify(t):\n    return t\n", "tests/__init__.py": "", "tests/test_u.py": "import unittest\nfrom utils import slugify\n\nclass T(unittest.TestCase):\n    def test_s(self):\n        self.assertEqual(slugify('a'), 'a')\n" });
  const afm = new FakeAFM(() => ({ failure: "empty" }));   // no model needed for a rename
  const p = await J.planJob(afm, { root, request: "rename slugify to make_slug", offline: true });
  assert.ok(p.ok);
  const job = await J.runJob(afm, (p as any).job);
  assert.equal(job.status, "done", JSON.stringify(job.steps));
  assert.equal(job.workspace.kind, "worktree");
  assert.match(readFileSync(join(job.workspace.work, "utils.py"), "utf8"), /def make_slug/);
  assert.match(readFileSync(join(root, "utils.py"), "utf8"), /def slugify/);           // main checkout untouched
  assert.match(readFileSync(J.journalPath(job.id), "utf8"), /## Step 1: rename_symbol[\s\S]*## Result: done/);
  const r = await J.applyJob(job);
  assert.ok(r.ok);
  assert.match(readFileSync(join(root, "tests/test_u.py"), "utf8"), /make_slug/);
  await J.discardJob(job);
  assert.ok(!existsSync(job.workspace.dir));
});

test("command help: detection, language, topics, unknown git commands", async () => {
  const H = await import("../services/controller/help.ts");
  for (const p of ["git 명령어 알려줘", "프레임워크 명령어 영어로 알려줘", "show me the commands", "git cherry-pick이 뭐야?", "스크립트 사용법"]) assert.ok(H.isHelpRequest(p), p);
  for (const p of ["utils.py에 함수 추가해줘", "현재 git 브랜치가 뭐야?"]) assert.ok(!H.isHelpRequest(p), p);
  assert.equal(H.helpLanguage("프레임워크 명령어 영어로 알려줘"), "en");
  assert.equal(H.helpLanguage("show commands in Korean"), "ko");
  assert.equal(H.helpTopic("git 명령어"), "git");
  assert.equal(H.unknownGitCommand("git cherry-pick이 뭐야?"), "git cherry-pick");
  assert.equal(H.unknownGitCommand("git status 설명해줘"), undefined);
  assert.match(H.renderHelp("git", "en"), /\| `git worktree list` \| List worktrees/);
});

test("failing test names are parsed so pre-existing failures do not block a job", () => {
  const out = "FAIL: test_count (tests.test_text.T.test_count)\nERROR: test_x (tests.test_y.T)\nFAILED tests/test_a.py::test_b - assert\nnot ok 3 - parses dates\n";
  assert.deepEqual([...J.failingTests(out)].sort(), ["parses dates", "tests.test_text.T.test_count::test_count", "tests.test_y.T::test_x", "tests/test_a.py::test_b"]);
});

test("v3 job routing classifiers: algorithmic, new code, rename", async () => {
  const { algorithmic, newCodeRequest } = await import("../services/controller/codegen.ts");
  const algorithmicRequest = (prompt: string) => algorithmic({ prompt });
  assert.equal(algorithmicRequest("graph.py에 다익스트라 최단 경로 알고리즘을 구현해줘"), true);
  assert.equal(algorithmicRequest("Implement an O(n log n) solution for the interval merge problem"), true);
  assert.equal(algorithmicRequest("src/text.py에 reverse_words 함수를 추가해줘"), false);
  assert.equal(algorithmicRequest("README에 설치 방법 섹션을 추가해줘"), false);
  assert.equal(newCodeRequest("CSV 합계를 반환하는 total_value 함수를 작성해줘"), true);
  assert.equal(newCodeRequest("write a function that parses dates"), true);
  assert.equal(newCodeRequest("slug 함수 이름을 make_slug로 바꿔줘"), false);
  assert.deepEqual(J.renameRequest("slug 함수 이름을 make_slug로 바꾸고 사용하는 곳도 모두 수정해줘"), { from: "slug", to: "make_slug" });
});

test("resolveImport rewrites a bare module to the project path that defines the names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imp-"));
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "text.py"), "def reverse_words(s):\n    return s\n\ndef slug(s):\n    return s\n");
  writeFileSync(join(dir, "util.py"), "def helper():\n    pass\n");
  assert.equal(J.resolveImport(dir, "from text import reverse_words"), "from src.text import reverse_words");
  assert.equal(J.resolveImport(dir, "from text import reverse_words, slug"), "from src.text import reverse_words, slug");
  assert.equal(J.resolveImport(dir, "from util import helper"), "from util import helper");    // module exists: unchanged
  assert.equal(J.resolveImport(dir, "from text import missing"), "from text import missing");  // no file defines it
});

test("selfContained: lean Codex agent only for hand-offs that need nothing from the project", async () => {
  const { selfContained } = await import("../services/controller/frontier-opencode.ts");
  assert.equal(selfContained("Write a Python function that merges overlapping intervals in O(n log n)."), true);
  assert.equal(selfContained("정규식으로 이메일 주소를 검증하는 함수를 작성해줘\n\n---\nLocal pre-analysis:\nGOAL: ..."), true);
  assert.equal(selfContained("src/text.py의 버그를 고쳐줘"), false);
  assert.equal(selfContained("이 프로젝트 구조를 설명해줘"), false);
  assert.equal(selfContained("Why does the last commit break the build?"), false);
  assert.equal(selfContained("Explain quicksort\n\n---\nLocal pre-analysis:\nGOAL: x\n\n[src/a.py]\ndef f(): ..."), false);
  assert.equal(selfContained("Explain quicksort\n\n---\nLocal pre-analysis:\nGOAL: x\n\n[git status]\nclean"), true);
});

test("copilot middle tier: codegen keeps Copilot's code only when the examples pass", async () => {
  const { solveAdaptive } = await import("../services/controller/code-skill.ts");
  const { execFileSync } = await import("node:child_process");
  const run = (prog: string) => { try { execFileSync("/usr/bin/python3", ["-I", "-c", prog], { stdio: "pipe" }); return Promise.resolve({ ok: true, out: "" }); } catch (e: any) { return Promise.resolve({ ok: false, out: String(e.stderr ?? "") }); } };
  const prompt = 'def add(a, b):\n    """Return a + b.\n    >>> add(1, 2)\n    3\n    """\n';
  const task = { prompt, kind: "function" as const, entry: "add", hasExamples: true, exec: run, examples: (code: string) => run(`${code}\nassert add(1, 2) == 3\n`) };
  const afm = { generate: async () => ({ ok: true, json: { approach: [], edge_cases: [], imports: [], body: ["    return a - b"] } }) } as any;
  let accepted = 0;
  const good = { complete: async () => ({ text: "    return a + b", item: { command: { command: "x" } } }), accept: () => { accepted++; }, close: () => {} };
  const r = await solveAdaptive(afm, task, { extra: false, fast: true, copilot: good as any });
  assert.equal(r.stage, "copilot"); assert.match(r.code, /return a \+ b/); assert.equal(accepted, 1);
  const bad = { complete: async () => ({ text: "    return a * b", item: {} }), accept: () => { accepted++; }, close: () => {} };
  const r2 = await solveAdaptive(afm, task, { extra: false, fast: true, copilot: bad as any });
  assert.equal(r2.stage, "first"); assert.equal(accepted, 1);
});

test("copilot middle tier: a failing function's body is rewritten in place, the rest of the file kept", async () => {
  const { copilotStep } = await import("../services/controller/jobs.ts");
  const { writeFileSync: w, mkdtempSync: md } = await import("node:fs");
  const work = md(join(tmpdir(), "cp-step-"));
  w(join(work, "stats.py"), 'def mean(xs):\n    """Average of xs."""\n    return sum(xs) / (len(xs) - 1)\n\n\ndef total(xs):\n    return sum(xs)\n');
  const seen: string[] = [];
  const fake = { complete: async (_p: string, _l: string, text: string, line: number) => { seen.push(text.split("\n")[line]); return seen.length === 1 ? { text: "    return sum(xs) / len(xs)", item: {} } : undefined; }, accept: () => {}, close: () => {} };
  const job = { request: "fix mean", workspace: { work }, steps: [] } as any;
  const r = await copilotStep(fake as any, job, { n: 1, action: "edit_file", path: "stats.py", description: "fix mean so it divides by len(xs)", status: "pending", notes: [] } as any, "AssertionError in test_mean");
  assert.equal(r?.what, "rewrote mean()");
  assert.equal(readFileSync(join(work, "stats.py"), "utf8"), 'def mean(xs):\n    """Average of xs."""\n    return sum(xs) / len(xs)\n\n\ndef total(xs):\n    return sum(xs)\n');
});

test("afm_code proposal: Copilot's change comes back as a diff with a syntax check; the project is untouched", async () => {
  const { copilotProposal } = await import("../services/controller/jobs.ts");
  const { writeFileSync: w, mkdtempSync: md } = await import("node:fs");
  const root = md(join(tmpdir(), "cp-prop-"));
  const orig = 'def double(x):\n    """Twice x."""\n    pass\n';
  w(join(root, "m.py"), orig);
  let accepted = 0;
  const fake = { complete: async () => ({ text: "    return 2 * x", item: {} }), accept: () => { accepted++; }, close: () => {} };
  const p = await copilotProposal(fake as any, root, "m.py", "implement double(x)");
  assert.match(p!.diff, /^-    pass$/m); assert.match(p!.diff, /^\+    return 2 \* x$/m);
  assert.equal(p!.syntax, undefined);
  assert.equal(readFileSync(join(root, "m.py"), "utf8"), orig);
  assert.equal(accepted, 0);   // shown, not accepted: the caller decides
});

test("copilotStep: every named function is written; a copied stub is retried with the task as a comment", async () => {
  const { copilotStep } = await import("../services/controller/jobs.ts");
  const { writeFileSync: w, mkdtempSync: md } = await import("node:fs");
  const work = md(join(tmpdir(), "cp-stubs-"));
  w(join(work, "t.py"), 'def alpha(x):\n    """A."""\n    raise NotImplementedError\n\n\ndef beta(x):\n    raise NotImplementedError\n');
  const fake = { complete: async (_p: string, _l: string, text: string, line: number) => {
    const before = text.split("\n").slice(0, line + 1).join("\n");
    if (/def alpha\(x\):\n    """A."""\n    $/.test(before)) return { text: "    raise NotImplementedError", item: {} };          // copied stub
    if (/# implement alpha and beta\n$/.test(before)) return { text: "    return x + 1", item: {} };
    if (/def beta\(x\):\n$/.test(before)) return { text: "    return x * 2", item: {} };
    return undefined; }, accept: () => {}, close: () => {} };
  const r = await copilotStep(fake as any, { request: "implement alpha and beta", workspace: { work }, steps: [] } as any,
    { n: 1, action: "edit_file", path: "t.py", description: "implement alpha and beta", status: "pending", notes: [] } as any, "");
  assert.equal(r?.what, "rewrote alpha(), beta()");
  assert.equal(readFileSync(join(work, "t.py"), "utf8"), 'def alpha(x):\n    """A."""\n    return x + 1\n\n\ndef beta(x):\n    return x * 2\n');
});

test("job check: a code step must define the functions the work names (a file with only an import fails)", async () => {
  const { missingDefinitions } = await import("../services/controller/jobs.ts");
  const { writeFileSync: w, mkdtempSync: md, mkdirSync: mk } = await import("node:fs");
  const work = md(join(tmpdir(), "defs-")); mk(join(work, "src"));
  w(join(work, "src/csvstats.py"), "import csv\n");
  w(join(work, "src/other.py"), "def helper(x):\n    return x\n");
  const job = { request: "새 파일 src/csvstats.py를 만들어서 total_value(path) 함수를 작성해줘", workspace: { work },
    steps: [{ n: 1, action: "create_file", path: "src/csvstats.py", description: "새 파일을 생성합니다", notes: [] }, { n: 2, action: "run_tests", description: "run", notes: [] }] } as any;
  assert.deepEqual(missingDefinitions(job, "src/csvstats.py"), ["total_value"]);
  w(join(work, "src/csvstats.py"), "import csv\n\ndef total_value(path):\n    return 0\n");
  assert.deepEqual(missingDefinitions(job, "src/csvstats.py"), []);
  // a name another file already defines is not this step's job; test files are not checked
  job.request = "use helper(x) in a new total_value(path)"; w(join(work, "src/csvstats.py"), "def total_value(path):\n    return helper(1)\n");
  assert.deepEqual(missingDefinitions(job, "src/csvstats.py"), []);
  assert.deepEqual(missingDefinitions(job, "tests/test_x.py"), []);
});

test("stress test: a candidate that passes the examples but disagrees with the brute force on a random input fails", async () => {
  const { stressTest, gate } = await import("../services/controller/code-skill.ts");
  const { execFileSync } = await import("node:child_process");
  const exec = async (program: string, stdin = "") => { try { return { ok: true, out: execFileSync("python3", ["-c", program], { input: stdin, encoding: "utf8", timeout: 10_000 }) }; } catch (e: any) { return { ok: false, out: String(e.stderr ?? "") }; } };
  // the task: print the maximum of n numbers; the "candidate" returns the first number (right on the example only)
  const task = { prompt: "Read n, then n integers. Print the largest.", kind: "program", exec,
    examples: async (code: string) => { const r = await exec(code, "3\n9 1 2\n"); return { ok: r.ok && r.out.trim() === "9", out: r.out }; } } as any;
  const candidate = "import sys\nd=sys.stdin.read().split()\nprint(d[1])\n";
  const brute = "    d = sys.stdin.read().split()\n    print(max(map(int, d[1:])))";
  const gen = "    n = rng.randint(1, 5)\n    return f\"{n}\\n\" + \" \".join(str(rng.randint(0, 10)) for _ in range(n)) + \"\\n\"";
  // one completion per file (as Copilot gives once the code is complete)
  const fake = () => { const done = new Set<string>(); return { complete: async (p: string, _l: string, text: string) => { if (done.has(p)) return undefined; done.add(p); return { text: /def gen\(rng\)/.test(text) ? gen : brute, item: {} }; }, accept: () => {}, close: () => {} }; };
  const r = await stressTest(fake() as any, task, candidate, { n: 8 });
  assert.equal(r.verdict, "fail", r.detail); assert.match(r.counter ?? "", /expected \(brute force\)/);
  const right = "import sys\nd=sys.stdin.read().split()\nprint(max(map(int, d[1:])))\n";
  const good = await stressTest(fake() as any, task, right, { n: 8 });
  assert.equal(good.verdict, "pass", good.detail);
  // the gate's policy: a pass keeps; an inconclusive retry is kept only when nothing can take it over
  const none = { complete: async () => undefined, accept: () => {}, close: () => {} } as any;
  const opts = { stress: true, reference: "copilot" as const, escalateInconclusive: true, patterns: "off" as const };
  assert.equal((await gate(fake() as any, task, right, { leaked: false, fallback: true, opts })).keep, true);
  assert.equal((await gate(none, task, right, { leaked: true, fallback: true, opts })).keep, false);
  assert.equal((await gate(none, task, right, { leaked: true, fallback: false, opts })).keep, true);
  assert.equal((await gate(none, { ...task, kind: "function", entry: "f", prompt: "def f(x):" }, right, { leaked: false, fallback: true, opts })).ran, false);
  const { runPython } = await import("../services/controller/sandbox.ts");
  // unchecked code (no examples): compared with a brute force; inconclusive is kept, a disagreement is not
  const fn = { prompt: "def biggest(xs):\n    \"\"\"Largest item of a non-empty list.\"\"\"\n", kind: "function" as const, entry: "biggest", exec: (p: string, i?: string) => runPython(p, i ?? "") };
  const fnFake = () => { const done = new Set<string>(); return { complete: async (p: string, _l: string, text: string) => { if (done.has(p)) return undefined; done.add(p); return { text: /def gen\(rng\)/.test(text) ? "    return json.dumps([rng.randint(0, 9) for _ in range(rng.randint(1, 5))])" : "    return max(xs)", item: {} }; }, accept: () => {}, close: () => {} }; };
  const wrongFn = "def biggest(xs):\n    return xs[0]\n";
  assert.equal((await gate(fnFake() as any, fn, wrongFn, { leaked: false, fallback: true, unverified: true, opts })).keep, false);
  assert.equal((await gate(none, fn, wrongFn, { leaked: false, fallback: true, unverified: true, opts })).keep, true);
});

test("code skill triage: one rule for who writes first (saver vs balanced)", async () => {
  const { firstWriter } = await import("../services/controller/code-skill.ts");
  const yes = async () => true, no = async () => false;
  const base = { algorithmic: false, newCode: true, checkable: false, copilot: yes, hardAt: 0.2 };
  assert.equal((await firstWriter({ ...base, d: 0.05, mode: "saver" })).writer, "local");          // unchecked, easy: Copilot + gate
  assert.equal((await firstWriter({ ...base, d: 0.05, mode: "balanced" })).writer, "frontier");    // balanced: Codex first
  assert.equal((await firstWriter({ ...base, d: 0.3, mode: "saver" })).writer, "frontier");        // unchecked and hard
  assert.equal((await firstWriter({ ...base, d: undefined, mode: "saver" })).writer, "frontier");  // no score: not trusted
  assert.equal((await firstWriter({ ...base, d: 0.3, checkable: true, algorithmic: true, mode: "balanced" })).writer, "local"); // checkable: Copilot first
  assert.equal((await firstWriter({ ...base, d: 0.05, copilot: no, mode: "saver" })).writer, "frontier"); // no Copilot
  assert.deepEqual(await firstWriter({ ...base, newCode: false, d: 0.05, mode: "balanced" }), { writer: "local", reason: "local_job" });
  // the difficulty classifier: hard contest code skips Copilot in balanced mode; saver and easy keep it local
  const contest = { ...base, d: 0.05, checkable: true, algorithmic: true };
  assert.deepEqual(await firstWriter({ ...contest, easy: false, mode: "balanced" }), { writer: "frontier", reason: "hard_contest" });
  assert.equal((await firstWriter({ ...contest, easy: true, mode: "balanced" })).writer, "local");
  assert.equal((await firstWriter({ ...contest, easy: undefined, mode: "balanced" })).writer, "local");   // no weights: as before
  assert.equal((await firstWriter({ ...contest, easy: false, mode: "saver" })).writer, "local");
  // unchecked new code: written locally when the caller can cross-check it against the cheap tier
  assert.equal((await firstWriter({ ...base, d: 0.05, mode: "balanced", crossCheck: true })).writer, "local");
});

test("code difficulty classifier: weights load, a beginner statement scores above a hard one", async () => {
  const { easyScore } = await import("../services/controller/code-difficulty.ts");
  const easy = "You are given two integers A and B. Print A + B.\n\nConstraints\n\n- 1 \\leq A, B \\leq 100\n- All input values are integers.";
  const hard = "You are given a tree with N vertices and Q queries. For each query, find the minimum cost path modulo 998244353 after updating edge weights, using dynamic programming on subsets of the shortest paths.\n\nConstraints\n\n- 2 \\leq N \\leq 2 \\times 10^5\n- 1 \\leq Q \\leq 2 \\times 10^5";
  const e = easyScore(easy), h = easyScore(hard);
  assert.ok(e !== undefined && h !== undefined && e > h, `${e} vs ${h}`);
  const { easyContest } = await import("../services/controller/code-difficulty.ts");
  assert.equal(easyContest("n개의 정수 중 최댓값을 구하는 함수를 만들어줘"), undefined);   // too few features: not judged
});

test("code skill ladder: the cheap tier is kept only when a check passes, else the strong tier answers", async () => {
  const { solveCode } = await import("../services/controller/code-skill.ts");
  const { runPython } = await import("../services/controller/sandbox.ts");
  const opts = { stress: true, reference: "copilot" as const, escalateInconclusive: true, patterns: "off" as const, cascade: true, contestCandidates: 1 };
  const triage = { mode: "balanced" as const, hardAt: 0.2 };
  const right = "def add(a, b):\n    return a + b\n", wrong = "def add(a, b):\n    return a - b\n";
  // with examples: Copilot's code fails them, so the ladder starts at the cheap tier
  const withEx = { prompt: 'def add(a, b):\n    """Return the sum of a and b."""\n', kind: "function" as const, entry: "add", hasExamples: true,
    exec: (p: string, i?: string) => runPython(p, i ?? ""), examples: async (code: string) => ({ ok: /return a \+ b/.test(code), out: "" }) };
  const bad = { complete: async () => ({ text: "    return a - b", item: {} }), accept: () => {}, close: () => {} } as any;
  const calls: string[] = [];
  const fr = (cheap: string) => async (t: "cheap" | "strong") => { calls.push(t); return t === "cheap" ? cheap : right; };
  let r = await solveCode(withEx, { copilot: bad, frontier: fr(right), opts, triage });
  assert.equal(r.tier, "cheap"); assert.deepEqual(calls, ["cheap"]);
  calls.length = 0;
  r = await solveCode(withEx, { copilot: bad, frontier: fr(wrong), opts, triage });
  assert.equal(r.tier, "strong"); assert.deepEqual(calls, ["cheap", "strong"]); assert.equal(r.code, right);
  // no examples: Copilot's code the gate cannot judge goes up; the cheap answer is kept when it agrees with it
  const fn = { prompt: 'def biggest(xs):\n    """Largest item of a non-empty list."""\n', kind: "function" as const, entry: "biggest", hasExamples: false, exec: (p: string, i?: string) => runPython(p, i ?? "") };
  const cop = () => { const done = new Set<string>(); return { complete: async (p: string, _l: string, text: string) => {
    if (done.has(p) || /_brute/.test(p)) return undefined; done.add(p);
    return { text: /def gen\(rng\)/.test(text) ? "    return json.dumps([rng.randint(0, 9) for _ in range(rng.randint(1, 5))])" : "    return max(xs)", item: {} }; }, accept: () => {}, close: () => {} } as any; };
  const agree = "def biggest(xs):\n    return sorted(xs)[-1]\n", disagree = "def biggest(xs):\n    return xs[0]\n";
  calls.length = 0;
  r = await solveCode(fn, { copilot: cop(), frontier: async (t) => { calls.push(t); return t === "cheap" ? agree : "def biggest(xs):\n    return max(xs)\n"; }, opts, triage });
  assert.equal(r.tier, "cheap", r.trace.join(" → ")); assert.deepEqual(calls, ["cheap"]);
  calls.length = 0;
  r = await solveCode(fn, { copilot: cop(), frontier: async (t) => { calls.push(t); return t === "cheap" ? disagree : "def biggest(xs):\n    return max(xs)\n"; }, opts, triage });
  assert.equal(r.tier, "strong", r.trace.join(" → ")); assert.deepEqual(calls, ["cheap", "strong"]);
});

test("job gate: a contest-style function in a job file is checked against a brute force; a main block is not run", async () => {
  const { gateJobCode } = await import("../services/controller/code-skill.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const work = mkdtempSync(join(tmpdir(), "afm-jobgate-"));
  const abs = join(work, "solve.py");
  const brute = "    return max(xs)";
  const gen = "    return json.dumps([rng.randint(0, 9) for _ in range(rng.randint(1, 5))])";
  const fake = () => { const done = new Set<string>(); return { complete: async (p: string, _l: string, text: string) => { if (done.has(p)) return undefined; done.add(p); return { text: /def gen\(rng\)/.test(text) ? gen : brute, item: {} }; }, accept: () => {}, close: () => {} }; };
  const request = "백준 스타일 알고리즘: max_of(xs)는 리스트의 최댓값을 돌려준다";
  writeFileSync(abs, 'def max_of(xs):\n    """Largest item."""\n    return xs[0]\n\n\nif __name__ == "__main__":\n    print(max_of(list(map(int, input().split()))))\n');
  const bad = await gateJobCode(fake() as any, { request, work, abs, fn: "max_of", leaked: false, fallback: false });
  assert.equal(bad?.verdict, "fail", bad?.detail); assert.equal(bad?.keep, false);
  writeFileSync(abs, 'def max_of(xs):\n    """Largest item."""\n    return max(xs)\n\n\nif __name__ == "__main__":\n    print(max_of(list(map(int, input().split()))))\n');
  const good = await gateJobCode(fake() as any, { request, work, abs, fn: "max_of", leaked: false, fallback: false });
  assert.equal(good?.verdict, "pass", good?.detail); assert.equal(good?.keep, true);
  // not contest-style and not a retry: not gated
  assert.equal(await gateJobCode(fake() as any, { request: "max_of 함수에 독스트링을 달아줘", work, abs, fn: "max_of", leaked: false, fallback: false }), undefined);
});
