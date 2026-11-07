// Work graph (skills plan P4, 2026-11-06): nodes are units of work, edges are values that cross. Ready nodes run
// at the same time; a node whose check fails is sent back alone (unit, verdict, reason, evidence, scope), at most
// MAX_ATTEMPTS times; after that it fails (the plan that made it is wrong) and the nodes that need it are skipped.
// Node kinds: splitter (cuts the work), worker (a skill on one unit), code (one right answer: search, merge,
// rank, run tests; never a model), gate (decides what goes on). The record (graph.json) is a few KB.
import { writeFileSync } from "node:fs";

export const MAX_ATTEMPTS = 3;
export type NodeKind = "splitter" | "worker" | "code" | "gate";
export interface Verdict { ok: boolean; reason: string; evidence?: string }
export interface Return { unit: string; verdict: "red"; reason: string; evidence?: string; scope: string; attempt: number }
export interface GraphNode<T = unknown> {
  id: string; kind: NodeKind; skill?: string;
  deps?: string[];                                   // ids whose outputs this node reads (edges)
  run: (inputs: Record<string, unknown>, back?: Return) => Promise<T>;
  check?: (out: T) => Verdict | Promise<Verdict>;    // programmatic only
  scope?: string;                                    // what a correction may touch ("this file only")
}
export interface NodeRecord { id: string; kind: NodeKind; skill?: string; deps: string[]; status: "done" | "failed" | "skipped"; attempts: number; ms: number; reason?: string }
export interface GraphRun { outputs: Record<string, unknown>; record: NodeRecord[]; ms: number }

export async function runGraph(nodes: GraphNode[], opts: { save?: string; maxConcurrent?: number } = {}): Promise<GraphRun> {
  const t0 = Date.now();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) for (const d of n.deps ?? []) if (!ids.has(d)) throw new Error(`node ${n.id} needs unknown ${d}`);
  const outputs: Record<string, unknown> = {};
  const state = new Map<string, NodeRecord>();
  const pending = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  while (pending.size) {
    // skip whatever needs a failed or skipped node
    for (const id of [...pending]) {
      const n = byId.get(id)!;
      if ((n.deps ?? []).some((d) => state.get(d) && state.get(d)!.status !== "done")) {
        state.set(id, { id, kind: n.kind, skill: n.skill, deps: n.deps ?? [], status: "skipped", attempts: 0, ms: 0, reason: "a node it needs did not finish" });
        pending.delete(id);
      }
    }
    const ready = [...pending].filter((id) => (byId.get(id)!.deps ?? []).every((d) => state.get(d)?.status === "done"));
    if (!ready.length) { if (pending.size) throw new Error(`cycle among ${[...pending].join(", ")}`); break; }
    const batch = opts.maxConcurrent ? ready.slice(0, opts.maxConcurrent) : ready;
    await Promise.all(batch.map(async (id) => {
      const n = byId.get(id)!;
      const s0 = Date.now();
      const inputs = Object.fromEntries((n.deps ?? []).map((d) => [d, outputs[d]]));
      let back: Return | undefined;
      let rec: NodeRecord = { id, kind: n.kind, skill: n.skill, deps: n.deps ?? [], status: "failed", attempts: 0, ms: 0 };
      for (let a = 1; a <= MAX_ATTEMPTS; a++) {
        rec.attempts = a;
        try {
          const out = await n.run(inputs, back);
          const v = n.check ? await n.check(out) : { ok: true, reason: "no check" };
          if (v.ok) { outputs[id] = out; rec = { ...rec, status: "done" }; break; }
          back = { unit: id, verdict: "red", reason: v.reason, evidence: v.evidence, scope: n.scope ?? `this unit (${id}) only`, attempt: a };
          rec.reason = v.reason;
        } catch (e) { rec.reason = (e as Error).message.slice(0, 200); back = { unit: id, verdict: "red", reason: rec.reason, scope: n.scope ?? `this unit (${id}) only`, attempt: a }; }
        if (!n.check) break;   // nothing to correct against: one try
      }
      rec.ms = Date.now() - s0;
      state.set(id, rec);
      pending.delete(id);
    }));
  }
  const run: GraphRun = { outputs, record: nodes.map((n) => state.get(n.id)!), ms: Date.now() - t0 };
  if (opts.save) try { writeFileSync(opts.save, JSON.stringify({ ms: run.ms, nodes: run.record }, null, 1), { mode: 0o600 }); } catch { /* a record only */ }
  return run;
}
