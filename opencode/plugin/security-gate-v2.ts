// OpenCode 2.x (desktop app) port of the security gate. Same services/security logic as the 1.x plugin.
// 2.x plugin contract (reverse-checked on 2.2.3, not a published SDK yet — re-verify after upgrades):
//   export default { id, setup(ctx) }, register with ctx.tool.hook / ctx.permission.hook / ctx.session.hook.
// Verified in a real 2.2.3 codex run: throwing in "execute.before" fails the tool call (rm -rf was blocked).
//
//   tool.hook("execute.before")  e = { tool: "shell"|"read"|"write"|"edit"|"patch"|…, input }  → throw to block
//   permission.hook("evaluate")  e = { action, resources[], effect }                          → effect = "deny"
//   tool.hook("execute.after")   e.result.output.output / e.result.content[].text            → redact
//   session.hook("context")      e.system[].text, e.messages[].content[].text                → redact before any provider

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact, type GateResult } from "../../services/security/gate.ts";
import { evaluateTool } from "../../services/security/tool-gate.ts";

const LOG_DIR = join(process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM"), "runtime", "logs");
function log(entry: Record<string, unknown>) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "security-gate.jsonl"), JSON.stringify({ ts: new Date().toISOString(), engine: "v2", ...entry }) + "\n");
  } catch { /* best effort */ }
}

/** Map 2.x tool ids/inputs onto the 1.x names the shared gate understands. */
export function toGateCall(tool: string, input: any): { tool: string; args: any } {
  const t = tool === "shell" || tool === "execute" ? "bash" : tool;
  const args = { ...(input ?? {}) };
  if (args.path && !args.filePath) args.filePath = args.path;
  if (t === "patch" && !args.patchText) args.patchText = args.patch ?? args.input ?? args.diff ?? "";
  return { tool: t, args };
}

function redactParts(parts: any[] | undefined): number {
  let n = 0;
  for (const p of parts ?? []) {
    if (p && typeof p.text === "string") { const r = redact(p.text); if (r.found.length) { p.text = r.text; n++; } }
  }
  return n;
}

const SecurityGateV2 = {
  id: "openafm.security-gate",
  setup: async (ctx: any) => {
    const root: string = ctx?.location?.directory ?? process.cwd();
    log({ hook: "load", root_set: !!ctx?.location?.directory });

    await ctx.tool.hook("execute.before", (e: any) => {
      let r: GateResult;
      try {
        const g = toGateCall(e.tool, e.input);
        r = evaluateTool(g.tool, g.args, root);
      } catch {
        r = { verdict: "deny", reasons: ["gate_error"] };   // fail closed
      }
      log({ hook: "before", session: e.sessionID, tool: e.tool, verdict: r.verdict, reasons: r.reasons });
      if (r.verdict === "deny") throw new Error(`Blocked by security gate (${r.reasons.join(", ")}). Ask the user to run this themselves if it is really intended.`);
    });

    await ctx.permission.hook("evaluate", (e: any) => {
      try {
        const tool = e.action === "shell" ? "bash" : e.action;
        for (const res of e.resources ?? []) {
          const r = evaluateTool(tool, tool === "bash" ? { command: res } : { filePath: res }, root);
          if (r.verdict === "deny") { e.effect = "deny"; e.message = `Blocked by security gate (${r.reasons.join(", ")})`; log({ hook: "permission", tool, verdict: "deny", reasons: r.reasons }); return; }
        }
      } catch { e.effect = "deny"; }
    });

    await ctx.tool.hook("execute.after", (e: any) => {
      let n = 0;
      const out = e?.result?.output;
      if (out && typeof out.output === "string") { const r = redact(out.output); if (r.found.length) { out.output = r.text; n++; } }
      n += redactParts(e?.result?.content);
      if (n) log({ hook: "after", session: e.sessionID, tool: e.tool, redacted: n });
    });

    await ctx.session.hook("context", (e: any) => {
      redactParts(e?.system);
      for (const m of e?.messages ?? []) redactParts(Array.isArray(m.content) ? m.content : []);
    });
  },
};

export default SecurityGateV2;
