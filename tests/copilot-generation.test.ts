import test from "node:test";
import assert from "node:assert/strict";
import { copilotCandidate, solveCopilot, type CodeTask } from "../services/controller/codegen.ts";
import { solveAdaptive } from "../services/controller/code-skill.ts";
import type { Filler } from "../services/frontier/copilot-ls.ts";
import type { AFMProvider } from "../services/afm-adapter/provider.ts";

const feedback = "input:\n1\n2\nexpected:\n3\ngot:\n-1\n" + "traceback line\n".repeat(20);
const task = (examples = true): CodeTask => ({
  prompt: 'def add(a, b):\n    """Return the sum of a and b."""\n', kind: "function", entry: "add",
  hasExamples: examples, exec: async () => ({ ok: true, out: "" }),
  examples: examples ? async (code) => ({ ok: code.includes("return a + b"), out: feedback }) : undefined,
});

function editor(samples: string[]) {
  let sample = 0, chunk = 0, accepted = 0;
  const seen: string[] = [];
  const ls: Filler = {
    complete: async (_p, _l, text) => { seen.push(text); return chunk++ === 0 && samples[sample] ? { text: samples[sample], item: { sample } } : undefined; },
    close: () => { sample++; chunk = 0; }, accept: () => { accepted++; },
  };
  return { ls, seen, accepted: () => accepted };
}

test("Copilot generation: first passing completion is unchanged and accepted only by the caller", async () => {
  const e = editor(["    return a + b"]);
  const r = await solveCopilot(e.ls, task());
  assert.equal(r.examplesOk, true);
  assert.equal(r.repairs, 0);
  assert.equal(r.candidates, 1);
  assert.equal(r.requests, 2);
  assert.equal(r.afmCalls, 0);
  assert.equal(e.seen[0], task().prompt + "\n");
  assert.equal(e.accepted(), 0);
  r.candidate!.accept();
  assert.equal(e.accepted(), 1);
});

test("Copilot generation: retry keeps the failing input and expected output, even before a long traceback", async () => {
  const e = editor(["    return a - b", "    return a + b"]);
  const r = await solveCopilot(e.ls, task());
  assert.equal(r.examplesOk, true);
  assert.equal(r.repairs, 1);
  assert.equal(r.candidates, 2);
  assert.match(e.seen[2], /# input:\n# 1\n# 2\n# expected:\n# 3/);
  assert.doesNotMatch(r.candidate!.code, /previous version failed|traceback line/);
  r.candidate!.accept();
  assert.equal(e.accepted(), 1);
});

test("Copilot generation: third sample gets a local approach, not local code", async () => {
  const e = editor(["    return a - b", "    return a * b", "    return a + b"]);
  let calls = 0;
  const afm = { generate: async (req: any) => {
    calls++;
    assert.match(req.user, /Return the sum/);
    assert.match(req.user, /input:\n1\n2\nexpected:\n3/);
    assert.match(req.system, /Do not write code/);
    return { ok: true, json: { approach: "Add the operands.", invariant: "The result is their sum.", complexity: "O(1)." } };
  } } as unknown as AFMProvider;
  const r = await solveCopilot(e.ls, task(), afm);
  assert.equal(r.examplesOk, true);
  assert.equal(r.repairs, 2);
  assert.equal(r.candidates, 3);
  assert.equal(r.afmCalls, 1);
  assert.equal(calls, 1);
  assert.match(e.seen[4], /# Add the operands\./);
  assert.doesNotMatch(r.candidate!.code, /Approach to check|Add the operands/);
});

test("Copilot generation: unavailable AFM does not prevent the final inline sample", async () => {
  const e = editor(["    return a - b", "    return a * b", "    return a + b"]);
  const afm = { generate: async () => ({ ok: false, failure: "unavailable" }) } as unknown as AFMProvider;
  const r = await solveCopilot(e.ls, task(), afm);
  assert.equal(r.examplesOk, true);
  assert.equal(r.afmCalls, 1);
});

test("Copilot generation: no examples is not permission to sample or accept", async () => {
  const e = editor(["    return a - b"]);
  const r = await solveCopilot(e.ls, task(false));
  assert.equal(r.examplesOk, undefined);
  assert.equal(r.candidates, 1);
  assert.equal(r.repairs, 0);
  assert.equal(e.accepted(), 0);
});

test("Copilot generation: an empty suggestion can be retried", async () => {
  const e = editor(["", "    return a + b"]);
  const r = await solveCopilot(e.ls, task());
  assert.equal(r.examplesOk, true);
  assert.equal(r.requests, 3);
  assert.match(e.seen[1], /No implementation was completed/);
});

test("Copilot generation: actual inline requests, including continuation chunks, are capped at ten", async () => {
  let requests = 0, closed = 0;
  const ls: Filler = {
    complete: async () => ({ text: `    x${requests++} = 0\n`, item: {} }),
    close: () => { closed++; }, accept: () => assert.fail("failing samples must not be accepted"),
  };
  const r = await solveCopilot(ls, { ...task(), kind: "program" });
  assert.equal(requests, 10);
  assert.equal(r.requests, 10);
  assert.equal(r.examplesOk, false);
  assert.equal(closed, 2);
});

test("Copilot generation: exhausted attempts retain a failing candidate and never accept it", async () => {
  const e = editor(["    return a - b", "    return a * b", "    return a / b"]);
  const r = await solveCopilot(e.ls, task());
  assert.equal(r.examplesOk, false);
  assert.equal(r.candidates, 3);
  assert.equal(e.accepted(), 0);
});

test("Copilot editor context preserves the class signature and keeps approach and feedback as comments", async () => {
  const e = editor(["        return a + b"]);
  const t = { ...task(), prompt: "Return the sum.\n\nStarter code:\nclass Solution:\n    def add(self, a, b):" };
  const r = await copilotCandidate(e.ls, t, "input: 1, 2\nexpected: 3", undefined, { approach: "Use addition.\nCheck signs." });
  assert.match(e.seen[0], /# Return the sum\./);
  assert.match(e.seen[0], /# Use addition\.\n# Check signs\./);
  assert.match(r!.code, /class Solution:\n    def add\(self, a, b\):\n        return a \+ b/);
  assert.doesNotMatch(r!.code, /Use addition|expected: 3/);
});

test("adaptive generation uses the same example-selected retry loop", async () => {
  const e = editor(["    return a - b", "    return a + b"]);
  const afm = { generate: async () => ({ ok: true, json: { imports: [], body: ["    return a - b"] } }) } as unknown as AFMProvider;
  // the loop alone (no gate): the retry that passes the examples is kept
  const { codeOptions } = await import("../services/controller/code-skill.ts");
  const r = await solveAdaptive(afm, task(), { extra: false, fast: true, copilot: e.ls, opts: codeOptions({ stress: false }) });
  assert.equal(r.stage, "copilot");
  assert.equal(r.examplesOk, true);
  assert.equal(r.repairs, 1);
  assert.equal(r.candidates, 3);
  assert.equal(e.accepted(), 1);
});

test("a retry that saw the failing example needs a stress-test pass, not just the examples", async () => {
  const e = editor(["    return a - b", "    return a + b"]);
  const afm = { generate: async () => ({ ok: true, json: { imports: [], body: ["    return a - b"] } }) } as unknown as AFMProvider;
  const r = await solveAdaptive(afm, task(), { extra: false, fast: true, copilot: e.ls });
  assert.equal(r.stage, "first");          // the fake editor writes no brute force or generator: inconclusive
  assert.equal(r.examplesOk, false);       // so the caller escalates
  assert.equal(e.accepted(), 0);
});
