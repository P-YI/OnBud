import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.ONBUD_HOME = mkdtempSync(join(tmpdir(), "onbud-home-"));
const { applyEdit, applyToProject, detectTestCommand, proposeEdit, trialEdit, sha } = await import("../services/controller/edit-loop.ts");
const { isFindRequest, nameTerms, kindFromPrompt, isPrivate, fileUrl, findByName } = await import("../services/context-builder/finder.ts");
const S = await import("../services/context-builder/sessions.ts");
const { Controller } = await import("../services/controller/controller.ts");
const { FakeAFM, isTriage, makeRepo } = await import("./helpers.ts");

const isEdit = (r: any) => !!r.schema?.properties?.old_text;
const pyRepo = () => makeRepo({
  "calc.py": "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n",
  "tests/test_calc.py": "import unittest\nfrom calc import add, mul\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n",
});

test("applyEdit: exactly once, tolerant of trailing spaces, refuses ambiguity", () => {
  assert.deepEqual(applyEdit("a\nb\nc\n", "b", "B"), { ok: true, text: "a\nB\nc\n" });
  assert.equal((applyEdit("x\nx\n", "x", "y") as any).error, "old_text_not_unique");
  assert.equal((applyEdit("a  \nb\n", "a\nb", "z") as any).text, "z\n");
  assert.equal((applyEdit("abc", "zzz", "y") as any).error, "old_text_not_found");
  assert.equal((applyEdit("abc", "abc", "abc") as any).error, "no_change");
  // fuzzy: AFM retyped the docstring wrongly; the file keeps its own unchanged lines
  const src = 'def average(xs):\n    """Mean."""\n    total = sum(xs)\n    return total / (len(xs) - 1)\n\n\ndef other():\n    return 1\n';
  const r = applyEdit(src, 'def average(xs):\n    "Mean."\n    total = sum(xs)\n    return total / (len(xs) - 1)', 'def average(xs):\n    "Mean."\n    total = sum(xs)\n    return total / len(xs)') as any;
  assert.equal(r.fuzzy, true);
  assert.equal(r.text, src.replace("(len(xs) - 1)", "len(xs)"));
  assert.equal((applyEdit(src, "def nothing_like_this(q):\n    pass", "x") as any).error, "old_text_not_found");
});

test("test command detection: unittest when pytest is absent, matching test file first", () => {
  const root = pyRepo();
  const cmd = detectTestCommand(root, "calc.py")!;
  assert.match(cmd, /-m (pytest -q -x tests\/test_calc\.py|unittest -q tests\.test_calc)$/);
  assert.equal(detectTestCommand(makeRepo({ "README.md": "x" })), undefined);
  // test files at the project root, no path given (the controller's routing asks this way)
  assert.match(detectTestCommand(makeRepo({ "m.py": "x = 1\n", "test_m.py": "import unittest\n" }))!, /-m (pytest -q -x|unittest discover -q)$/);
});

test("sandbox trial: failing edit fails, correct edit passes, real file untouched until applied", async () => {
  const root = pyRepo();
  const before = readFileSync(join(root, "calc.py"), "utf8");
  const testCmd = detectTestCommand(root, "calc.py");
  const bad = { path: "calc.py", oldText: "    return a - b", newText: "    return a * b", explanation: "x", baseHash: sha(before) };
  const t1 = await trialEdit(root, bad, testCmd);
  assert.equal(t1.ok, false);
  assert.equal(t1.stage, "tests");
  const good = { ...bad, newText: "    return a + b" };
  const t2 = await trialEdit(root, good, testCmd);
  assert.equal(t2.ok, true, t2.result?.output);
  assert.match(t2.diff, /-    return a - b\n\+    return a \+ b/);
  assert.equal(readFileSync(join(root, "calc.py"), "utf8"), before);           // sandbox only
  assert.deepEqual(readdirSync(join(process.env.ONBUD_HOME!, "runtime", "sandbox")), []);   // clone removed
  const syntax = await trialEdit(root, { ...bad, newText: "    return (a +" }, testCmd);
  assert.equal(syntax.stage, "syntax");
  assert.deepEqual(applyToProject(root, good), { ok: true });
  assert.match(readFileSync(join(root, "calc.py"), "utf8"), /return a \+ b/);
  assert.equal(applyToProject(root, good).error, "file_changed_since_proposal");   // stale edits are refused
});

test("proposeEdit strips copied line numbers and rejects secret files", async () => {
  const root = makeRepo({ "a.py": "x = 1\n", ".env": "K=v\n" });
  const afm = new FakeAFM(() => ({ json: { old_text: "1| x = 1", new_text: "1| x = 2", explanation: "bump" } }));
  const p = await proposeEdit(afm, { root, path: "a.py", request: "set x to 2", system: "s" });
  assert.ok(p.ok);
  assert.match((p as any).diff, /-x = 1\n\+x = 2/);
  assert.match(((await proposeEdit(afm, { root, path: ".env", request: "r", system: "s" })) as any).error, /^blocked/);
});

