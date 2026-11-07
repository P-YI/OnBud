// Code skill: pattern dictionary (2026-11-07). Approach notes for Copilot on contest-style code.
//   skills/code/patterns.json — 24 general algorithm patterns written for OnBud (original text and skeletons):
//   when each applies (signals), the idea, the invariant or pitfall, the cost, a short Python skeleton.
// Retrieval: the on-device model picks up to two patterns (an enum, so it cannot invent one). The notes go above the code as comments ("approach to check against the
// statement"); the examples and the gate still decide. Measured on the held-out LCB test split: docs/skills-plan.md §27.
// A private notebook of earlier Codex solutions and a plan-first escalation were measured too and left out
// (neither lowered Codex calls).
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Pattern { id: string; name: string; signals: string; idea: string; invariant: string; complexity: string; skeleton: string }

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "code", "patterns.json");
let pub: Pattern[] | undefined;
export function publicPatterns(): Pattern[] {
  if (!pub) { try { pub = JSON.parse(readFileSync(PUBLIC, "utf8")).patterns as Pattern[]; } catch { pub = []; } }
  return pub;
}

/** Up to two pattern ids for a task, picked by the on-device model from all patterns (an enum, so it cannot
 *  invent one); [] when none fits. A cue-shortlist tagger (v2, tuned on the dev split) removed this tagger's lean
 *  towards dp_1d but did not lower Codex calls on the held-out split (24 and 18 against 18-20), so v1 stays. */
export async function tagTask(afm: AFMProvider, prompt: string): Promise<string[]> {
  const ps = publicPatterns();
  if (!ps.length) return [];
  const r = await afm.generate({
    system: "Classify a programming task by the algorithm patterns that solve it. Pick at most two pattern ids from the list, best first, or none if no pattern clearly fits.",
    user: `PATTERNS:\n${ps.map((p) => `${p.id}: ${p.signals}`).join("\n")}\n\nTASK:\n${prompt.slice(0, 3000)}`,
    schema: { type: "object", properties: { patterns: { type: "array", items: { type: "string", enum: ["none", ...ps.map((p) => p.id)] }, maxItems: 2 } }, required: ["patterns"], additionalProperties: false },
    maxTokens: 120, timeoutMs: 45_000, temperature: 0,
  });
  return r.ok ? ((r.json as any).patterns ?? []).filter((x: string) => x !== "none").slice(0, 2) : [];
}

export interface Notes { text: string; ids: string[]; afmCalls: number }
/** Notes for a task: the chosen pattern(s), as text for comments above the code. */
export async function notesFor(afm: AFMProvider, prompt: string): Promise<Notes> {
  const tags = await tagTask(afm, prompt);
  const ps = publicPatterns().filter((p) => tags.includes(p.id));
  const text = ps.map((p) => `Pattern: ${p.name}. ${p.idea} Watch: ${p.invariant} Cost: ${p.complexity}.\nSkeleton:\n${p.skeleton}`).join("\n\n").slice(0, 2400);
  return { text, ids: ps.map((p) => p.id), afmCalls: 1 };
}
