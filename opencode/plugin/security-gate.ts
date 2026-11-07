// OpenCode plugin: enforces services/security at the tool boundary.
// - tool.execute.before : deny-class commands / paths throw (tool never runs). Fails closed.
// - permission.ask      : a gate "deny" also overrides any OpenCode "allow" rule.
// - tool.execute.after  : redacts secrets from tool output before the model sees it.
// - shell.env           : strips secret-looking variables from the shell the agent spawns.
// - experimental.chat.messages.transform : redacts secrets from history sent to any provider.
// "ask"-class verdicts are left to OpenCode's own permission prompt (see opencode.json "permission").
// Only the plugin itself is exported: OpenCode treats every exported function as a plugin.

import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact, isSecretEnvName, type GateResult } from "../../services/security/gate.ts";
import { evaluateTool } from "../../services/security/tool-gate.ts";

const LOG_DIR = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "logs");
const LOG = join(LOG_DIR, "security-gate.jsonl");

// Metadata only: never the raw command, path or output.
function log(entry: Record<string, unknown>) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* logging must never unblock or crash a tool call */ }
}

export const SecurityGate: Plugin = async ({ worktree, directory }) => {
  const root = worktree || directory;
  log({ hook: "load", root_set: !!root });

  return {
    "tool.execute.before": async (input, output) => {
      let r: GateResult;
      try {
        r = evaluateTool(input.tool, output.args, root);
      } catch {
        r = { verdict: "deny", reasons: ["gate_error"] };   // fail closed
      }
      log({ hook: "before", session: input.sessionID, tool: input.tool, verdict: r.verdict, reasons: r.reasons });
      if (r.verdict === "deny") {
        throw new Error(`Blocked by security gate (${r.reasons.join(", ")}). Ask the user to run this themselves if it is really intended.`);
      }
    },

    "permission.ask": async (input: any, output) => {
      try {
        const tool = String(input?.type ?? input?.permission ?? "");
        const r = evaluateTool(tool, input?.metadata ?? {}, root);
        if (r.verdict === "deny") {
          output.status = "deny";
          log({ hook: "permission", tool, verdict: "deny", reasons: r.reasons });
        }
      } catch {
        output.status = "deny";
      }
    },

    "tool.execute.after": async (input, output) => {
      if (typeof output.output !== "string") return;
      const { text, found } = redact(output.output);
      if (found.length) {
        output.output = text;
        log({ hook: "after", session: input.sessionID, tool: input.tool, redacted: found });
      }
    },

    "shell.env": async (_input, output) => {
      for (const k of Object.keys(output.env)) if (isSecretEnvName(k)) delete output.env[k];
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      for (const m of output.messages ?? []) {
        for (const part of (m.parts ?? []) as any[]) {
          if (part?.type === "text" && typeof part.text === "string") part.text = redact(part.text).text;
          if (part?.type === "tool" && typeof part.state?.output === "string") part.state.output = redact(part.state.output).text;
        }
      }
    },
  };
};