test("controller small_edit: diff + sandbox offer, AFM edit never applied directly", async () => {
  const root = pyRepo();
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return { json: { task_type: "small_edit", escalate: false, reason: "" } };
    if (isEdit(r)) return { json: { old_text: "    return a - b", new_text: "    return a + b", explanation: "add 대신 빼기를 하고 있었어요." } };
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "calc.py의 add 버그 고쳐줘", root });
  assert.equal(out.reasonCode, "local_small_edit");
  assert.equal(out.isProposal, true);
  assert.match(out.answer!, /```diff[\s\S]*\+    return a \+ b[\s\S]*샌드박스/);
  assert.equal(out.pendingEdit!.edit.path, "calc.py");
  assert.match(readFileSync(join(root, "calc.py"), "utf8"), /a - b/);
  // approved trial: the failing first edit gets the test output and a second attempt
  let n = 0;
  const afm2 = new FakeAFM((r) => (isEdit(r) ? { json: { old_text: "    return a - b", new_text: "    return a + b", explanation: `fix ${++n}` } } : { failure: "empty" }));
  const c2 = new Controller({ afm: afm2 });
  const tr = await c2.runEditTrial(root, "fix add", { edit: { ...out.pendingEdit!.edit, newText: "    return a * b" }, testCmd: out.pendingEdit!.testCmd });
  assert.equal(tr.attempts, 2);
  assert.equal(tr.trial.ok, true);
  assert.match(afm2.calls[0].user, /IT FAILED THE TESTS/);
});

test("find requests: detection, name terms, kinds, privacy filter, Finder URLs", async () => {
  assert.ok(isFindRequest(".cache 폴더 찾아줘"));
  assert.ok(isFindRequest("TimeShift pdf 파일 어디 있어?"));
  assert.ok(isFindRequest("find the file routing.yaml"));
  assert.ok(!isFindRequest("where is f1_macro defined"));
  assert.ok(!isFindRequest("3 더하기 4는?"));
  assert.deepEqual(nameTerms(".cache 폴더 찾아줘"), [".cache"]);
  assert.deepEqual(nameTerms("find my huggingface cache folder"), ["huggingface", "cache"]);
  assert.equal(kindFromPrompt("TimeShift pdf 파일 어디 있어?"), "pdf");
  assert.equal(kindFromPrompt(".cache 폴더 찾아줘"), "folder");
  const h = homedir();
  for (const p of [".ssh/id_ed25519", ".zsh_history", "Library/Mail/V10", ".codex/auth.json", "OnBud/config/apfel.token", "proj/.env", "x/api_token.txt"]) assert.ok(isPrivate(join(h, p)), p);
  for (const p of [".cache/huggingface", "Desktop/paper.pdf", ".config/opencode"]) assert.ok(!isPrivate(join(h, p)), p);
  assert.equal(fileUrl("/Users/a/My Docs (old)", true), "file:///Users/a/My%20Docs%20%28old%29/");
  const found = await findByName([".ssh", "id_ed25519"], { max: 5 });
  assert.ok(found.every((f) => !/\.ssh|id_ed25519/.test(f.path)));
});

test("tmux sessions: start, read (redacted), type into a REPL, stop; long-running detection", { skip: !(await S.hasTmux()) }, async () => {
  const ph = "0123456789abcdef";
  const dir = mkdtempSync(join(tmpdir(), "afm-sess-"));
  writeFileSync(join(dir, "run.sh"), "echo start; echo OPENAI_API_KEY=sk-proj-" + "q".repeat(40) + "; sleep 30\n");
  const s1 = await S.startSession(ph, dir, "sh run.sh", "job");
  assert.ok(s1.ok, s1.error);
  const out = await S.settle(s1.name!, 3000);
  assert.match(out, /start/);
  assert.ok(!out.includes("q".repeat(40)));
  const repl = await S.startSession(ph, dir, "python3", "repl");
  await S.settle(repl.name!, 2000);
  await S.sendToSession(repl.name!, "print(6*7)");
  await new Promise((r) => setTimeout(r, 800));
  assert.match(await S.readSession(repl.name!, 5), /42/);
  assert.equal((await S.listSessions(ph)).length, 2);
  assert.equal(await S.stopSession("not-ours"), false);
  for (const s of await S.listSessions(ph)) assert.ok(await S.stopSession(s.name));
  assert.equal((await S.listSessions(ph)).length, 0);
  assert.ok(S.isLongRunning("npm run dev") && S.isLongRunning("python3 -m http.server 8000") && S.isLongRunning("tail -f x.log"));
  assert.ok(!S.isLongRunning("pytest -q") && !S.isLongRunning("ls -la"));
});

test("LaTeX escape slips in AFM edits are repaired", () => {
  const src = "Language models store \\textbff{time} facts.\n";
  assert.equal((applyEdit(src, "\\\\textbff{time}", "\\\\textbf{time}") as any).text, "Language models store \\textbf{time} facts.\n");   // doubled backslashes
  assert.equal((applyEdit(src, "\textbff{time}", "\textbf{time}") as any).text, "Language models store \\textbf{time} facts.\n");                 // \t became a tab
  assert.equal((applyEdit(src, "Language models store \\textbff{time} fact.", "Language models store \\textbf{time} facts.") as any).fuzzy, true);   // one-line fuzzy
});

test("LaTeX edits must keep \\cite/\\ref/\\label keys", async () => {
  const { latexKeysLost } = await import("../services/controller/edit-loop.ts");
  const before = "Facts \\cite{a,b} in Table~\\ref{tab:x}.\\label{sec:i}";
  assert.deepEqual(latexKeysLost(before, "Facts are shown \\cite{a,b} in Table~\\ref{tab:x}.\\label{sec:i}"), []);
  assert.deepEqual(latexKeysLost(before, "Facts \\textit{a,b} in Table~\\ref{tab:x}.\\label{sec:i}"), ["\\cite{a}", "\\cite{b}"]);
});
