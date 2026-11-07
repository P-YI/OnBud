// Skill registry (2026-11-06, docs/skills-plan.md): reads skills/<id>/skill.json, checks each contract and the
// rules between skills, and maps a controller reason code to the skill that owns it. Phase 0 only describes and
// measures: nothing here changes how a request is routed.
// Rules: unique ids; a reason code owned by exactly one skill; the manifest format's major version must match;
// frontier ⇒ egress capsule; network ⇒ egress query or capsule; remote ⇒ egress remote (the user's own server); an irreversible skill has no automatic lane (it
// cannot list "run_approved"); third-party skills (an extra folder) may only read and propose.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CHECKS } from "./checks.ts";

export const CONTRACT = "1.2";   // 1.1: "entries" (router examples), capability "write_new", "private"; 1.2: capability and egress "remote"
export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const CAPABILITIES = ["read", "propose", "job", "run_approved", "write_new", "network", "frontier", "remote"] as const;
const LANES = ["contained", "wide", "irreversible"] as const;
const EGRESS = ["none", "query", "capsule", "remote"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface SkillManifest {
  id: string; version: string; contract: string; description: string;
  examples: string[];
  reasonCodes: string[];            // exact, or a prefix ending in "*"
  capabilities: Capability[];
  lane: (typeof LANES)[number];
  egress: (typeof EGRESS)[number];
  checks: string[];                 // GREEN conditions (names from services/skills/checks.ts)
  budget?: { afmCalls?: number; latencyMs?: number; frontierCalls?: number };
  entries?: Record<string, string[]>;   // local skill id → example requests (the router's evidence)
  private?: boolean;                    // its output is personal data: never stored, never handed to a frontier
  plugin?: string;                      // the optional plugin (Spotlight > Settings > Plugins) it works with, if any
  thirdParty?: boolean;             // set by the loader for folders outside the repository
}

export interface Registry { skills: SkillManifest[]; errors: string[]; ownerOf: (reasonCode: string) => SkillManifest | undefined }

const SEMVER = /^\d+\.\d+\.\d+$/;
/** Problems with one manifest on its own (empty = valid). */
export function validateManifest(m: any, thirdParty = false): string[] {
  const e: string[] = [];
  const id = typeof m?.id === "string" ? m.id : "?";
  const need = (k: string, ok: boolean) => { if (!ok) e.push(`${id}: ${k}`); };
  need("id must be lowercase letters, digits, - or _", typeof m?.id === "string" && /^[a-z][a-z0-9_-]{1,40}$/.test(m.id));
  need("version must be semver", typeof m?.version === "string" && SEMVER.test(m.version));
  need(`contract major must be ${CONTRACT.split(".")[0]}`, typeof m?.contract === "string" && m.contract.split(".")[0] === CONTRACT.split(".")[0]);
  need("description", typeof m?.description === "string" && m.description.trim().length > 10);
  need("examples (≥ 2 strings)", Array.isArray(m?.examples) && m.examples.length >= 2 && m.examples.every((x: unknown) => typeof x === "string" && x.trim()));
  need("reasonCodes (≥ 1)", Array.isArray(m?.reasonCodes) && m.reasonCodes.length > 0 && m.reasonCodes.every((x: unknown) => typeof x === "string" && /^[a-z_]+\*?$/.test(x)));
  need("capabilities", Array.isArray(m?.capabilities) && m.capabilities.every((c: any) => CAPABILITIES.includes(c)));
  need("lane", LANES.includes(m?.lane));
  need("egress", EGRESS.includes(m?.egress));
  need("checks", Array.isArray(m?.checks) && m.checks.every((x: unknown) => typeof x === "string"));
  if (e.length) return e;
  for (const c of m.checks) if (!KNOWN_CHECKS.has(c)) e.push(`${id}: unknown check "${c}"`);
  const caps = new Set<string>(m.capabilities);
  if (caps.has("frontier") && m.egress !== "capsule") e.push(`${id}: frontier needs egress "capsule"`);
  if (caps.has("network") && m.egress === "none") e.push(`${id}: network needs egress "query" or "capsule"`);
  if (caps.has("remote") !== (m.egress === "remote")) e.push(`${id}: capability "remote" and egress "remote" go together`);
  if (!caps.has("network") && !caps.has("frontier") && !caps.has("remote") && m.egress !== "none") e.push(`${id}: egress "${m.egress}" without network or frontier`);
  if (m.lane === "irreversible" && caps.has("run_approved")) e.push(`${id}: an irreversible skill has no automatic lane`);
  if (thirdParty && [...caps].some((c) => c !== "read" && c !== "propose")) e.push(`${id}: third-party skills may only read and propose`);
  if (m.private && (caps.has("frontier") || m.egress !== "none")) e.push(`${id}: a private skill cannot send anything off the Mac`);
  if (m.entries !== undefined && (typeof m.entries !== "object" || Object.values(m.entries).some((v: any) => !Array.isArray(v) || v.length < 2 || v.some((x: unknown) => typeof x !== "string")))) e.push(`${id}: entries must map ids to ≥ 2 example strings`);
  return e;
}

const matches = (pattern: string, code: string) => (pattern.endsWith("*") ? code.startsWith(pattern.slice(0, -1)) : code === pattern);

/** Loads every skill under `dir` (and `extraDirs`, as third-party), with the rules between skills. */
export function loadRegistry(dir = SKILLS_DIR, extraDirs: string[] = []): Registry {
  const skills: SkillManifest[] = [];
  const errors: string[] = [];
  for (const [base, third] of [[dir, false], ...extraDirs.map((d) => [d, true] as const)] as const) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const f = join(base, name, "skill.json");
      if (!existsSync(f)) continue;
      let m: any;
      try { m = JSON.parse(readFileSync(f, "utf8")); } catch (err) { errors.push(`${name}: skill.json is not JSON (${(err as Error).message})`); continue; }
      const bad = validateManifest(m, third);
      if (m?.id !== name) bad.push(`${name}: id must equal its folder name`);
      if (bad.length) { errors.push(...bad); if (third) continue; }
      if (skills.some((s) => s.id === m.id)) { errors.push(`${m.id}: duplicate id`); continue; }
      skills.push({ ...m, thirdParty: third || undefined });
    }
  }
  // a reason code owned twice: exact codes, and an exact code under another skill's prefix
  for (const a of skills) for (const b of skills) {
    if (a.id >= b.id) continue;
    for (const pa of a.reasonCodes) for (const pb of b.reasonCodes) {
      const clash = pa === pb || (pa.endsWith("*") && matches(pa, pb.replace(/\*$/, ""))) || (pb.endsWith("*") && matches(pb, pa.replace(/\*$/, "")));
      if (clash) errors.push(`reason code ${pa} / ${pb} owned by both ${a.id} and ${b.id}`);
    }
  }
  const ownerOf = (code: string) => {
    // the most specific pattern wins (an exact code over a prefix, a longer prefix over a shorter one)
    let best: { s: SkillManifest; len: number } | undefined;
    for (const s of skills) for (const p of s.reasonCodes) if (matches(p, code)) {
      const len = p.endsWith("*") ? p.length - 1 : 1e6;
      if (!best || len > best.len) best = { s, len };
    }
    return best?.s;
  };
  return { skills, errors, ownerOf };
}
