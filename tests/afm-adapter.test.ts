import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, forWire } from "../services/afm-adapter/schema.ts";
import { ApfelProvider } from "../services/afm-adapter/apfel.ts";
import { selectTool, RESPOND, type ToolSpec } from "../services/afm-adapter/tools.ts";
import { FakeAFM, isPick, isArgs } from "./helpers.ts";

const S = { type: "object" as const, properties: { a: { type: "string" as const }, n: { type: "integer" as const }, e: { type: "string" as const, enum: ["x", "y"] } }, required: ["a", "e"], additionalProperties: false };

test("schema validator", () => {
  assert.deepEqual(validate(S, { a: "1", e: "x" }), []);
  assert.ok(validate(S, { e: "x" }).some((m) => m.includes("missing")));
  assert.ok(validate(S, { a: "1", e: "z" }).some((m) => m.includes("enum")));
  assert.ok(validate(S, { a: "1", e: "x", extra: 1 }).some((m) => m.includes("unexpected")));
  assert.ok(validate(S, { a: "1", e: "x", n: 1.5 }).some((m) => m.includes("integer")));
  assert.equal("$schema" in forWire({ $schema: "x", type: "object" } as any), false);
});

function fakeFetch(handler: (url: string, init: any) => Response | Promise<Response>): typeof fetch {
  return (async (url: any, init: any) => handler(String(url), init)) as typeof fetch;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const completion = (content: string, extra: Record<string, unknown> = {}) =>
  json(200, { choices: [{ finish_reason: "stop", message: { content, ...extra } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

test("apfel provider: sends bearer token and parses schema output", async () => {
  let auth = "";
  const p = new ApfelProvider({ token: "T0K", fetchImpl: fakeFetch((_u, init) => { auth = init.headers.Authorization; return completion('{"a":"ok","e":"y"}'); }) });
  const r = await p.generate({ system: "s", user: "u", schema: S });
  assert.equal(auth, "Bearer T0K");
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { a: "ok", e: "y" });
  assert.deepEqual(r.usage, { prompt: 10, completion: 5 });
});

test("apfel provider: failure classification", async () => {
  const mk = (h: Parameters<typeof fakeFetch>[0]) => new ApfelProvider({ token: "t", fetchImpl: fakeFetch(h) });
  assert.equal((await mk(() => json(401, {})).generate({ system: "", user: "" })).failure, "auth");
  assert.equal((await mk(() => completion("not json")).generate({ system: "", user: "", schema: S })).failure, "invalid_json");
  assert.equal((await mk(() => completion('{"a":1}')).generate({ system: "", user: "", schema: S })).failure, "schema_violation");
  assert.equal((await mk(() => completion("")).generate({ system: "", user: "" })).failure, "empty");
  assert.equal((await mk(() => completion("x", { refusal: "no" })).generate({ system: "", user: "" })).failure, "refusal");
  assert.equal((await mk(() => json(400, { error: { message: "Input exceeds context window" } })).generate({ system: "", user: "" })).failure, "context_overflow");
  assert.equal((await mk(() => { throw new TypeError("fetch failed"); }).generate({ system: "", user: "" })).failure, "unavailable");
  // AbortSignal.timeout's timer is unref'd; hold the event loop open like a real socket would.
  const slow = mk((_u, init) => new Promise<Response>((_res, rej) => {
    const keep = setTimeout(() => {}, 1000);
    init.signal.addEventListener("abort", () => { clearTimeout(keep); rej(init.signal.reason); });
  }));
  assert.equal((await slow.generate({ system: "", user: "", timeoutMs: 30 })).failure, "timeout");
});

test("apfel provider: health", async () => {
  const p = new ApfelProvider({ token: "t", fetchImpl: fakeFetch(() => json(200, { status: "ok", model: "apple-foundationmodel", context_window: 8192, version: "1.16.0" })) });
  assert.deepEqual(await p.health(), { ok: true, model: "apple-foundationmodel", contextWindow: 8192, version: "1.16.0" });
  const down = new ApfelProvider({ token: "t", fetchImpl: fakeFetch(() => { throw new Error("ECONNREFUSED"); }) });
  assert.equal((await down.health()).ok, false);
});

const TOOLS: ToolSpec[] = [
  { name: "read_file", description: "read", args: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "search_code", description: "search", args: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];

test("two-step selection: enum pick, then that tool's own arg schema", async () => {
  const afm = new FakeAFM((r) => isPick(r) ? { json: { action: "read_file" } } : { json: { path: "src/app.py" } });
  const s = await selectTool(afm, { system: "s", context: "c", tools: TOOLS });
  assert.deepEqual(s.kind === "tool" && [s.tool, s.args], ["read_file", { path: "src/app.py" }]);
  assert.deepEqual(afm.calls[0].schema!.properties!.action.enum, ["read_file", "search_code", RESPOND]);
  assert.equal(afm.calls[1].schema!.additionalProperties, false);
  assert.deepEqual(afm.calls[1].schema!.required, ["path"]);
});

test("first-step-only control removes respond_directly", async () => {
  const afm = new FakeAFM((r) => isPick(r) ? { json: { action: "search_code" } } : { json: { pattern: "x" } });
  await selectTool(afm, { system: "s", context: "c", tools: TOOLS, allowRespond: false });
  assert.deepEqual(afm.calls[0].schema!.properties!.action.enum, ["read_file", "search_code"]);
});

test("selection: respond and failure paths", async () => {
  const respond = await selectTool(new FakeAFM(() => ({ json: { action: RESPOND } })), { system: "", context: "", tools: TOOLS });
  assert.equal(respond.kind, "respond");
  const badArgs = await selectTool(new FakeAFM((r) => isArgs(r) ? { failure: "schema_violation" } : { json: { action: "read_file" } }), { system: "", context: "", tools: TOOLS });
  assert.deepEqual(badArgs.kind === "failed" && [badArgs.step, badArgs.failure], ["args", "schema_violation"]);
  const unknown = await selectTool(new FakeAFM(() => ({ json: { action: "rm_everything" } })), { system: "", context: "", tools: TOOLS });
  assert.equal(unknown.kind === "failed" && unknown.failure, "unknown_tool");
});

test("groundArgs keeps stated optional values, drops defaults and invented ones", async () => {
  const { groundArgs } = await import("../services/afm-adapter/tools.ts");
  const schema = { type: "object" as const, required: ["recipeName"], properties: {
    recipeName: { type: "string" as const }, maxCalories: { type: "integer" as const }, cuisine: { type: "string" as const, description: "Default: 'any'" },
    detailed: { type: "boolean" as const }, unit: { type: "string" as const }, permeability: { type: "number" as const, description: "Default: 12.57" } } };
  const q = "Find a pasta carbonara recipe under 500 calories, detailed please";
  assert.deepEqual(groundArgs({ recipeName: "pasta carbonara", maxCalories: 500, cuisine: "any", detailed: true, unit: "seconds", permeability: 12.57 }, schema, q),
    { recipeName: "pasta carbonara", maxCalories: 500, detailed: true });
  assert.deepEqual(groundArgs({ recipeName: "x", maxCalories: 0, unit: "" }, schema, "a recipe"), { recipeName: "x" });
  assert.deepEqual(groundArgs({ recipeName: "x", unit: "Celsius" }, schema, "in celsius please"), { recipeName: "x", unit: "Celsius" });
});
