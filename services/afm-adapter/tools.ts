// Two-step guided tool selection for AFM.
// Measured on this Mac (runtime/reports/afm-toolprobe2-*): apfel's native tool_calls picked the right
// tool 8/9 but produced valid arguments only 1/9 (renamed params, argv arrays, everything in "value").
// Constraining decoding with a schema instead — first the tool name as an enum, then that tool's
// argument object — gave 9/9 valid calls and was faster. AFM never executes anything itself:
// the controller runs the chosen tool through the security gate.

import type { AFMProvider, AFMFailure } from "./provider.ts";
import type { JSONSchema } from "./schema.ts";

export interface ToolSpec {
  name: string;
  description: string;
  args: JSONSchema & { type: "object" };
}

export const RESPOND = "respond_directly";
// Optional arguments. BFCL failure analysis (2026-10-30): with "omit unless given", AFM mostly left out
// optional values the request DID state (under-fill, ~9 of 20 errors); inventing values was rarer (2).
// "fill_ground" makes every argument required (so each is considered), then drops optional values that
// are not grounded in the request text (see groundArgs) — deterministic, no extra model call.
const OMIT = "Omit optional arguments unless the request gives a value for them; never invent values.";
const FILL = "Give every argument. For an optional argument the request does not mention, use its default (or an empty string, 0 or false); never invent a specific value.";

const words = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}.]+/gu, " ").trim();

