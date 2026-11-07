// Calibrate decima_code_hard_threshold: at which Decima code score does the local model stop being worth trying?
// Sources (labelled = Decima score + whether the local attempt succeeded):
//   real  runtime/logs/controller.jsonl "job_outcome" events (local jobs the controller kept local; v3 routing)
//   dev   runtime/bench/code/results-*-s3-<tag>-*.jsonl on the dev splits (S3: every problem tried locally)
// A threshold t sends d >= t to Codex first. It is worth it when the local success rate at d >= t is low.
// Rule: the smallest t whose local success at d >= t is <= --max-local (default 0.15) with >= 5 cases there.
// Real records replace dev ones only when there are at least --min-real (default 30) of them.
// --bench humaneval limits dev data to one benchmark: under v3 the threshold only decides for non-algorithmic tasks
// with examples (algorithmic ones go to Codex first anyway), so HumanEval is the relevant dev split.
// usage: node --experimental-strip-types tools/calibrate-code-threshold.ts [--dev-tag v3dev] [--bench humaneval] [--max-local 0.15] [--min-real 30]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLog } from "../services/maintenance/housekeeping.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const R = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime");
const MAX_LOCAL = Number(opt("--max-local", "0.15")), MIN_REAL = Number(opt("--min-real", "30")), TAG = opt("--dev-tag", "v3dev"), BENCH = opt("--bench", "");
const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);

type Case = { d: number; ok: boolean };
const real: Case[] = [];
const log = join(R, "logs", "controller.jsonl");
// Real requests only, rotated copies included (housekeeping.ts): no benchmark runs (bench flag; earlier benchmark records predate controller-v0.4).
for (const e of readLog(log).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean)) if (e.event === "job_outcome" && typeof e.d === "number" && !e.bench && e.controller >= "controller-v0.4") real.push({ d: e.d, ok: e.status === "done" || e.status === "applied" });
const dev: Case[] = [];
const C = join(R, "bench", "code");
if (existsSync(C)) for (const f of readdirSync(C).filter((f) => new RegExp(`^results-${BENCH || ".*"}-s3-${TAG}-.*\\.jsonl$`).test(f)))
  for (const r of lines(join(C, f))) if (typeof r.decima_frontier === "number") dev.push({ d: r.decima_frontier, ok: !!r.pass });

const use = real.length >= MIN_REAL ? real : dev;
console.log(`labelled cases: real ${real.length} (job_outcome), dev ${dev.length} (s3 ${TAG}); using ${real.length >= MIN_REAL ? "real" : `dev (real < ${MIN_REAL})`}`);
console.log("| t | cases d >= t | local success d >= t | cases d < t | local success d < t |\n|---|---|---|---|---|");
let pick: number | undefined;
for (let t = 0.05; t <= 0.501; t += 0.05) {
  const hi = use.filter((c) => c.d >= t), lo = use.filter((c) => c.d < t);
  const rate = (xs: Case[]) => (xs.length ? xs.filter((c) => c.ok).length / xs.length : NaN);
  console.log(`| ${t.toFixed(2)} | ${hi.length} | ${hi.length ? `${hi.filter((c) => c.ok).length}/${hi.length} (${(100 * rate(hi)).toFixed(0)}%)` : "–"} | ${lo.length} | ${lo.length ? `${(100 * rate(lo)).toFixed(0)}%` : "–"} |`);
  if (pick === undefined && hi.length >= 5 && rate(hi) <= MAX_LOCAL) pick = Number(t.toFixed(2));
}
console.log(pick === undefined ? "no threshold meets the rule; keep the current value" : `suggested decima_code_hard_threshold: ${pick} (local success at d >= t <= ${MAX_LOCAL})`);
