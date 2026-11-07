import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../services/telemetry/db.ts";
import { SqliteTelemetry, projectHash } from "../services/telemetry/telemetry.ts";
import { MemoryStore, queryTerms, fileStamp } from "../services/memory/memory.ts";
import { makeRepo } from "./helpers.ts";

test("telemetry records a task timeline that can be reconstructed", () => {
  const db = openDb(":memory:");
  const t = new SqliteTelemetry(db);
  t.startTask({ taskId: "t1", root: "/x", frontEnd: "test", complexityTokens: 12 });
  t.decision({ taskId: "t1", provider: "rules", candidates: ["LOCAL_AFM", "ASK_USER"], action: "LOCAL_AFM", reasonCode: "local_other", afmAvailable: true });
  t.modelCall({ taskId: "t1", provider: "apfel", model: "afm", purpose: "triage", ok: true, promptTokens: 100, completionTokens: 9, latencyMs: 900, costType: "local" });
  t.toolCall({ taskId: "t1", tool: "list_dir", ok: true, durationMs: 3, resultChars: 40 });
  t.verification({ taskId: "t1", kind: "cited_paths_exist", passed: true });
  t.endTask({ taskId: "t1", taskType: "other", policyVersion: "v", policyHash: "h", status: "answered_local", outcomeClass: "local_verified", reasonCode: "local_other", latencyMs: 1200 });
  const row = db.prepare("SELECT * FROM tasks WHERE task_id='t1'").get() as any;
  assert.equal(row.outcome_class, "local_verified");
  assert.equal(row.project_hash, projectHash("/x"));
  assert.equal((db.prepare("SELECT action FROM routing_decisions WHERE task_id='t1'").get() as any).action, "LOCAL_AFM");
  assert.equal((db.prepare("SELECT count(*) n FROM model_calls WHERE task_id='t1'").get() as any).n, 1);
  // telemetry must never throw, even on a broken DB
  db.close();
  assert.doesNotThrow(() => t.toolCall({ taskId: "t1", tool: "x", ok: false, durationMs: 1 }));
});

test("memory: recall by relevance, Korean short terms, dedupe, links, forget", () => {
  const m = new MemoryStore(openDb(":memory:"));
  const p = "proj";
  m.remember(p, { kind: "file_summary", text: "석사 학위논문: 언어 모델의 시간 지식 평가", paths: ["thesis.pdf"], keywords: ["thesis"] });
  m.remember(p, { kind: "episode", text: "Q: ProjectQA manuscript about biomedical QA", paths: ["ProjectQA.doc"] });
  m.remember(p, { kind: "lesson", text: "Local AFM could not finish a design task", keywords: ["design"] });
  assert.equal(m.recall(p, "학위논문 내용 알려줘")[0].paths![0], "thesis.pdf");
  assert.equal(m.recall(p, "논문")[0].paths![0], "thesis.pdf");          // 2-char Korean term via LIKE fallback
  assert.equal(m.recall(p, "biomedical manuscript")[0].kind, "episode");
  assert.equal(m.recall("other-project", "논문").length, 0);              // per-project isolation
  m.remember(p, { kind: "file_summary", text: "updated summary", paths: ["thesis.pdf"] });
  assert.equal(m.list(p).filter((n: any) => n.paths === "thesis.pdf").length, 1);   // update, not append
  const key = "sk-proj-" + "q".repeat(40);
  m.remember(p, { kind: "episode", text: `leaked ${key}` });
  assert.ok(!JSON.stringify(m.list(p)).includes(key));                    // redacted at write time
  assert.equal(m.forget(p) >= 3, true);
  assert.equal(m.recall(p, "논문").length, 0);
});

test("memory: file summaries go stale when the file changes", () => {
  const root = makeRepo({ "a.md": "hello\n" });
  const m = new MemoryStore(openDb(":memory:"));
  m.remember("p", { kind: "file_summary", text: "summary of a", paths: ["a.md"], fileStamp: fileStamp(root, "a.md") });
  assert.equal(m.recall("p", "summary", { root }).length, 1);
  writeFileSync(join(root, "a.md"), "changed content\n");
  utimesSync(join(root, "a.md"), new Date(), new Date(Date.now() + 5000));
  assert.equal(m.recall("p", "summary", { root }).length, 0);
});

test("query terms drop stopwords and keep identifiers", () => {
  assert.deepEqual(queryTerms("Explain the f1_macro function please"), ["explain", "f1_macro", "function"]);
});
