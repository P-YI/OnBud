// GREEN conditions (2026-11-06, docs/skills-plan.md §4): checks a program can evaluate, used by the skill eval
// runner now and by the skills' own loops later. Each returns a verdict with its evidence; none asks a model.
// Not checks: "looks good", the model's confidence, "no error was raised".
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface Verdict { ok: boolean; reason: string }

/** The checks skills may name in skill.json; `planned` ones are named in manifests but not yet implemented. */
export const CHECKS = {
  implemented: ["reply_language", "cited_paths_exist", "no_frontier", "within_latency", "stress_pass"],
  planned: ["quotes_in_evidence", "results_exist", "results_match_topic", "tests_pass", "diff_in_plan", "no_stub", "git_facts",
    "latex_compiles", "latex_keys_kept", "app_opened", "findings_have_location", "claims_have_source", "capsule_redacted", "frontier_budget"],
} as const;
export const KNOWN_CHECKS = new Set<string>([...CHECKS.implemented, ...CHECKS.planned]);

// One definition of "the language of a text", shared with the reply-language contract.
export { languageOf } from "./language.ts";
import { languageOf } from "./language.ts";

export function replyLanguage(request: string, answer: string): Verdict {
  const want = languageOf(request), got = languageOf(answer);
  if (!want || !got) return { ok: true, reason: `undetermined (request ${want ?? "?"}, answer ${got ?? "?"})` };
  return { ok: want === got, reason: `request ${want}, answer ${got}` };
}

function isGitRef(root: string, name: string): boolean {
  try { execFileSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${name}^{commit}`], { stdio: "ignore", timeout: 5000 }); return true; }
  catch { return false; }
}

/** Paths the answer cites (in backticks or file:// links) that exist, relative to `root` or absolute/home. */
export function citedPathsExist(answer: string, root?: string): Verdict {
  const cited = new Set<string>();
  for (const m of answer.matchAll(/`([^`\n]+)`/g)) {
    const s = m[1].replace(/:\d+(-\d+)?$/, "");
    if (/^(~\/|\/|\.{1,2}\/)|^[\w.-]+\/[\w./-]+$|^[\w-]+\.(py|ts|js|md|json|ya?ml|tex|bib|pdf|csv)$/.test(s) && !/\s/.test(s)) cited.add(s);
  }
  for (const m of answer.matchAll(/file:\/\/([^)\s]+)/g)) { try { cited.add(decodeURIComponent(m[1])); } catch { /* bad escape */ } }
  const missing = [...cited].filter((p) => {
    const abs = p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : root ? join(root, p) : undefined;
    if (!abs || existsSync(abs)) return false;
    return !(root && !p.startsWith("~/") && !isAbsolute(p) && isGitRef(root, p));   // `origin/main` is a branch, not a path
  });
  return { ok: !missing.length, reason: missing.length ? `missing: ${missing.slice(0, 5).join(", ")}` : `${cited.size} cited, all exist` };
}

export function noFrontier(o: { status: string; steps?: { kind: string }[] }): Verdict {
  const used = o.status === "answered_frontier" || (o.steps ?? []).some((s) => /^(frontier|codex)/.test(s.kind));
  return { ok: !used, reason: used ? "a frontier model was used" : "local only" };
}

export function withinLatency(ms: number, budgetMs?: number): Verdict {
  return budgetMs === undefined ? { ok: true, reason: `${ms} ms (no budget)` } : { ok: ms <= budgetMs, reason: `${ms} ms of ${budgetMs}` };
}

/** stress_pass (code skill, services/controller/code-skill.ts gate): the candidate agreed with a brute force on
 *  random inputs and finished on the worst-case input. Not gated (not contest code, not a retry) counts as a pass. */
export function stressPass(r: { verdict: "pass" | "fail" | "inconclusive"; detail: string; ran?: boolean; keep?: boolean }): Verdict {
  if (r.ran === false) return { ok: true, reason: "not gated" };
  return { ok: r.keep ?? r.verdict === "pass", reason: `${r.verdict}: ${r.detail}` };
}
