// AFMProvider backed by apfel's OpenAI-compatible server on loopback.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AFMHealth, AFMProvider, AFMRequest, AFMResult } from "./provider.ts";
import { forWire, validate } from "./schema.ts";

export interface ApfelOptions {
  baseURL?: string;
  token?: string;
  tokenFile?: string;
  model?: string;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;   // injectable for tests
}

const REFUSAL = /\b(I cannot fulfill|I can't help with|I'm sorry, but I can't|unable to comply)\b/i;

export class ApfelProvider implements AFMProvider {
  readonly name = "apfel";
  private baseURL: string;
  private token?: string;
  private model: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: ApfelOptions = {}) {
    this.baseURL = opts.baseURL ?? "http://127.0.0.1:11434";
    this.model = opts.model ?? "apple-foundationmodel";
    this.timeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const file = opts.tokenFile ?? join(process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM"), "config", "apfel.token");
    try {
      this.token = opts.token ?? readFileSync(file, "utf8").trim();
    } catch {
      this.token = opts.token;
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async health(): Promise<AFMHealth> {
    try {
      const r = await this.fetchImpl(`${this.baseURL}/health`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return { ok: false };
      const d: any = await r.json();
      return { ok: d.status === "ok" && d.model_available !== false, model: d.model, contextWindow: d.context_window, version: d.version };
    } catch {
      return { ok: false };
    }
  }

  /** One retry with backoff for transient failures only (fm-proxy: never retry context overflow,
   *  guardrails or timeouts — the same input fails again, and a timed-out generation keeps running). */
  async generate(req: AFMRequest): Promise<AFMResult> {
    const first = await this.once(req);
    // 429: apfel runs with --max-concurrent 1, so a second client (bench, CLI) can briefly collide.
    if (first.ok || !(first.failure === "unavailable" || (first.failure === "http_error" && /^http_(5|429)/.test(first.detail ?? "")))) return first;
    await new Promise((r) => setTimeout(r, /^http_429/.test(first.detail ?? "") ? 1500 : 600));
    const second = await this.once(req);
    return { ...second, latencyMs: first.latencyMs + 600 + second.latencyMs, detail: second.detail ?? "retried" };
  }

  private async once(req: AFMRequest): Promise<AFMResult> {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 512,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (req.schema) {
      body.response_format = { type: "json_schema", json_schema: { name: "out", schema: forWire(req.schema), strict: true } };
    }
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs),
      });
    } catch (e: any) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      return { ok: false, failure: timeout ? "timeout" : "unavailable", detail: e?.name ?? "fetch_error", latencyMs: Date.now() - t0 };
    }
    const latencyMs = Date.now() - t0;
    if (r.status === 401 || r.status === 403) return { ok: false, failure: "auth", detail: `http_${r.status}`, latencyMs };
    let d: any;
    try {
      d = await r.json();
    } catch {
      return { ok: false, failure: "http_error", detail: `http_${r.status}_non_json`, latencyMs };
    }
    if (!r.ok) {
      const msg = String(d?.error?.message ?? "");
      if (/guardrail|content policy|safety/i.test(msg)) return { ok: false, failure: "guardrail", detail: `http_${r.status}`, latencyMs };
      const overflow = /context|too long|exceed/i.test(msg);
      return { ok: false, failure: overflow ? "context_overflow" : "http_error", detail: `http_${r.status}`, latencyMs };
    }
    const choice = d.choices?.[0];
    const text: string = choice?.message?.content ?? "";
    const usage = d.usage ? { prompt: d.usage.prompt_tokens, completion: d.usage.completion_tokens } : undefined;
    const base = { latencyMs, usage, finishReason: choice?.finish_reason };
    if (choice?.finish_reason === "content_filter" || /Content blocked by safety guardrails/i.test(text)) {
      return { ...base, ok: false, failure: "guardrail", detail: "content_filter", text };
    }
    if (choice?.message?.refusal) return { ...base, ok: false, failure: "refusal", detail: "model_refusal" };
    if (!text.trim()) return { ...base, ok: false, failure: "empty" };
    if (!req.schema) {
      if (REFUSAL.test(text) && text.length < 400) return { ...base, ok: false, failure: "refusal", text };
      return { ...base, ok: true, text };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ...base, ok: false, failure: "invalid_json", text };
    }
    const errs = validate(req.schema, json);
    if (errs.length) return { ...base, ok: false, failure: "schema_violation", detail: errs.slice(0, 3).join("; "), json };
    return { ...base, ok: true, json, text };
  }
}
