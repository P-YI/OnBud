// Provider-neutral AFM interface. The controller only sees AFMProvider, so apfel can be swapped
// for a native FoundationModels companion or OpenAppleModels later without touching routing.

import type { JSONSchema } from "./schema.ts";

export type AFMFailure =
  | "unavailable"        // server down / connection refused
  | "auth"               // 401/403
  | "timeout"
  | "context_overflow"   // input exceeds the measured context budget
  | "http_error"
  | "invalid_json"       // schema mode returned unparsable content
  | "schema_violation"   // parsed but failed host-side validation
  | "refusal"            // model refused
  | "guardrail"          // Apple safety guardrail blocked output (finish_reason content_filter); retrying unchanged input does not help
  | "empty";

export interface AFMRequest {
  system: string;
  user: string;
  schema?: JSONSchema;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;      // default 0 (greedy); >0 only for deliberate candidate sampling
}

export interface AFMResult {
  ok: boolean;
  text?: string;
  json?: unknown;
  failure?: AFMFailure;
  detail?: string;          // short, safe-to-log description
  latencyMs: number;
  usage?: { prompt: number; completion: number };
  finishReason?: string;
}

export interface AFMHealth {
  ok: boolean;
  model?: string;
  contextWindow?: number;
  version?: string;
}

export interface AFMProvider {
  readonly name: string;
  health(): Promise<AFMHealth>;
  generate(req: AFMRequest): Promise<AFMResult>;
}
