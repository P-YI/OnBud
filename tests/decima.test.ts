import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
const { DecimaClient, DecimaDecisionProvider } = await import("../services/laya-router/decima.ts");
const { RulesDecisionProvider } = await import("../services/laya-router/decision.ts");

/** Fake Ollaya: answers /api/decide with a fixed route and records requests. */
function fakeOllaya(route: string, confidence = 0.8) {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "decima:agent", digest: "e14e614ce4ab1ae2ffff" }] })); return; }
      const body = JSON.parse(b); seen.push(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "decima:agent", answers: { route: { type: "choice", choice: route, confidence, probabilities: { [route]: 0.9 } }, secret: { type: "noul", noul: 0.02 }, destructive: { type: "noul", noul: 0.01 } } }));
    });
  });
  return new Promise<{ url: string; seen: any[]; close: () => void }>((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(srv.address() as any).port}`, seen, close: () => srv.close() })));
}
const rules = new RulesDecisionProvider({ policyVersion: "t", maxLocalInputTokens: 5500, maxLocalFiles: 1, defaultFrontier: "FRONTIER_GPT", localTypes: ["other", "code_explain"], alwaysFrontier: ["design"] });
const C = ["LOCAL_AFM", "FRONTIER_GPT", "ASK_USER"] as any;
const meta = (o: any = {}) => ({ taskType: "other", estimatedInputTokens: 50, filesTouched: 0, localAfmAvailable: true, prompt: "refactor the whole project into packages", ...o });

test("shadow: rules decide immediately, Decima's pick is reported with the redacted request", async () => {
  const f = await fakeOllaya("FRONTIER_GPT");
  const shadows: any[] = [];
  const p = new DecimaDecisionProvider(rules, new DecimaClient({ url: f.url, mode: "shadow" }), (_m, base, d) => shadows.push({ base: base.action, d }));
  const d = await p.decide(meta({ prompt: "key sk-proj-" + "a".repeat(40) + " refactor" }), C);
  assert.equal(d.action, "LOCAL_AFM");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(shadows[0].d.route, "FRONTIER_GPT");
  assert.ok(!f.seen[0].state.includes("a".repeat(40)));
  assert.deepEqual(Object.keys(f.seen[0].questions.route.criteria), C);
  f.close();
});

test("advise: may change a generic local route above the bar; never overrides hard rules", async () => {
  const f = await fakeOllaya("FRONTIER_GPT", 0.8);
  const p = new DecimaDecisionProvider(rules, new DecimaClient({ url: f.url, mode: "advise", minConfidence: 0.6 }));
  assert.equal((await p.decide(meta(), C)).reasonCode, "decima_frontier_gpt");
  assert.equal((await p.decide(meta({ taskType: "code_explain" }), C)).action, "LOCAL_AFM");          // specific type: rules keep it
  assert.equal((await p.decide(meta({ command: "rm -rf /" }), C)).reasonCode, "destructive_command"); // hard rule
  f.close();
  const low = await fakeOllaya("FRONTIER_GPT", 0.3);
  assert.equal((await new DecimaDecisionProvider(rules, new DecimaClient({ url: low.url, mode: "advise" })).decide(meta(), C)).action, "LOCAL_AFM");
  low.close();
});

test("Decima down → rules, quickly", async () => {
  const p = new DecimaDecisionProvider(rules, new DecimaClient({ url: "http://127.0.0.1:9", mode: "advise", timeoutMs: 500 }));
  const t0 = Date.now();
  assert.equal((await p.decide(meta(), C)).action, "LOCAL_AFM");
  assert.ok(Date.now() - t0 < 1500);
});

test("advise needs the pinned model version: another digest is scored in shadow and never changes the route", async () => {
  const o = await fakeOllaya("FRONTIER_GPT", 0.9);
  try {
    const same = new DecimaDecisionProvider(rules, new DecimaClient({ url: o.url, mode: "advise", digest: "e14e614ce4ab" }));
    assert.equal((await same.decide(meta(), C)).action, "FRONTIER_GPT");
    const other = new DecimaClient({ url: o.url, mode: "advise", digest: "0123456789ab" });
    const p = new DecimaDecisionProvider(rules, other);
    const d = await p.decide(meta(), C);
    assert.equal(d.action, "LOCAL_AFM");
    assert.match(d.provider, /unpinned/);
    assert.equal(other.served, "e14e614ce4ab1ae2ffff");
  } finally { o.close(); }
});
