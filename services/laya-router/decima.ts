// Decima (decima:agent, a ~321M mmBERT decision encoder served by Ollaya) behind the DecisionProvider
// interface. It scores typed questions; it never generates text.
//   shadow  (default) rules decide; Decima's recommendation is logged next to it for later comparison
//           (no added latency: the call runs after the rules answer)
//   advise  Decima may change a rules decision only where the rules have no hard reason: a LOCAL_AFM
//           route for a generic task, or an "unclassified" ASK_USER — and only above a confidence bar
//   off     rules only
// Hard safety rules (destructive commands, verification, always-frontier types, size limits, AFM down)
// are never overridden. Confidence values are uncalibrated scores, not probabilities of success.

import type { Action, Decision, DecisionProvider, TaskMetadata } from "./decision.ts";
import { redact } from "../security/gate.ts";

// digest: the model version the thresholds were calibrated on (prefix of the Ollaya digest). If the served model
// differs, Decima's scores are logged (shadow) but no longer change routes until the thresholds are recalibrated.
export interface DecimaConfig { url: string; model: string; timeoutMs: number; mode: "off" | "shadow" | "advise"; minConfidence: number; digest?: string }
export const DEFAULT_DECIMA: DecimaConfig = { url: "http://127.0.0.1:11436", model: "decima:agent", timeoutMs: 4000, mode: "shadow", minConfidence: 0.6 };

const ROUTE_CRITERIA: Record<Action, string> = {
  LOCAL_AFM: "A small on-device model can handle it: a question, explanation, lookup or a small change to one file, using local files",
  FRONTIER_GPT: "Needs a strong cloud coding model: changes across several files, design, hard debugging or long reasoning",
  FRONTIER_CLAUDE: "Needs a strong cloud model for review or critical reasoning",
  RUN_VERIFICATION: "Mainly asks to run tests, builds or checks and report the result",
  ASK_USER: "Ambiguous, missing a required detail, or risky enough that the user must decide first",
};

export interface DecimaAnswer { route?: string; confidence?: number; probabilities?: Record<string, number>; secret?: number; destructive?: number; ms: number; model?: string }

export class DecimaClient {
  cfg: DecimaConfig;
  constructor(cfg: Partial<DecimaConfig> = {}) { this.cfg = { ...DEFAULT_DECIMA, ...cfg }; }

