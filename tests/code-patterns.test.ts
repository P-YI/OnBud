import test from "node:test";
import assert from "node:assert/strict";
import { publicPatterns, notesFor } from "../services/controller/code-patterns.ts";

test("public dictionary: every pattern is complete and ids are unique", () => {
  const ps = publicPatterns();
  assert.ok(ps.length >= 20);
  assert.equal(new Set(ps.map((p) => p.id)).size, ps.length);
  for (const p of ps) for (const k of ["id", "name", "signals", "idea", "invariant", "complexity", "skeleton"] as const) assert.ok(p[k]?.trim(), `${p.id}.${k}`);
});

test("notes: the model's picks (an enum of the dictionary's ids) become comments; none gives no notes", async () => {
  const pick = (ids: string[]) => ({ generate: async (r: any) => { assert.deepEqual(r.schema.properties.patterns.items.enum.slice(0, 1), ["none"]); return { ok: true, json: { patterns: ids } }; } }) as any;
  const n = await notesFor(pick(["sweep_line", "none"]), "Given meeting intervals, return the maximum overlap.");
  assert.deepEqual(n.ids, ["sweep_line"]); assert.match(n.text, /Sweep line/); assert.match(n.text, /Skeleton:/);
  const none = await notesFor(pick(["none"]), "Print hello.");
  assert.deepEqual(none.ids, []); assert.equal(none.text, "");
});