/** Keep an optional argument only if the request actually states it (value or parameter name appears). */
export function groundArgs(args: Record<string, unknown>, schema: JSONSchema, request: string): Record<string, unknown> {
  const req = new Set(schema.required ?? []);
  const text = ` ${words(request)} `;
  const props = schema.properties ?? {};
  const has = (v: unknown): boolean => {
    if (typeof v === "number") return new RegExp(`(^|[^0-9.])${String(v).replace(".", "\\.")}(\\.0+)?([^0-9]|$)`).test(text) || (Number.isInteger(v) && text.includes(` ${v} `));
    if (typeof v === "string") {
      const w = words(v);
      if (!w) return false;
      if (text.includes(` ${w} `) || text.includes(w)) return true;
      const parts = w.split(" ").filter((x) => x.length >= 3);
      return parts.length > 0 && parts.filter((x) => text.includes(x)).length / parts.length >= 0.5;
    }
    if (Array.isArray(v)) return v.some(has);
    return v !== null && typeof v === "object";
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (req.has(k)) { out[k] = v; continue; }
    const p = (props[k] ?? {}) as JSONSchema & { default?: unknown };
    const dflt = p.default ?? (/Default: (.+?)\.?$/.exec(p.description ?? "")?.[1]);
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (dflt !== undefined && JSON.stringify(v) === (typeof dflt === "string" && !dflt.startsWith('"') ? JSON.stringify(dflt.replace(/^'|'$/g, "")) : JSON.stringify(dflt))) continue;
    if (dflt !== undefined && String(v) === String(dflt).replace(/^["']|["']$/g, "")) continue;
    if (typeof v === "boolean") {
      // A flag counts as stated when its name's words appear ("equal variance", "detailed").
      const nameWords = k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4);
      if (nameWords.some((x) => text.includes(x.slice(0, Math.max(4, x.length - 2))))) out[k] = v;
      continue;
    }
    if (has(v)) out[k] = v;
  }
  return out;
}

export type Selection =
  | { kind: "tool"; tool: string; args: Record<string, unknown>; latencyMs: number }
  | { kind: "respond"; latencyMs: number }
  | { kind: "failed"; failure: AFMFailure | "unknown_tool"; step: "pick" | "args"; detail?: string; latencyMs: number };

export interface SelectOptions {
  system: string;          // task-level instructions (skill)
  context: string;         // current capsule: goal + observations so far
  tools: ToolSpec[];
  allowRespond?: boolean;  // false on the first step forces a tool (first-step-only control)
  timeoutMs?: number;
  argMode?: "omit" | "fill_ground";   // how optional arguments are handled (default fill_ground)
  request?: string;        // text to ground optional arguments against (default: context)
}

export async function selectTool(afm: AFMProvider, o: SelectOptions): Promise<Selection> {
  const names = o.tools.map((t) => t.name);
  const choices = o.allowRespond === false ? names : [...names, RESPOND];
  const menu = o.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")
    + (o.allowRespond === false ? "" : `\n- ${RESPOND}: you already have enough information to answer`);

  const pick = await afm.generate({
    system: `${o.system}\n\nChoose the single next action.\nActions:\n${menu}`,
    user: o.context,
    schema: {
      type: "object",
      properties: { action: { type: "string", enum: choices, description: "The next action to take" } },
      required: ["action"],
      additionalProperties: false,
    },
    maxTokens: 64,
    timeoutMs: o.timeoutMs,
  });
  if (!pick.ok) return { kind: "failed", failure: pick.failure ?? "empty", step: "pick", detail: pick.detail, latencyMs: pick.latencyMs };

  const action = (pick.json as { action: string }).action;
  if (action === RESPOND) return { kind: "respond", latencyMs: pick.latencyMs };
  const spec = o.tools.find((t) => t.name === action);
  if (!spec) return { kind: "failed", failure: "unknown_tool", step: "pick", latencyMs: pick.latencyMs };

  const fill = (o.argMode ?? "fill_ground") === "fill_ground";   // BFCL quick check: 65/80 vs 62/80 for "omit"
  const args = await afm.generate({
    system: `Fill in the arguments for the tool \`${spec.name}\`: ${spec.description}\nUse exact identifiers and paths from the context. ${fill ? FILL : OMIT}`,
    user: o.context,
    schema: { ...spec.args, ...(fill ? { required: Object.keys(spec.args.properties ?? {}) } : {}), additionalProperties: false },
    maxTokens: 200,
    timeoutMs: o.timeoutMs,
  });
  const latencyMs = pick.latencyMs + args.latencyMs;
  if (!args.ok) return { kind: "failed", failure: args.failure ?? "empty", step: "args", detail: args.detail, latencyMs };
  const raw = args.json as Record<string, unknown>;
  return { kind: "tool", tool: spec.name, args: fill ? groundArgs(raw, spec.args, o.request ?? o.context) : raw, latencyMs };
}

// ---------------------------------------------------------------- single-call dispatch (fm-proxy)
// One schema with one optional property per tool; the model fills exactly one key. One AFM call
// instead of two. fm-proxy measured 9/10 right tool with five tools vs 2–5/10 natively.

export async function selectToolDispatch(afm: AFMProvider, o: SelectOptions): Promise<Selection> {
  const properties: Record<string, JSONSchema> = {};
  for (const t of o.tools) properties[t.name] = { ...t.args, additionalProperties: false, description: t.description };
  if (o.allowRespond !== false) {
    properties[RESPOND] = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], description: "No tool is needed or none fits" };
  }
  const names = Object.keys(properties);
  const r = await afm.generate({
    system: `${o.system}\n\nRespond with a JSON object whose single key is the name of exactly one action (${names.map((n) => `"${n}"`).join(", ")}) and whose value is that action's arguments. Never add other keys.`,
    user: o.context,
    schema: { type: "object", properties, required: [], additionalProperties: false },
    maxTokens: 220,
    timeoutMs: o.timeoutMs,
  });
  const json = r.json as Record<string, unknown> | undefined;
  if (!json || (!r.ok && r.failure !== "schema_violation")) return { kind: "failed", failure: r.failure ?? "empty", step: "pick", detail: r.detail, latencyMs: r.latencyMs };
  const key = Object.keys(json).find((k) => names.includes(k));
  if (!key) return { kind: "failed", failure: "unknown_tool", step: "pick", latencyMs: r.latencyMs };
  if (key === RESPOND) return { kind: "respond", latencyMs: r.latencyMs };
  const args = (json[key] ?? {}) as Record<string, unknown>;
  const spec = o.tools.find((t) => t.name === key)!;
  const missing = (spec.args.required ?? []).filter((k) => !(k in args));
  if (missing.length) return { kind: "failed", failure: "schema_violation", step: "args", detail: `missing ${missing.join(",")}`, latencyMs: r.latencyMs };
  return { kind: "tool", tool: key, args, latencyMs: r.latencyMs };
}

