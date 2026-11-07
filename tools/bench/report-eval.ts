// Merge all benchmark results into one report: own suite and code benchmarks
// kit's open-model results. usage: node --experimental-strip-types tools/bench/report-eval.ts [--out docs/benchmark-results.md]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const B = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "bench");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : new URL(`../../docs/benchmark-results-${new Date().toISOString().slice(0, 10)}.md`, import.meta.url).pathname;
const jsonl = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// prefix + timestamp only (tagged variants such as "s1-unv-…" are read separately)
const latest = (dir: string, prefix: string) => existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length)) && f.endsWith(".jsonl")).sort().pop() : undefined;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "–");
const SETTINGS = ["raw", "s2", "s3", "s1", "codex"] as const;
const NAMES: Record<string, string> = { raw: "AFM raw", s2: "S2 AFM+tools", s3: "S3 +Decima", s1: "S1 full", codex: "Codex only" };
// ---------------------------------------------------------------- cost model (API-equivalent)
// Codex runs on the ChatGPT Pro subscription (no per-token bill); for comparison each Codex call is priced at
// GPT-6.1 Sol standard API rates using tokens measured per benchmark type (runtime/bench/codex-tokens.json).
const PRICE = { input: 2.0, cached: 0.1, output: 10.0 };   // USD per 1M tokens (OpenAI GPT-6.1 Sol standard)
const tokFile = join(B, "codex-tokens.json");
const perCall: Record<string, number> = {};
if (existsSync(tokFile)) {
  const t = JSON.parse(readFileSync(tokFile, "utf8")).samples as Record<string, any[]>;
  for (const [k, xs] of Object.entries(t)) perCall[k] = xs.reduce((n, x) => n + (x.input * PRICE.input + x.cacheRead * PRICE.cached + (x.output + x.reasoning) * PRICE.output) / 1e6, 0) / xs.length;
}
const costOf = (kind: string, calls: number) => calls * (perCall[kind] ?? perCall.own ?? 0);
// Measured tokens when the run recorded them (ctok, from v4 on), else the per-call estimate above.
const tokCost = (t: { input: number; output: number; reasoning: number; cacheRead: number }) => (t.input * PRICE.input + t.cacheRead * PRICE.cached + (t.output + t.reasoning) * PRICE.output) / 1e6;
const rowsCost = (kind: string, rows: any[]) => rows.filter((r) => r.codex).reduce((n, r) => n + (r.ctok ? tokCost(r.ctok) : costOf(kind, 1)), 0);
const usd = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const lines: string[] = [`# Benchmark results (${new Date().toISOString().slice(0, 10)})`, ""];

