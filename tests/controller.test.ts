import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAFM_HOME = mkdtempSync(join(tmpdir(), "openafm-home-"));   // keep test logs out of the real runtime
const { Controller, identifiers, mentionedFiles } = await import("../services/controller/controller.ts");
const { FakeAFM, isTriage, isPick, isArgs, isAnswer, makeRepo } = await import("./helpers.ts");

const root = makeRepo({
  "src/metrics.py": "import sklearn.metrics as skm\n\ndef f1_macro(y, p):\n    return skm.f1_score(y, p, average='macro')\n",
  "README.md": "demo\n",
});

const triage = (task_type: string, escalate = false) => ({ json: { task_type, escalate, reason: "r" } });

class FakeFrontier {
  name = "fake-frontier";
  prompts: string[] = [];
  async run(p: string) { this.prompts.push(p); return { ok: true, text: "frontier answer" }; }
}

test("prompt parsing helpers", () => {
  assert.deepEqual(mentionedFiles("look at src/metrics.py:3 and missing.py", root), [{ path: "src/metrics.py", line: 3 }]);
  assert.deepEqual(mentionedFiles("lines in README.md?", root), [{ path: "README.md", line: undefined }]);
  assert.deepEqual(identifiers("why does `f1_macro` fail in trainLoop?"), ["f1_macro", "trainLoop"]);
});

test("local path: seed → guided tool → respond → schema answer", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("code_explain");
    if (isPick(r)) return { json: { action: afm.calls.filter(isPick).length === 1 ? "read_file" : "respond_directly" } };
    if (isArgs(r)) return { json: { path: "src/metrics.py", start_line: 1, end_line: 4 } };
    if (isAnswer(r)) return { json: { answer: "f1_macro wraps skm.f1_score (src/metrics.py:3)", needs_escalation: false, assumptions: [] } };
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "Explain `f1_macro`", root });
  assert.equal(out.status, "answered_local");
  assert.equal(out.route, "LOCAL_AFM");
  assert.match(out.answer!, /src\/metrics\.py:3/);
  const final = afm.calls.find(isAnswer)!;
  assert.match(final.user, /search "f1_macro"/);    // deterministic seed
  assert.match(final.user, /3\| def f1_macro/);      // tool observation from read_file
  assert.ok(out.capsuleTokens! < 5500);
  assert.match(final.system, /Skill: code explanation/);   // one task-specific skill injected
  assert.equal(out.skill, "code-explain");
  assert.match(out.policyHash, /^[0-9a-f]{12}$/);
});

test("nothing seeded → first step must call a tool", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("code_explain");
    if (isPick(r)) return { json: { action: r.schema!.properties!.action.enum!.includes("respond_directly") ? "respond_directly" : "find_files" } };
    if (isArgs(r)) return { json: { query: "readme" } };
    return { json: { answer: "a", needs_escalation: false, assumptions: [] } };
  });
  await new Controller({ afm }).handle({ prompt: "what is this project about", root });
  const firstPick = afm.calls.find(isPick)!;
  assert.ok(!firstPick.schema!.properties!.action.enum!.includes("respond_directly"));
});

test("tool loop terminates within budget", async () => {
  const patterns = ["import", "return", "demo", "sklearn"];   // distinct observations, so only the budget stops it
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("code_explain");
    if (isPick(r)) return { json: { action: "search_code" } };
    if (isArgs(r)) return { json: { pattern: patterns.shift(), glob: "*" } };
    return { json: { answer: "a", needs_escalation: false, assumptions: [] } };
  });
  const out = await new Controller({ afm, budget: { maxRounds: 3 } }).handle({ prompt: "explain `f1_macro`", root });
  assert.equal(out.steps.filter((s) => s.kind === "tool").length, 3);
  assert.equal(out.status, "answered_local");
});

test("phrase searches are widened to all files and single words", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("code_explain");
    if (isPick(r)) return { json: { action: afm.calls.filter(isPick).length === 1 ? "search_code" : "respond_directly" } };
    if (isArgs(r)) return { json: { pattern: "sklearn metric module", glob: "*.js" } };
    return { json: { answer: "a", needs_escalation: false, assumptions: [] } };
  });
  await new Controller({ afm }).handle({ prompt: "where do we import the metrics library", root });
  const final = afm.calls.find(isAnswer)!;
  assert.match(final.user, /widened from "sklearn metric module" \*\.js/);
  assert.match(final.user, /src\/metrics\.py:1: import sklearn/);
});

test("repeated observation stops the loop", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("code_explain");
    if (isPick(r)) return { json: { action: "search_code" } };
    if (isArgs(r)) return { json: { pattern: "zzz_nothing", glob: "*" } };
    return { json: { answer: "a", needs_escalation: false, assumptions: [] } };
  });
  const out = await new Controller({ afm }).handle({ prompt: "explain `f1_macro`", root });
  assert.ok(out.steps.some((s) => s.detail === "repeated_observation"));
});