// ---------------------------------------------------------------- parallel / multiple calls in one turn
// BFCL "parallel" asks for several calls from one request. Step 1 plans the ordered list of tool
// names (an array of enum strings — arrays of objects are not supported by guided generation);
// step 2 fills each call's arguments, showing the calls already filled so items are not repeated.

export type Plan =
  | { kind: "calls"; calls: { tool: string; args: Record<string, unknown> }[]; latencyMs: number }
  | { kind: "respond"; latencyMs: number }
  | { kind: "failed"; failure: string; step: "plan" | "args"; latencyMs: number };

export async function planCalls(afm: AFMProvider, o: SelectOptions & { maxCalls?: number }): Promise<Plan> {
  const names = o.tools.map((t) => t.name);
  const menu = o.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const plan = await afm.generate({
    system: `${o.system}\n\nList every function call needed to fully answer the request, in order. ` +
      `If the request asks for the same operation on several items, list the function once per item. ` +
      `Return an empty list if no function fits.\nFunctions:\n${menu}`,
    user: o.context,
    schema: { type: "object", properties: { calls: { type: "array", items: { type: "string", enum: names }, description: "Function names, one entry per call" } }, required: ["calls"], additionalProperties: false },
    maxTokens: 120,
    timeoutMs: o.timeoutMs,
  });
  let latency = plan.latencyMs;
  if (!plan.ok) return { kind: "failed", failure: plan.failure ?? "empty", step: "plan", latencyMs: latency };
  const list = ((plan.json as any).calls as string[]).slice(0, o.maxCalls ?? 6);
  if (!list.length) return { kind: "respond", latencyMs: latency };
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  for (let i = 0; i < list.length; i++) {
    const spec = o.tools.find((t) => t.name === list[i])!;
    const done = calls.length ? `\nCalls already filled (do not repeat their values):\n${calls.map((c) => `${c.tool}(${JSON.stringify(c.args)})`).join("\n")}` : "";
    const a = await afm.generate({
      system: `Fill in the arguments for call ${i + 1} of ${list.length}: \`${spec.name}\` — ${spec.description}\n` +
        `Use exact values from the request. ${OMIT}${list.length > 1 ? " Each call handles a different item of the request, in the order the request mentions them." : ""}`,
      user: o.context + done,
      schema: { ...spec.args, additionalProperties: false },
      maxTokens: 200,
      timeoutMs: o.timeoutMs,
    });
    latency += a.latencyMs;
    if (!a.ok) return { kind: "failed", failure: a.failure ?? "empty", step: "args", latencyMs: latency };
    calls.push({ tool: spec.name, args: a.json as Record<string, unknown> });
  }
  return { kind: "calls", calls, latencyMs: latency };
}

// ---------------------------------------------------------------- hybrid: relevance first, then plan
// BFCL quick check: the two-step pick (with respond_directly) was best at refusing irrelevant
// requests (17/20) while planCalls handles parallel requests; combine them.
export async function selectCalls(afm: AFMProvider, o: SelectOptions & { maxCalls?: number }): Promise<Plan> {
  const names = o.tools.map((t) => t.name);
  const menu = o.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n") + `\n- ${RESPOND}: none of the functions fits the request`;
  const pick = await afm.generate({
    system: `${o.system}\n\nChoose the function the request needs first, or ${RESPOND} if none fits.\nActions:\n${menu}`,
    user: o.context,
    schema: { type: "object", properties: { action: { type: "string", enum: [...names, RESPOND] } }, required: ["action"], additionalProperties: false },
    maxTokens: 64,
    timeoutMs: o.timeoutMs,
  });
  if (!pick.ok) return { kind: "failed", failure: pick.failure ?? "empty", step: "plan", latencyMs: pick.latencyMs };
  if ((pick.json as any).action === RESPOND) return { kind: "respond", latencyMs: pick.latencyMs };
  const p = await planCalls(afm, o);
  if (p.kind === "respond") {   // planner returned nothing although a function fits: fall back to the single pick
    const r = await selectTool(afm, { ...o, allowRespond: false });
    if (r.kind === "tool") return { kind: "calls", calls: [{ tool: r.tool, args: r.args }], latencyMs: pick.latencyMs + p.latencyMs + r.latencyMs };
  }
  return { ...p, latencyMs: p.latencyMs + pick.latencyMs } as Plan;
}
