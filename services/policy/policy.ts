// Loads policies/ (routing.yaml, AFM.md, skills) and fingerprints them so every outcome records
// exactly which prompt + rules produced it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RulesConfig, TaskType } from "../laya-router/decision.ts";

type YAML = string | number | boolean | null | YAML[] | { [k: string]: YAML };

/** Parser for the YAML subset used in routing.yaml: nested maps by indentation, scalar lists, comments. */
export function parseYaml(src: string): YAML {
  const lines = src.split("\n")
    .map((raw) => raw.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
    .filter((l) => l.trim());
  let i = 0;
  const scalar = (v: string): YAML => {
    const s = v.trim().replace(/^["']|["']$/g, "");
    if (s === "true" || s === "false") return s === "true";
    if (s === "null" || s === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };
  const indent = (l: string) => l.length - l.trimStart().length;
  const block = (level: number): YAML => {
    if (lines[i].trimStart().startsWith("- ")) {
      const arr: YAML[] = [];
      while (i < lines.length && indent(lines[i]) === level && lines[i].trimStart().startsWith("- ")) arr.push(scalar(lines[i++].trimStart().slice(2)));
      return arr;
    }
    const obj: Record<string, YAML> = {};
    while (i < lines.length && indent(lines[i]) === level) {
      const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(lines[i]);
      if (!m) throw new Error(`routing.yaml: cannot parse line: ${lines[i].trim()}`);
      i++;
      if (m[3] !== "") obj[m[2]] = scalar(m[3]);
      else obj[m[2]] = i < lines.length && indent(lines[i]) > level ? block(indent(lines[i])) : null;
    }
    return obj;
  };
  return lines.length ? block(indent(lines[0])) : {};
}

export interface Policy {
  version: string;
  hash: string;                 // sha256 of routing.yaml + AFM.md + all skills, first 12 hex
  rules: RulesConfig;
  afm: { maxRounds: number; maxToolCalls: number; timeoutMs: number; maxInputTokens: number };
  afmSystem: string;
  decision: { decima: { mode: "off" | "shadow" | "advise"; url: string; model: string; digest?: string; timeoutMs: number; minConfidence: number; codeHardThreshold: number }; copilotMode: "balanced" | "saver" };
  skills: Partial<Record<TaskType, { name: string; text: string }>>;
}

export function loadPolicy(dir = new URL("../../policies/", import.meta.url).pathname): Policy {
  const routingSrc = readFileSync(join(dir, "routing.yaml"), "utf8");
  const afmSystem = readFileSync(join(dir, "AFM.md"), "utf8").trim();
  const y = parseYaml(routingSrc) as any;
  const h = createHash("sha256").update(routingSrc).update(afmSystem);

  const skills: Policy["skills"] = {};
  for (const [taskType, name] of Object.entries<string>(y.skills ?? {})) {
    const p = join(dir, "skills", `${name}.md`);
    if (!existsSync(p)) throw new Error(`routing.yaml: skill "${name}" has no file ${p}`);
    const text = readFileSync(p, "utf8").trim();
    h.update(name).update(text);
    skills[taskType as TaskType] = { name, text };
  }

  const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  return {
    version: String(y.version ?? "unversioned"),
    hash: h.digest("hex").slice(0, 12),
    rules: {
      policyVersion: String(y.version ?? "unversioned"),
      maxLocalInputTokens: num(y.afm?.max_input_tokens, 5500),
      maxLocalFiles: num(y.afm?.max_files, 1),
      defaultFrontier: y.frontier?.default === "FRONTIER_CLAUDE" ? "FRONTIER_CLAUDE" : "FRONTIER_GPT",
      localTypes: (y.local_task_types ?? ["error_summary", "code_explain", "diff_summary", "small_edit"]) as TaskType[],
      alwaysFrontier: (y.always_frontier ?? ["multi_file_change", "design"]) as TaskType[],
    },
    afm: {
      maxRounds: num(y.afm?.max_rounds, 4),
      maxToolCalls: num(y.afm?.max_tool_calls, 6),
      timeoutMs: num(y.afm?.timeout_ms, 30_000),
      maxInputTokens: num(y.afm?.max_input_tokens, 5500),
    },
    afmSystem,
    decision: {
      decima: {
        mode: (["off", "shadow", "advise"].includes(y.decision?.decima_mode) ? y.decision.decima_mode : "off") as "off" | "shadow" | "advise",
        url: String(y.decision?.decima_url ?? "http://127.0.0.1:11436"),
        model: String(y.decision?.decima_model ?? "decima:agent"),
        digest: y.decision?.decima_model_digest ? String(y.decision.decima_model_digest) : undefined,
        timeoutMs: num(y.decision?.decima_timeout_ms, 4000),
        minConfidence: num(y.decision?.decima_min_confidence, 0.6),
        codeHardThreshold: num(y.decision?.decima_code_hard_threshold, 0.5),
      },
      copilotMode: y.decision?.copilot_mode === "saver" ? "saver" : "balanced",
    },
    skills,
  };
}

/** AFM system prompt for one task: base policy + at most one task-specific skill. */
export function systemFor(policy: Policy, taskType: TaskType): { text: string; skill?: string } {
  const s = policy.skills[taskType];
  return s ? { text: `${policy.afmSystem}\n\n${s.text}`, skill: s.name } : { text: policy.afmSystem };
}
