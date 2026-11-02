// Phase 3 telemetry recorder. Every method is best-effort: telemetry must never break a task.

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { now, openDb } from "./db.ts";

export const projectHash = (root: string | undefined) =>
  root ? createHash("sha256").update(root).digest("hex").slice(0, 12) : "no-project";

/** Task-level outcome classes from policies/EVALUATION.md. */
export type OutcomeClass = "local_verified" | "local_unverified" | "escalated_recovered" | "frontier_first" | "asked_user" | "failed" | "escalation_pending";

export interface TelemetrySink {
  startTask(t: { taskId: string; root?: string; frontEnd: string; complexityTokens: number }): void;
  decision(d: { taskId: string; provider: string; candidates: string[]; action: string; reasonCode: string; afmAvailable: boolean; riskSignals?: string[]; rawScores?: Record<string, number> }): void;
  modelCall(c: { taskId?: string; provider: string; model: string; purpose: string; ok: boolean; failure?: string; promptTokens?: number; completionTokens?: number; latencyMs: number; costType: "local" | "subscription" | "api" }): void;
  toolCall(c: { taskId?: string; tool: string; ok: boolean; durationMs: number; errorType?: string; resultChars?: number }): void;
  verification(v: { taskId: string; kind: string; passed: boolean; detail?: string }): void;
  endTask(t: { taskId: string; taskType: string; policyVersion: string; policyHash: string; skill?: string; status: string; outcomeClass: OutcomeClass; reasonCode: string; capsuleTokens?: number; latencyMs: number }): void;
}

export class SqliteTelemetry implements TelemetrySink {
  private db: DatabaseSync;
  constructor(db: DatabaseSync = openDb()) { this.db = db; }

  private run(sql: string, ...params: any[]) {
    try { this.db.prepare(sql).run(...params.map((p) => (p === undefined ? null : p))); } catch { /* best effort */ }
  }

  startTask(t: Parameters<TelemetrySink["startTask"]>[0]) {
    this.run("INSERT OR IGNORE INTO tasks(task_id, started_at, project_hash, front_end, complexity_tokens) VALUES (?,?,?,?,?)",
      t.taskId, now(), projectHash(t.root), t.frontEnd, t.complexityTokens);
  }
  decision(d: Parameters<TelemetrySink["decision"]>[0]) {
    this.run("INSERT INTO routing_decisions(task_id, ts, provider, candidates, action, reason_code, raw_scores, afm_available, risk_signals) VALUES (?,?,?,?,?,?,?,?,?)",
      d.taskId, now(), d.provider, JSON.stringify(d.candidates), d.action, d.reasonCode, d.rawScores ? JSON.stringify(d.rawScores) : null, d.afmAvailable ? 1 : 0, JSON.stringify(d.riskSignals ?? []));
  }
  modelCall(c: Parameters<TelemetrySink["modelCall"]>[0]) {
    this.run("INSERT INTO model_calls(task_id, ts, provider, model, purpose, ok, failure, prompt_tokens, completion_tokens, latency_ms, cost_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      c.taskId, now(), c.provider, c.model, c.purpose, c.ok ? 1 : 0, c.failure, c.promptTokens, c.completionTokens, c.latencyMs, c.costType);
  }
  toolCall(c: Parameters<TelemetrySink["toolCall"]>[0]) {
    this.run("INSERT INTO tool_calls(task_id, ts, tool, ok, duration_ms, error_type, result_chars) VALUES (?,?,?,?,?,?,?)",
      c.taskId, now(), c.tool, c.ok ? 1 : 0, c.durationMs, c.errorType, c.resultChars);
  }
  verification(v: Parameters<TelemetrySink["verification"]>[0]) {
    this.run("INSERT INTO verification(task_id, ts, kind, passed, detail) VALUES (?,?,?,?,?)", v.taskId, now(), v.kind, v.passed ? 1 : 0, v.detail);
  }
  endTask(t: Parameters<TelemetrySink["endTask"]>[0]) {
    this.run(`UPDATE tasks SET ended_at=?, task_type=?, policy_version=?, policy_hash=?, skill=?, status=?, outcome_class=?, reason_code=?, capsule_tokens=?, latency_ms=? WHERE task_id=?`,
      now(), t.taskType, t.policyVersion, t.policyHash, t.skill, t.status, t.outcomeClass, t.reasonCode, t.capsuleTokens, t.latencyMs, t.taskId);
  }
}

export class NullTelemetry implements TelemetrySink {
  startTask() {} decision() {} modelCall() {} toolCall() {} verification() {} endTask() {}
}
