// Quick BFCL (Berkeley Function Calling Leaderboard v4) check of AFM tool selection strategies.
// Not the official harness: a simplified AST checker (name + per-argument match against
// possible_answer, BFCL-style string normalisation), small samples. Data in ~/OpenAFM/runtime/bench/bfcl.
// usage: node --experimental-strip-types tools/bench/bfcl-eval.ts [--n 20] [--methods twostep,dispatch,plan,native] [--cats simple_python,...]

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApfelProvider } from "../../services/afm-adapter/apfel.ts";
import { planCalls, selectCalls, selectTool, selectToolDispatch, type ToolSpec } from "../../services/afm-adapter/tools.ts";
import type { JSONSchema } from "../../services/afm-adapter/schema.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const N = Number(opt("--n", "20"));
const METHODS = opt("--methods", "native,twostep,dispatch,plan").split(",");
const CATS = opt("--cats", "simple_python,multiple,parallel,parallel_multiple,irrelevance,live_simple").split(",");
const DIR = join(process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM"), "runtime", "bench", "bfcl");
const afm = new ApfelProvider({ defaultTimeoutMs: 45_000 });

const jsonl = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sample = <T,>(xs: T[], n: number) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]));

function toSchema(p: any): JSONSchema {
  const t = String(p?.type ?? "string");
  const desc = [p?.description, p?.default !== undefined ? `Default: ${JSON.stringify(p.default)}` : ""].filter(Boolean).join(" ");
  const base: JSONSchema = { description: desc || undefined };
  if (p?.enum) base.enum = p.enum;
  if (t === "dict" || t === "object") {
    const props = Object.fromEntries(Object.entries(p.properties ?? {}).map(([k, v]) => [k, toSchema(v)]));
    return { ...base, type: "object", properties: props, required: p.required ?? [] };
  }
  if (t === "array" || t === "tuple") return { ...base, type: "array", items: toSchema(p.items ?? { type: "string" }) };
  if (t === "float" || t === "number") return { ...base, type: "number" };
  if (t === "integer") return { ...base, type: "integer" };
  if (t === "boolean") return { ...base, type: "boolean" };
  return { ...base, type: "string" };
}

const safe = (n: string) => n.replace(/[^A-Za-z0-9_-]/g, "_");
function toolsOf(fns: any[]): { specs: ToolSpec[]; back: Map<string, string> } {
  const back = new Map<string, string>();
  const specs = fns.map((f) => {
    const s = toSchema({ ...f.parameters, type: "dict" }) as ToolSpec["args"];
    back.set(safe(f.name), f.name);
    return { name: safe(f.name), description: f.description ?? f.name, args: s };
  });
  return { specs, back };
}

