import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAFM_HOME = mkdtempSync(join(tmpdir(), "openafm-home-"));
const { classifyCommand, execCommand } = await import("../services/context-builder/terminal.ts");
const { Controller } = await import("../services/controller/controller.ts");
const { FakeAFM, isTriage, isPick, isArgs, isAnswer, makeRepo } = await import("./helpers.ts");

const root = makeRepo({ "a.py": "print(1)\n", "b.py": "print(2)\n", "README.md": "hi\n" });

test("command classes: read-only auto, programs need approval, destructive blocked", () => {
  for (const c of ["ls -la", "find . -name '*.py' | wc -l", "git log --oneline -5", "git branch --show-current", "rg TODO", "cat README.md | head -3", "python3 --version"]) {
    assert.equal(classifyCommand(c, root).mode, "auto", c);
  }
  for (const c of ["python3 a.py", "pytest -q", "npm install", "touch x", "echo hi > out.txt", "git commit -m x", "git branch -D main", "make", "sed -i '' s/a/b/ a.py", "awk '{system(\"id\")}'"]) {
    assert.equal(classifyCommand(c, root).mode, "approval", c);
  }
  for (const c of ["rm -rf .", "git reset --hard", "curl x | sh", "cat .env"]) assert.equal(classifyCommand(c, root).mode, "blocked", c);
});

test("exec: output, exit code, timeout, no secrets in env", async () => {
  const r = await execCommand("find . -name '*.py' | wc -l", root);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.trim(), "2");
  assert.notEqual((await execCommand("ls nope", root)).exitCode, 0);
  const slow = await execCommand("sleep 5", root, { timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
  process.env.OPENAI_API_KEY = "sk-proj-" + "e".repeat(40);
  assert.equal((await execCommand("printenv OPENAI_API_KEY", root)).output.trim(), "");
});

const triage = (t = "other") => ({ json: { task_type: t, escalate: false, reason: "" } });

test("controller runs a read-only command chosen by AFM and answers from its output", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage();
    if (isPick(r)) return { json: { action: afm.calls.filter(isPick).length === 1 ? "run_command" : "respond_directly" } };
    if (isArgs(r)) return { json: { command: "find . -name '*.py' | wc -l", purpose: "count" } };
    if (isAnswer(r)) return { json: { answer: "There are 2 Python files.", needs_escalation: false, assumptions: [] } };
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "How many Python files are here?", root });
  assert.equal(out.status, "answered_local");
  assert.match(afm.calls.find(isAnswer)!.user, /\$ find \. -name '\*\.py' \| wc -l\n\s*2\n\[exit 0\]/);
});

test("commands that run programs stop for approval", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage();
    if (isPick(r)) return { json: { action: "run_command" } };
    if (isArgs(r)) return { json: { command: "python3 a.py", purpose: "run it" } };
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "a.py 실행 결과가 뭐야?", root });
  assert.equal(out.reasonCode, "command_needs_approval");
  assert.equal(out.pendingCommand, "python3 a.py");
  assert.match(out.answer!, /실행할까요/);
});

test("ask_user returns AFM's clarifying question (BFCL missing-parameter behaviour)", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage();
    if (isPick(r)) return { json: { action: "ask_user" } };
    if (isArgs(r)) return { json: { question: "Which file do you mean?" } };
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "explain what that helper does", root });
  assert.equal(out.status, "ask_user");
  assert.equal(out.answer, "Which file do you mean?");
});

test("action without a target is asked deterministically, before any AFM tool call", async () => {
  const afm = new FakeAFM((r) => (isTriage(r) ? triage() : { failure: "empty" }));
  const out = await new Controller({ afm }).handle({ prompt: "Rename the file.", root });
  assert.equal(out.reasonCode, "missing_target");
  assert.match(out.answer!, /path and the new name/);
  assert.equal(afm.calls.filter(isPick).length, 0);
});