  served?: string;   // digest of the served model (from /api/tags), logged with every decision
  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.cfg.url}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return false;
      const m = ((await r.json().catch(() => ({}))) as any).models?.find((x: any) => x.name === this.cfg.model || x.model === this.cfg.model);
      this.served = m?.digest;
      return true;
    } catch { return false; }
  }
  /** The served model is the pinned one (or nothing is pinned, or the server does not report digests). */
  pinOk(): boolean { return !this.cfg.digest || !this.served || this.served.startsWith(this.cfg.digest); }

  private seen = { at: 0, up: false };
  /** Health, cached for a minute, so a missing Ollaya costs nothing per request and logs nothing. */
  async available(): Promise<boolean> {
    if (Date.now() - this.seen.at > 60_000) this.seen = { at: Date.now(), up: await this.health() };
    return this.seen.up;
  }

  /** Ask Decima for a route among `candidates` plus two risk flags. Throws on transport/format errors. */
  async route(meta: TaskMetadata, candidates: Action[]): Promise<DecimaAnswer> {
    const t0 = Date.now();
    const state = [
      `request: ${redact(meta.prompt ?? "").text.slice(0, 2000)}`,
      `task_type (local classifier guess): ${meta.taskType}`,
      `files named: ${meta.filesTouched}`,
      `estimated input tokens: ${meta.estimatedInputTokens}`,
      `on-device model available: ${meta.localAfmAvailable}`,
    ].join("\n");
    const criteria = Object.fromEntries(candidates.map((c) => [c, ROUTE_CRITERIA[c]]));
    const body = {
      model: this.cfg.model, state, keep_alive: "10m", stream: false,
      questions: {
        route: { type: "choice", instructions: "Which handler should take this coding-assistant request?", criteria },
        secret: { type: "noul", instructions: "The request contains or asks to reveal a secret, password, token or private key." },
        destructive: { type: "noul", instructions: "The request asks to delete data, overwrite history, or run a destructive command." },
      },
    };
    const r = await fetch(`${this.cfg.url}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!r.ok) throw new Error(`decima_http_${r.status}`);
    const d: any = await r.json();
    const a = d?.answers ?? {};
    if (!a.route?.choice) throw new Error("decima_bad_response");
    return { route: a.route.choice, confidence: a.route.confidence, probabilities: a.route.probabilities, secret: a.secret?.noul, destructive: a.destructive?.noul, ms: Date.now() - t0, model: d.model };
  }
}

/** Reason codes from the rules that Decima must never override. */
const HARD = /^(destructive_command|verification_task|research_critical|complex_|too_many_files|context_too_large|afm_unavailable)/;

export class DecimaDecisionProvider implements DecisionProvider {
  readonly name: string;
  private rules: DecisionProvider;
  private client: DecimaClient;
  private onShadow?: (meta: TaskMetadata, rules: Decision, d: DecimaAnswer | { error: string }) => void;
  constructor(rules: DecisionProvider, client: DecimaClient, onShadow?: DecimaDecisionProvider["onShadow"]) {
    this.rules = rules; this.client = client; this.onShadow = onShadow;
    this.name = `rules+decima(${client.cfg.mode})`;
  }

  async decide(meta: TaskMetadata, candidates: Action[]): Promise<Decision> {
    const base = await this.rules.decide(meta, candidates);
    const mode = this.client.cfg.mode;
    if (mode === "off" || !meta.prompt) return base;
    if (mode === "shadow") {
      this.client.available().then((up) => up && this.client.route(meta, candidates)
        .then((d) => this.onShadow?.(meta, base, d))
        .catch((e) => this.onShadow?.(meta, base, { error: String(e?.message ?? e) })));
      return base;
    }
    // advise (only with the pinned model version; another version is scored in shadow until recalibrated)
    if (!(await this.client.available())) return base;
    if (!this.client.pinOk()) {
      this.client.route(meta, candidates).then((d) => this.onShadow?.(meta, base, d)).catch(() => {});
      return { ...base, provider: `${this.name}:unpinned` };
    }
    if (HARD.test(base.reasonCode)) return base;
    const generic = (base.action === "LOCAL_AFM" && meta.taskType === "other") || base.reasonCode === "unclassified";
    if (!generic) return base;
    try {
      const d = await this.client.route(meta, candidates);
      this.onShadow?.(meta, base, d);
      if (d.route && d.route !== base.action && (d.confidence ?? 0) >= this.client.cfg.minConfidence && candidates.includes(d.route as Action)) {
        return { ...base, action: d.route as Action, reasonCode: `decima_${d.route.toLowerCase()}`, provider: this.name, rawScores: d.probabilities };
      }
      return { ...base, provider: this.name, rawScores: d.probabilities };
    } catch (e: any) {
      this.onShadow?.(meta, base, { error: String(e?.message ?? e) });
      return base;   // Decima down or slow → rules
    }
  }
}

/** Difficulty of a code-writing task for the on-device model (a coding question, not the routing question).
 *  Returns Decima's probability for "needs a strong model"; thresholds are calibrated on dev splits only. */
export async function codeDifficulty(client: DecimaClient, taskText: string): Promise<number | undefined> {
  if (!(await client.available()) || !client.pinOk()) return undefined;   // threshold calibrated on the pinned model only
  try {
    const r = await fetch(`${client.cfg.url}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(client.cfg.timeoutMs),
      body: JSON.stringify({ model: client.cfg.model, state: `coding task:\n${redact(taskText).text.slice(0, 6000)}`, questions: { difficulty: { type: "choice", instructions: "Can a small 3B on-device model write correct code for this task on the first try?",
        criteria: { small_model: "Short, standard function with a direct, well-known solution and few edge cases", strong_model: "Needs a non-trivial algorithm, careful edge cases, tricky parsing, or specific library knowledge" } } } }) });
    const d: any = await r.json();
    return d?.answers?.difficulty?.probabilities?.strong_model;
  } catch { return undefined; }
}
