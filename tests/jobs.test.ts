import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAFM_HOME = mkdtempSync(join(tmpdir(), "openafm-home-"));
const J = await import("../services/controller/jobs.ts");
const { isJobRequest } = await import("../services/controller/controller.ts");
const { FakeAFM, makeRepo } = await import("./helpers.ts");

test("job intent, rename detection, test counting, test paths", () => {
  for (const p of ["utils.py에 is_valid_email 함수를 추가해줘", "Related Work 섹션을 새로 써서 넣어줘", "create a new file cli.py", "오프라인으로 작업 진행해줘"]) assert.ok(isJobRequest(p), p);
  for (const p of ["kcc2026_final.pdf는 몇 쪽이야?", "README.md 오타 고쳐줘", "논문 초록 작성법 알려줘", "함수 추가하는 방법 설명해줘", "How do I add a new file in git?", "새 파일 만드는 git 명령어가 뭐야?"]) assert.ok(!isJobRequest(p), p);
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
  const { algorithmicRequest, newCodeRequest } = await import("../services/controller/codegen.ts");
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
