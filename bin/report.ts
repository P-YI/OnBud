// Descriptive telemetry report (Phase 3). No prompts, code or outputs: counts, rates and latencies only.
// usage: node --experimental-strip-types --experimental-sqlite bin/report.ts [--days 7] [--out FILE]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../services/telemetry/db.ts";
import { readLog } from "../services/maintenance/housekeeping.ts";

const args = process.argv.slice(2);
const days = Number(args[args.indexOf("--days") + 1] || 7) || 7;
const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(HOME, "runtime", "reports", `telemetry-${days}d-${new Date().toISOString().slice(0, 10)}.md`);

const db = openDb();
const q = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const table = (rows: any[], cols: string[]) =>
  rows.length ? [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => r[c] ?? "").join(" | ")} |`)].join("\n") : "_no data_";

const total = one("SELECT count(*) n FROM tasks WHERE started_at >= ?", since).n;
const lines: string[] = [
  `# OnBud telemetry — last ${days} days`,
  ``,
  `Generated ${new Date().toISOString()} · tasks: **${total}** · counts are per task, not per model call.`,
  ``,
  `## Outcomes`,
  table(q(`SELECT coalesce(outcome_class,'(running)') AS outcome, count(*) AS tasks, round(avg(latency_ms)/1000.0,1) AS avg_s
           FROM tasks WHERE started_at >= ? GROUP BY outcome ORDER BY tasks DESC`, since), ["outcome", "tasks", "avg_s"]),
  ``,
  `## Task types and routes`,
  table(q(`SELECT coalesce(task_type,'?') AS task_type, count(*) AS tasks,
             sum(outcome_class IN ('local_verified','local_unverified')) AS local,
             sum(outcome_class = 'escalation_pending') AS escalated,
             round(avg(latency_ms)/1000.0,1) AS avg_s
           FROM tasks WHERE started_at >= ? GROUP BY task_type ORDER BY tasks DESC`, since), ["task_type", "tasks", "local", "escalated", "avg_s"]),
  ``,
  `## Escalation and ask-user reasons`,
  table(q(`SELECT reason_code, count(*) AS n FROM tasks WHERE started_at >= ? AND outcome_class IN ('escalation_pending','escalated_recovered','asked_user','failed')
           GROUP BY reason_code ORDER BY n DESC`, since), ["reason_code", "n"]),
  ``,
  `## Model calls`,
  table(q(`SELECT provider, purpose, count(*) AS calls, sum(ok) AS ok, round(avg(latency_ms)) AS avg_ms,
             sum(coalesce(prompt_tokens,0)) AS prompt_tok, sum(coalesce(completion_tokens,0)) AS completion_tok, cost_type
           FROM model_calls WHERE ts >= ? GROUP BY provider, purpose, cost_type ORDER BY calls DESC`, since),
    ["provider", "purpose", "calls", "ok", "avg_ms", "prompt_tok", "completion_tok", "cost_type"]),
  ``,
  `## AFM failures`,
  table(q(`SELECT purpose, failure, count(*) AS n FROM model_calls WHERE ts >= ? AND ok = 0 GROUP BY purpose, failure ORDER BY n DESC`, since), ["purpose", "failure", "n"]),
  ``,
  `## Tools`,
  table(q(`SELECT tool, count(*) AS calls, sum(ok) AS ok, round(avg(duration_ms)) AS avg_ms FROM tool_calls WHERE ts >= ? GROUP BY tool ORDER BY calls DESC`, since), ["tool", "calls", "ok", "avg_ms"]),
  ``,
  `## Verification`,
  table(q(`SELECT kind, count(*) AS checks, sum(passed) AS passed FROM verification WHERE ts >= ? GROUP BY kind`, since).map((r) => ({ ...r, rate: pct(r.passed, r.checks) })), ["kind", "checks", "passed", "rate"]),
  ``,
  `## Policy versions in use`,
  table(q(`SELECT policy_version, policy_hash, count(*) AS tasks FROM tasks WHERE started_at >= ? AND policy_version IS NOT NULL GROUP BY 1,2`, since), ["policy_version", "policy_hash", "tasks"]),
  ``,
  `## Rules vs Decima (shadow/advise records; agreement is not accuracy)`,
  table(q(`SELECT provider, count(*) AS decisions, sum(reason_code LIKE '%_agrees') AS agrees, sum(reason_code LIKE '%_differs') AS differs, sum(reason_code LIKE 'decima_error%') AS errors
    FROM routing_decisions WHERE ts >= ? AND provider LIKE 'decima-%' GROUP BY provider`, since).map((r) => ({ ...r, agreement: pct(r.agrees, r.agrees + r.differs) })), ["provider", "decisions", "agrees", "differs", "errors", "agreement"]),
  ``,
  `## Memory`,
  table(q(`SELECT kind, count(*) AS notes, sum(use_count) AS uses FROM memory_notes GROUP BY kind`), ["kind", "notes", "uses"]),
];

const gateLog = join(HOME, "runtime", "logs", "security-gate.jsonl");
if (existsSync(gateLog)) {
  const counts = new Map<string, number>();
  for (const l of readLog(gateLog)) {   // with rotated copies (housekeeping.ts)
    try { const e = JSON.parse(l); if (e.ts >= since && e.verdict) counts.set(e.verdict, (counts.get(e.verdict) ?? 0) + 1); } catch { /* skip */ }
  }
  lines.push("", "## Security gate (OpenCode 1.x plugin)", table([...counts].map(([verdict, n]) => ({ verdict, n })), ["verdict", "n"]));
}
lines.push("", "_Caveats: selection bias (AFM gets the tasks routed to it), unverified ≠ wrong, subscription calls show no per-token cost._");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.error(`\nwritten: ${out}`);