test("AFM triage escalation routes to frontier; frontier not called unless allowed", async () => {
  const afm = new FakeAFM((r) => isTriage(r) ? triage("design", true) : { failure: "empty" });
  const frontier = new FakeFrontier();
  const c = new Controller({ afm, frontier });
  const held = await c.handle({ prompt: "Redesign the whole training pipeline", root });
  assert.equal(held.status, "escalation_required");
  assert.equal(frontier.prompts.length, 0);
  assert.ok(held.capsule);
  const sent = await c.handle({ prompt: "Redesign the whole training pipeline", root, allowFrontier: true });
  assert.equal(sent.status, "answered_frontier");
  assert.match(frontier.prompts[0], /Local pre-analysis/);
});

test("AFM failures become escalations, never silent answers", async () => {
  for (const failAt of [isPick, isArgs, isAnswer]) {
    const afm = new FakeAFM((r) => {
      if (isTriage(r)) return triage("code_explain");
      if (failAt(r)) return { failure: "timeout" };
      if (isPick(r)) return { json: { action: "read_file" } };
      if (isArgs(r)) return { json: { path: "README.md", start_line: 1, end_line: 2 } };
      return { json: { answer: "a", needs_escalation: false, assumptions: [] } };
    });
    const out = await new Controller({ afm }).handle({ prompt: "explain `f1_macro`", root });
    assert.equal(out.status, "escalation_required");
    assert.match(out.reasonCode, /timeout/);
  }
});

test("needs_escalation field escalates", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("code_explain");
    if (isPick(r)) return { json: { action: "respond_directly" } };
    return { json: { answer: "unsure", needs_escalation: true, assumptions: [] } };
  });
  const out = await new Controller({ afm }).handle({ prompt: "explain `f1_macro`", root });
  assert.equal(out.reasonCode, "afm_needs_escalation");
});

test("AFM down → frontier route without any AFM call", async () => {
  const afm = new FakeAFM(() => ({ failure: "empty" }));
  afm.healthy = false;
  const out = await new Controller({ afm }).handle({ prompt: "explain `f1_macro`", root });
  assert.equal(out.reasonCode, "afm_unavailable");
  assert.equal(afm.calls.length, 0);
});

test("destructive command in request → ask user", async () => {
  const afm = new FakeAFM((r) => isTriage(r) ? triage("other") : { failure: "empty" });
  const out = await new Controller({ afm }).handle({ prompt: "please run `rm -rf src` then explain", root });
  assert.equal(out.status, "ask_user");
  assert.equal(out.reasonCode, "destructive_command");
});

test("secrets in the request never reach AFM", async () => {
  const key = "sk-ant-api03-" + "k".repeat(40);
  const afm = new FakeAFM((r) => isTriage(r) ? triage("design", true) : { failure: "empty" });
  await new Controller({ afm }).handle({ prompt: `why does auth fail with key ${key}`, root });
  assert.ok(afm.calls.every((c) => !c.user.includes(key) && !c.system.includes(key)));
});

test("no project folder → chat only: no retrieval, no tool selection, still answers", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("other");
    if (isAnswer(r)) return { json: { answer: "hello", needs_escalation: false, assumptions: [] } };
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "hi, what model are you? see `f1_macro` in src/metrics.py", root: undefined });
  assert.equal(out.status, "answered_local");
  assert.equal(afm.calls.filter(isPick).length, 0);
  assert.match(afm.calls.find(isAnswer)!.user, /No project folder is open/);
  assert.doesNotMatch(afm.calls.find(isAnswer)!.user, /search "f1_macro"/);
});

test("small edits without a single target file fall back to a text proposal", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("small_edit");
    if (isPick(r)) return { json: { action: "respond_directly" } };
    return { json: { answer: "diff", needs_escalation: false, assumptions: ["y and p are lists"] } };
  });
  const out = await new Controller({ afm }).handle({ prompt: "fix the f1 macro helper so that it handles empty input lists gracefully in the metrics module of this project", root });
  assert.equal(out.isProposal, true);
  assert.equal(out.pendingEdit, undefined);
  assert.match(out.answer!, /Assumptions:\n- y and p are lists/);
});

test("Korean fallback translation is dropped when it would transliterate names", async () => {
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return triage("other");
    if (isPick(r)) return { json: { action: "respond_directly" } };
    if (isAnswer(r)) return { json: { answer: "Finale Doshi-Velez signed the letter (README.md).", needs_escalation: false, assumptions: [] } };
    if (r.schema?.properties?.korean) return { json: { korean: "파이널 도시-베젤이 편지에 서명했어요 (README.md)." } };
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "README.md 편지 보낸 사람이 누구야?", root });
  assert.match(out.answer!, /Finale Doshi-Velez/);
  assert.ok(out.steps.some((s) => /kept original: names lost/.test(s.detail)));
});