// ---------------------------------------------------------------- own suite
const fw: Record<string, any[]> = {};
// --fw-tag <tag>: section 1 from that tagged task-suite run (e.g. "suite" from run-suite.sh, "v5"); raw stays untagged.
const FW_TAG = args.includes("--fw-tag") ? args[args.indexOf("--fw-tag") + 1] : "";
for (const s of SETTINGS) { const f = (FW_TAG && s !== "raw" ? latest(join(B, "fw"), `results-${s}-${FW_TAG}-`) : undefined) ?? latest(join(B, "fw"), `results-${s}-`); if (f) fw[s] = jsonl(join(B, "fw", f)); }
if (Object.keys(fw).length) {
  const cats = [...new Set(Object.values(fw).flat().map((r) => r.cat))].sort();
  lines.push(`## 1. Own task suite (${Math.max(...Object.entries(fw).filter(([k]) => k !== "raw").map(([, rs]) => rs.length), 0)} tasks${FW_TAG ? `, run "${FW_TAG}"` : ""}; raw runs only the question tasks)`, "", `| Category | ${SETTINGS.map((s) => NAMES[s]).join(" | ")} |`, `|---|${SETTINGS.map(() => "---").join("|")}|`);
  for (const c of cats) lines.push(`| ${c} | ${SETTINGS.map((s) => { const rs = (fw[s] ?? []).filter((r) => r.cat === c); if (!rs.length) return "–"; const p = rs.filter((r) => r.pass).length, d = rs.filter((r) => r.deferred).length; return `${p}/${rs.length}${d ? ` (${d} deferred)` : ""}`; }).join(" | ")} |`);
  lines.push(`| **Total** | ${SETTINGS.map((s) => { const rs = fw[s] ?? []; return rs.length ? `**${rs.filter((r) => r.pass).length}/${rs.length}** (${pct(rs.filter((r) => r.pass).length, rs.length)})` : "–"; }).join(" | ")} |`);
  lines.push(`| Median latency | ${SETTINGS.map((s) => { const ms = (fw[s] ?? []).map((r) => r.ms).sort((a, b) => a - b); return ms.length ? `${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s` : "–"; }).join(" | ")} |`);
  lines.push(`| Codex calls / web searches | ${SETTINGS.map((s) => { const rs = fw[s] ?? []; return rs.length ? `${rs.reduce((n, r) => n + (r.codex ?? 0), 0)} / ${rs.reduce((n, r) => n + (r.web ?? 0), 0)}` : "–"; }).join(" | ")} |`);
  lines.push(`| Speed · cost (total time · API-eq. Codex cost) | ${SETTINGS.map((s) => { const rs = fw[s] ?? []; if (!rs.length) return "–"; const t = rs.reduce((n, r) => n + r.ms, 0) / 1000; return `${(t / 60).toFixed(1)} min · ${usd(costOf("own", rs.reduce((n, r) => n + (r.codex ?? 0), 0)))}`; }).join(" | ")} |`, "");
  const fails = Object.entries(fw).flatMap(([s, rs]) => rs.filter((r) => !r.pass && !r.deferred).map((r) => `${NAMES[s]} ${r.id}: ${(r.notes ?? []).join(" · ").slice(0, 80) || r.status}`));
  if (fails.length) lines.push("<details><summary>Failures</summary>", "", ...fails.map((f) => `- ${f}`), "", "</details>", "");
}

// ---------------------------------------------------------------- code benchmarks
const BENCHES = [["humaneval", "HumanEval (40)"], ["lcb", "LiveCodeBench v6 (30)"], ["bcb-hard", "BigCodeBench-Hard stdlib (25)"]] as const;
const code: Record<string, Record<string, any[]>> = {};
for (const [b] of BENCHES) for (const s of SETTINGS) { const f = latest(join(B, "code"), `results-${b}-${s}-`); if (f) (code[b] ??= {})[s] = jsonl(join(B, "code", f)); }
if (Object.keys(code).length) {
  lines.push("## 2. Code benchmarks (pass@1, same fixed subsets for every setting)", "", `| Benchmark | ${SETTINGS.map((s) => NAMES[s]).join(" | ")} |`, `|---|${SETTINGS.map(() => "---").join("|")}|`);
  for (const [b, name] of BENCHES) lines.push(`| ${name} | ${SETTINGS.map((s) => { const rs = code[b]?.[s]; return rs?.length ? `${rs.filter((r) => r.pass).length}/${rs.length} (${pct(rs.filter((r) => r.pass).length, rs.length)})` : "–"; }).join(" | ")} |`);
  const lcbDiff = (s: string) => ["easy", "medium", "hard"].map((d) => { const rs = (code.lcb?.[s] ?? []).filter((r) => r.id.includes(`(${d})`)); return `${rs.filter((r) => r.pass).length}/${rs.length}`; }).join(" · ");
  lines.push(`| LCB easy · medium · hard | ${SETTINGS.map((s) => (code.lcb?.[s] ? lcbDiff(s) : "–")).join(" | ")} |`);
  lines.push(`| Mean seconds / problem | ${SETTINGS.map((s) => { const rs = BENCHES.flatMap(([b]) => code[b]?.[s] ?? []); return rs.length ? (rs.reduce((n, r) => n + r.ms, 0) / rs.length / 1000).toFixed(1) : "–"; }).join(" | ")} |`);
  const unv = latest(join(B, "code"), "results-bcb-hard-s1-unv-");
  if (unv) { const rs = jsonl(join(B, "code", unv)); lines.push(`| BCB-Hard, S1 escalating unverifiable tasks | – | – | – | ${rs.filter((r) => r.pass).length}/${rs.length} (${pct(rs.filter((r) => r.pass).length, rs.length)}), Codex ${rs.filter((r) => r.codex).length}, ${(rs.reduce((n, r) => n + r.ms, 0) / 60000).toFixed(1)} min · ${usd(costOf("bcb", rs.filter((r) => r.codex).length))} | – |`); }
  lines.push(`| Codex calls | ${SETTINGS.map((s) => { const rs = BENCHES.flatMap(([b]) => code[b]?.[s] ?? []); return rs.length ? String(rs.filter((r) => r.codex).length) : "–"; }).join(" | ")} |`);
  const kindOfBench: Record<string, string> = { humaneval: "humaneval", lcb: "lcb", "bcb-hard": "bcb" };
  const codeCost = (s: string) => BENCHES.reduce((n, [b]) => n + costOf(kindOfBench[b], (code[b]?.[s] ?? []).filter((r) => r.codex).length), 0);
  lines.push(`| Speed · cost (total time · API-eq. Codex cost) | ${SETTINGS.map((s) => { const rs = BENCHES.flatMap(([b]) => code[b]?.[s] ?? []); return rs.length ? `${(rs.reduce((n, r) => n + r.ms, 0) / 60000).toFixed(1)} min · ${usd(codeCost(s))}` : "–"; }).join(" | ")} |`, "");
}

// ---------------------------------------------------------------- v2 / v3 (tuned on dev splits only)
const V2S = ["s2", "s3", "s1"] as const;
const kindsV: Record<string, string> = { humaneval: "humaneval", lcb: "lcb", "bcb-hard": "bcb" };
const cellV = (rs?: any[]) => (rs?.length ? `${rs.filter((r) => r.pass).length}/${rs.length} (${pct(rs.filter((r) => r.pass).length, rs.length)})` : "–");
const mean = (rs: any[], f: (r: any) => number) => (rs.length ? rs.reduce((n, r) => n + f(r), 0) / rs.length : NaN);
const VERS: [string, string][] = [["v2", "## 2b. v2: more local effort (k candidates, differential selection, repair)"], ["v3", "## 2c. v3: adaptive effort and fast hybrid routing"], ["v4", "## 2d. v4: v3 + faster escalation + lean Codex agent (measured tokens)"]];
for (const [tag, title] of VERS) {
  const vr: Record<string, Record<string, any[]>> = {};
  for (const [b] of BENCHES) for (const s of V2S) { const f = latest(join(B, "code"), `results-${b}-${s}-${tag}-`); if (f) (vr[b] ??= {})[s] = jsonl(join(B, "code", f)); }
  const fwv: Record<string, any[]> = {};
  for (const s of V2S) { const f = latest(join(B, "fw"), `results-${s}-${tag}-`); if (f) fwv[s] = jsonl(join(B, "fw", f)); }
  if (!Object.keys(vr).length && !Object.keys(fwv).length) continue;
  lines.push(title, "", "Settings fixed on disjoint dev splits (`tools/bench/subsets/dev-*.json`); each test subset run once with them.", "",
    ...(tag === "v4" ? ["S1 only: S2/S3 code paths are unchanged from v3. v4 cost is measured per call; the v1 and Codex-only costs are per-call estimates from the full `codex` agent, about twice what `codex-handoff` measures (see §5e).", ""] : []),
    `| Benchmark | ${V2S.map((s) => `${NAMES[s]} v1 → ${tag}`).join(" | ")} | Codex only |`, `|---|${V2S.map(() => "---").join("|")}|---|`);
  for (const [b, name] of BENCHES) lines.push(`| ${name} | ${V2S.map((s) => `${cellV(code[b]?.[s])} → **${cellV(vr[b]?.[s])}**`).join(" | ")} | ${cellV(code[b]?.codex)} |`);
  const lcbD = (rs?: any[]) => (rs ? ["easy", "medium", "hard"].map((d) => { const x = rs.filter((r) => r.id.includes(`(${d})`)); return `${x.filter((r) => r.pass).length}/${x.length}`; }).join(" · ") : "–");
  lines.push(`| LCB easy · medium · hard | ${V2S.map((s) => `${lcbD(code.lcb?.[s])} → ${lcbD(vr.lcb?.[s])}`).join(" | ")} | ${lcbD(code.lcb?.codex)} |`);
  if (Object.keys(fwv).length) lines.push(`| Own suite (27; not held out) | ${V2S.map((s) => { const f = (rs?: any[]) => (rs?.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : "–"); return `${f(fw[s])} → **${f(fwv[s])}**`; }).join(" | ")} | ${fw.codex?.length ? `${fw.codex.filter((r) => r.pass).length}/${fw.codex.length}` : "–"} |`);
  const allv = (s: string) => BENCHES.flatMap(([b]) => vr[b]?.[s] ?? []);
  const all1 = (s: string) => BENCHES.flatMap(([b]) => code[b]?.[s] ?? []);
  const f1 = (x: number) => (Number.isNaN(x) ? "–" : x.toFixed(1));
  lines.push(`| Mean s / problem (v1 → ${tag}) | ${V2S.map((s) => `${f1(mean(all1(s), (r) => r.ms / 1000))} → ${f1(mean(allv(s), (r) => r.ms / 1000))}`).join(" | ")} | ${f1(mean(all1("codex"), (r) => r.ms / 1000))} |`);
  const costV = (rows: (b: string) => any[]) => BENCHES.reduce((n, [b]) => n + rowsCost(kindsV[b], rows(b)), 0);
  lines.push(`| Codex calls · API-eq. cost (v1 → ${tag}) | ${V2S.map((s) => (s === "s1" ? `${all1(s).filter((r) => r.codex).length} · ${usd(costV((b) => code[b]?.s1 ?? []))} → ${allv(s).filter((r) => r.codex).length} · ${usd(costV((b) => vr[b]?.s1 ?? []))}` : "0 → 0")).join(" | ")} | ${all1("codex").filter((r) => r.codex).length} · ${usd(costV((b) => code[b]?.codex ?? []))} |`, "");
  const s1 = allv("s1");
  if (s1.length) {
    const groups = new Map<string, any[]>();
    for (const r of s1) { const k = r.route === "codex-first" && r.why ? `Codex first (${r.why})` : r.route === "codex-first" ? "Codex first (Decima hard)" : r.route === "escalated" ? "escalated after one local attempt" : "kept local (passes the statement's examples)"; groups.set(k, [...(groups.get(k) ?? []), r]); }
    lines.push(`| S1 ${tag} route | Problems | Passed | Mean s |`, "|---|---|---|---|", ...[...groups].map(([k, rs]) => `| ${k} | ${rs.length} | ${cellV(rs)} | ${mean(rs, (r) => r.ms / 1000).toFixed(1)} |`), "");
  }
}

// ---------------------------------------------------------------- comparison with open models
lines.push("## 3. Comparison of settings (same subsets, greedy pass@1), with speed and cost", "",
  "| Model / setting | Params | HumanEval-40 | LCB-v6-30 | BCB-Hard-stdlib-25 | Own suite | Speed (s / problem) · cost (per 100 problems) | Source |", "|---|---|---|---|---|---|---|---|");
const pr = (s: string, b: string) => { const rs = code[b]?.[s]; return rs?.length ? pct(rs.filter((r) => r.pass).length, rs.length) : "–"; };
const own = (s: string) => { const rs = fw[s] ?? []; return rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : "–"; };
const sc = (s: string) => {
  const rs = BENCHES.flatMap(([b]) => code[b]?.[s] ?? []);
  if (!rs.length) return "–";
  const kinds: Record<string, string> = { humaneval: "humaneval", lcb: "lcb", "bcb-hard": "bcb" };
  const cost = BENCHES.reduce((n, [b]) => n + rowsCost(kinds[b], code[b]?.[s] ?? []), 0);
  return `${(rs.reduce((n, r) => n + r.ms, 0) / rs.length / 1000).toFixed(1)} s · ${usd((100 * cost) / rs.length)}${s === "codex" || s.startsWith("s1") ? "" : " (on-device)"}`;
};
const ROWS: [string, string, string, string][] = [["raw", "Apple on-device AFM (raw)", "~3B", "this Mac"], ["s2", "AFM + tools (S2)", "~3B + tools", "this Mac (framework)"], ["s3", "AFM + tools + Decima (S3)", "+ 321M router", "this Mac (framework)"], ["s1", "Full framework (S1)", "+ GPT-6.1 Sol fallback", "this Mac (framework)"], ["codex", "Codex only", "GPT-6.1 Sol", "this Mac"]];
for (const [k, name, params, src] of ROWS) lines.push(`| ${name} | ${params} | ${pr(k, "humaneval")} | ${pr(k, "lcb")} | ${pr(k, "bcb-hard")} | ${own(k)} | ${sc(k)} | ${src} |`);
// v3/v4 rows, read from the tagged test runs. Own suite: that version's controller run if there is one, else v2's
// (v3 changed only code-task routing in the benchmark path).
for (const v of ["v3", "v4"]) for (const [k, name, params] of ROWS.slice(1, 4)) {
  const key = `${k}-${v}`;
  for (const [b] of BENCHES) { const f = latest(join(B, "code"), `results-${b}-${k}-${v}-`); if (f) (code[b] ??= {})[key] = jsonl(join(B, "code", f)); }
  const f = latest(join(B, "fw"), `results-${k}-${v}-`) ?? latest(join(B, "fw"), `results-${k}-v2-`); if (f) fw[key] = jsonl(join(B, "fw", f));
  if (BENCHES.some(([b]) => code[b]?.[key])) lines.push(`| **${name}, ${v}** | ${params} | ${pr(key, "humaneval")} | ${pr(key, "lcb")} | ${pr(key, "bcb-hard")} | ${own(key)} | ${sc(key)} | this Mac (framework ${v}) |`);
}
lines.push("", `_Cost: Codex runs on the ChatGPT Pro subscription (no per-token bill). The column prices each Codex call at GPT-6.1 Sol standard API rates ($${PRICE.input}/1M input, $${PRICE.cached}/1M cached input, $${PRICE.output}/1M output and reasoning) with tokens measured per benchmark type (${Object.entries(perCall).map(([k, v]) => `${k} ${usd(v)}/call`).join(", ")}). On-device AFM and Decima have no per-token cost (only the Mac's power)._`);
lines.push("", "Published full-benchmark figures, for orientation only (different protocol and windows): Qwen2.5-Coder-1.5B-Instruct HumanEval 70.7, LCB 14.6; Qwen2.5-Coder-7B-Instruct HumanEval 88.4, LCB 32.3 (OpenCodeInstruct, arXiv 2504.04030, Table 3). Apple publishes no coding benchmark for the on-device model.", "");
lines.push("_Caveats: small fixed subsets (direction, not significance); S2/S3/S1 self-check against examples in the problem text, never hidden tests; Codex runs are single attempts through OpenCode._");
// Written analysis (kept in its own file so regenerating the tables does not lose it).
const NOTES = new URL("../../docs/benchmark-notes.md", import.meta.url).pathname;
if (existsSync(NOTES)) lines.push("", readFileSync(NOTES, "utf8").trim());
writeFileSync(OUT, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.error(`\nwritten ${OUT}`);
