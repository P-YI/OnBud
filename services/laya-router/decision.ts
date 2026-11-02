// Decision layer. Rules-only for now; Laya / Decima scorers plug in behind DecisionProvider later.
// Hard safety rules live here and always win over any learned recommendation.

export type Action = "LOCAL_AFM" | "FRONTIER_GPT" | "FRONTIER_CLAUDE" | "RUN_VERIFICATION" | "ASK_USER";

export type TaskType =
  | "error_summary" | "code_explain" | "diff_summary" | "small_edit"
  | "multi_file_change" | "design" | "verification" | "document_overview" | "document_question" | "other";

export interface TaskMetadata {
  taskType: TaskType;
  estimatedInputTokens: number;
  filesTouched: number;
  command?: string;            // shell command the task wants to run, if any
  researchCritical?: boolean;  // numerical/scientific code where unverified local edits must not pass
  localAfmAvailable: boolean;
  prompt?: string;             // redacted request text, for learned scorers (Decima/Laya); rules ignore it
  taskId?: string;             // for telemetry of shadow decisions
}

export interface Decision {
  action: Action;
  reasonCode: string;
  provider: string;            // which DecisionProvider produced it
  policyVersion: string;
  rawScores?: Record<string, number>;  // uncalibrated; never treat as probabilities
}

export interface DecisionProvider {
  readonly name: string;
  decide(meta: TaskMetadata, candidates: Action[]): Promise<Decision>;
}

export interface RulesConfig {
  policyVersion: string;
  maxLocalInputTokens: number;  // conservative envelope inside the measured 8192 context
  maxLocalFiles: number;
  defaultFrontier: "FRONTIER_GPT" | "FRONTIER_CLAUDE";
  localTypes?: TaskType[];       // from policies/routing.yaml local_task_types
  alwaysFrontier?: TaskType[];   // from policies/routing.yaml always_frontier
}

export const DEFAULT_RULES: RulesConfig = {
  policyVersion: "rules-v0.1",
  maxLocalInputTokens: 5500,
  maxLocalFiles: 1,
  defaultFrontier: "FRONTIER_CLAUDE",
};

// Coarse first pass only. The real command gate (Phase F) parses argv and shell chaining;
// this list exists so the router never routes an obviously destructive command to a model.
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+push\b.*(--force|-f\b)/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
  /\b(mkfs|diskutil\s+erase|dd\s+if=)/,
  /\bdrop\s+(table|database)\b/i,
  /\bchmod\s+-R\b|\bchown\s+-R\b/,
];

const LOCAL_TYPES: TaskType[] = ["error_summary", "code_explain", "diff_summary", "small_edit"];
const ALWAYS_FRONTIER: TaskType[] = ["multi_file_change", "design"];

export function isDestructive(command: string | undefined): boolean {
  return !!command && DESTRUCTIVE.some((re) => re.test(command));
}

export class RulesDecisionProvider implements DecisionProvider {
  readonly name = "rules";
  private cfg: RulesConfig;
  // No parameter properties: Node's strip-only TypeScript mode rejects them.
  constructor(cfg: RulesConfig = DEFAULT_RULES) {
    this.cfg = cfg;
  }

  async decide(meta: TaskMetadata, candidates: Action[]): Promise<Decision> {
    const d = (action: Action, reasonCode: string): Decision => ({
      action: candidates.includes(action) ? action : "ASK_USER",
      reasonCode: candidates.includes(action) ? reasonCode : `${reasonCode}:not_in_candidates`,
      provider: this.name,
      policyVersion: this.cfg.policyVersion,
    });

    if (isDestructive(meta.command)) return d("ASK_USER", "destructive_command");
    if (meta.taskType === "verification") return d("RUN_VERIFICATION", "verification_task");
    if (meta.researchCritical) return d(this.cfg.defaultFrontier, "research_critical");
    if ((this.cfg.alwaysFrontier ?? ALWAYS_FRONTIER).includes(meta.taskType)) {
      return d(this.cfg.defaultFrontier, `complex_${meta.taskType}`);
    }
    if (meta.filesTouched > this.cfg.maxLocalFiles) return d(this.cfg.defaultFrontier, "too_many_files");
    if (meta.estimatedInputTokens > this.cfg.maxLocalInputTokens) return d(this.cfg.defaultFrontier, "context_too_large");
    if (!meta.localAfmAvailable) return d(this.cfg.defaultFrontier, "afm_unavailable");
    if ((this.cfg.localTypes ?? LOCAL_TYPES).includes(meta.taskType)) return d("LOCAL_AFM", `local_${meta.taskType}`);
    return d("ASK_USER", "unclassified");
  }
}