// ---- simplified BFCL AST checker
const norm = (v: unknown): unknown => {
  if (typeof v === "string") return v.toLowerCase().replace(/[\s,./\-_*^'"]/g, "");
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
};
function valueOk(got: unknown, allowed: unknown[]): boolean {
  for (const a of allowed) {
    if (a === "" ) continue;
    // nested dict answers are {key: [allowed values]} (e.g. area: [{width: [20], height: [12]}])
    if (a && typeof a === "object" && !Array.isArray(a) && got && typeof got === "object" && !Array.isArray(got)) {
      const g = got as Record<string, unknown>, sub = a as Record<string, unknown[]>;
      if (Object.keys(g).every((k) => k in sub) && Object.entries(sub).every(([k, al]) => (k in g ? valueOk(g[k], al) : al.includes("")))) return true;
      continue;
    }
    if (typeof a === "number" && Number(got) === a) return true;
    if (JSON.stringify(norm(got)) === JSON.stringify(norm(a))) return true;
  }
  return false;
}
function callOk(call: { name: string; args: Record<string, unknown> }, gt: Record<string, Record<string, unknown[]>>): boolean {
  const [fname, params] = Object.entries(gt)[0];
  if (call.name !== fname) return false;
  for (const k of Object.keys(call.args)) if (!(k in params)) return false;          // unexpected argument
  for (const [k, allowed] of Object.entries(params)) {
    const optional = allowed.includes("");
    if (!(k in call.args)) { if (!optional) return false; continue; }
    if (!valueOk(call.args[k], allowed)) return false;
  }
  return true;
}
function score(calls: { name: string; args: Record<string, unknown> }[], gt: any[] | null): boolean {
  if (!gt) return calls.length === 0;                       // irrelevance: no call is correct
  if (calls.length !== gt.length) return false;
  const used = new Set<number>();
  return gt.every((g) => { const i = calls.findIndex((c, j) => !used.has(j) && callOk(c, g)); if (i < 0) return false; used.add(i); return true; });
}

// ---- methods
type Calls = { name: string; args: Record<string, unknown> }[];
async function run(method: string, q: string, fns: any[]): Promise<{ calls: Calls; ms: number; err?: string }> {
  const { specs, back } = toolsOf(fns);
  const sys = "You are a function-calling assistant. Call functions only when the request needs them; otherwise respond directly.";
  if (method === "native") {
    const t0 = Date.now();
    const token = readFileSync(join(homedir(), "OpenAFM", "config", "apfel.token"), "utf8").trim();
    const body = { model: "apple-foundationmodel", temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: q }],
      tools: specs.map((s) => ({ type: "function", function: { name: s.name, description: s.description, parameters: s.args } })), tool_choice: "auto" };
    try {
      const r = await fetch("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
      const d: any = await r.json();
      const tc = d?.choices?.[0]?.message?.tool_calls ?? [];
      return { calls: tc.map((c: any) => { let a = {}; try { a = JSON.parse(c.function.arguments); } catch { a = { __bad_json: true }; } return { name: back.get(c.function.name) ?? c.function.name, args: a }; }), ms: Date.now() - t0, err: r.ok ? undefined : `http_${r.status}` };
    } catch (e: any) { return { calls: [], ms: Date.now() - t0, err: e?.name }; }
  }
  if (method === "plan" || method === "hybrid") {
    const p = method === "plan" ? await planCalls(afm, { system: sys, context: q, tools: specs }) : await selectCalls(afm, { system: sys, context: q, tools: specs });
    if (p.kind === "calls") return { calls: p.calls.map((c) => ({ name: back.get(c.tool) ?? c.tool, args: c.args })), ms: p.latencyMs };
    return { calls: [], ms: p.latencyMs, err: p.kind === "failed" ? `${p.step}:${p.failure}` : undefined };
  }
  if (method === "ground") {
    const sel = await selectTool(afm, { system: sys, context: q, tools: specs, argMode: "fill_ground", request: q });
    if (sel.kind === "tool") return { calls: [{ name: back.get(sel.tool) ?? sel.tool, args: sel.args }], ms: sel.latencyMs };
    return { calls: [], ms: sel.latencyMs, err: sel.kind === "failed" ? `${sel.step}:${sel.failure}` : undefined };
  }
  const sel = method === "dispatch" ? await selectToolDispatch(afm, { system: sys, context: q, tools: specs }) : await selectTool(afm, { system: sys, context: q, tools: specs });
  if (sel.kind === "tool") return { calls: [{ name: back.get(sel.tool) ?? sel.tool, args: sel.args }], ms: sel.latencyMs };
  return { calls: [], ms: sel.latencyMs, err: sel.kind === "failed" ? `${sel.step}:${sel.failure}` : undefined };
}

const results: any[] = [];
const summary: Record<string, Record<string, { ok: number; n: number; ms: number; errs: number }>> = {};
for (const cat of CATS) {
  const items = sample(jsonl(join(DIR, `${cat}.json`)), N);
  const answers = cat === "irrelevance" ? null : new Map(jsonl(join(DIR, "answers", `${cat}.json`)).map((a: any) => [a.id, a.ground_truth]));
  for (const m of METHODS) {
    if ((cat === "parallel" || cat === "parallel_multiple") && (m === "twostep" || m === "dispatch" || m === "ground")) continue;   // single-call methods cannot answer
    const s = { ok: 0, n: 0, ms: 0, errs: 0 };
    for (const it of items) {
      const q = it.question[0].filter((x: any) => x.role === "user").map((x: any) => x.content).join("\n");
      const r = await run(m, q, it.function);
      const gt = answers ? answers.get(it.id) : null;
      const ok = score(r.calls, gt as any);
      s.n++; s.ms += r.ms; if (ok) s.ok++; if (r.err) s.errs++;
      results.push({ cat, method: m, id: it.id, ok, calls: r.calls, err: r.err, ms: r.ms });
    }
    (summary[cat] ??= {})[m] = s;
    console.log(`${cat.padEnd(18)} ${m.padEnd(9)} ${String(s.ok).padStart(3)}/${s.n}  avg ${(s.ms / s.n / 1000).toFixed(2)}s  errors ${s.errs}`);
  }
}
const out = join(DIR, "..", `bfcl-results-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`);
writeFileSync(out, JSON.stringify({ n: N, summary, results }, null, 1));
console.log("written", out);
