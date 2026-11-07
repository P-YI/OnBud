// Skill router (skills plan P3, 2026-11-06): a request that no deterministic stage took is matched against the
// skills' entries (skill.json "entries": local skill id → example requests) before the generic AFM path.
//   1. the enabled entries, each with two example requests, are the options (a trigram prefilter was tried and
//      dropped: it keyed on words like "the" and found nothing for Spanish or Chinese requests)
//   2. AFM picks one or "none" (an enum: it cannot invent a skill); the request's language does not matter
//   3. gate: the pick must be an enabled skill; the controller then runs it like a rule match, with the same
//      folder and read-only rules
// ONBUD_ROUTER: fallback (default) | shadow (log the pick, change nothing) | off.
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { loadRegistry, type Registry } from "./registry.ts";
import { enabled } from "./settings.ts";


export interface Entry { id: string; skill: string; text: string[] }

function grams(t: string): Set<string> {
  const s = ` ${t.toLowerCase().normalize("NFC").replace(/[`"'“”‘’.,!?()[\]{}:;]/g, " ").replace(/\s+/g, " ").trim()} `;
  const g = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) g.add(s.slice(i, i + 3));
  return g;
}
/** Overlap of the request's trigrams with the example's (share of the shorter set): 0..1. */
export function similarity(a: string, b: string): number {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size) * (2 * Math.min(A.size, B.size) / (A.size + B.size)) ** 0.5;
}

export function entriesOf(reg: Registry = loadRegistry()): Entry[] {
  const out: Entry[] = [];
  for (const s of reg.skills) for (const [id, ex] of Object.entries((s as any).entries ?? {}) as [string, string[]][]) out.push({ id, skill: s.id, text: ex });
  return out;
}

export function candidates(entries: Entry[]): Entry[] {
  return entries.filter((e) => enabled(e.skill));
}

export function routerMode(): "fallback" | "shadow" | "off" {
  const m = process.env.ONBUD_ROUTER;
  return m === "shadow" || m === "off" ? m : "fallback";
}

/** The entry id to run, or undefined (no candidate, AFM said none, or it failed). */
export async function pickSkill(afm: AFMProvider, prompt: string, entries: Entry[], timeoutMs = 20_000): Promise<{ id?: string; cands: string[]; ms: number }> {
  const t0 = Date.now();
  const cands = candidates(entries);
  if (!cands.length) return { cands: [], ms: 0 };
  const ids = cands.map((c) => c.id);
  const r = await afm.generate({
    system: "Choose the tool whose job is exactly what the request asks for, or none. Questions about code, files, concepts or how to do something are none unless a tool does exactly that.",
    user: `REQUEST: ${prompt}\n\nTOOLS:\n${cands.map((c) => `- ${c.id}: "${c.text[0]}" / "${c.text[1]}"`).join("\n")}`,
    schema: { type: "object", properties: { tool: { type: "string", enum: ["none", ...ids] } }, required: ["tool"], additionalProperties: false },
    maxTokens: 30, timeoutMs,
  });
  const tool = r.ok ? String((r.json as any).tool ?? "none") : "none";
  return { id: ids.includes(tool) ? tool : undefined, cands: ids, ms: Date.now() - t0 };
}
