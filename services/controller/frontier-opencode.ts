// FrontierProvider that hands the task to OpenCode's `codex` agent (GPT-6.1 Sol, ChatGPT subscription).
// OpenCode keeps its own permission prompts and the security-gate plugin for every tool the agent runs.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FrontierProvider } from "./controller.ts";

// The 1.x CLI, because its security-gate plugin (redaction, command gate) loads; the v2 app's does not.
const V1_CLI = join(homedir(), ".opencode", "bin", "opencode");

export class OpenCodeFrontier implements FrontierProvider {
  readonly name: string;
  private agent: string;
  private timeoutMs: number;
  private bin: string;

  constructor(opts: { agent?: string; timeoutMs?: number; bin?: string } = {}) {
    this.bin = opts.bin ?? (existsSync(V1_CLI) ? V1_CLI : "opencode");
    this.agent = opts.agent ?? "codex";
    this.name = `opencode:${this.agent}`;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  run(prompt: string, root: string): Promise<{ ok: boolean; text: string; detail?: string; agent?: string; tokens?: { input: number; output: number; reasoning: number; cacheRead: number } }> {
    // codex-handoff → codex-solve when the request needs nothing from the project (2026-10-31: 2–2.4× cheaper per
    // call at the same accuracy; codex-handoff's read-only tools and long prompt are most of its cost).
    const agent = this.agent === "codex-handoff" && selfContained(prompt) ? "codex-solve" : this.agent;
    return new Promise((res) => {
      const child = execFile(this.bin, ["run", "--agent", agent, "--format", "json", prompt],
        { cwd: root, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err: any, stdout) => {
          const texts: string[] = [];
          let tokens: { input: number; output: number; reasoning: number; cacheRead: number } | undefined;
          for (const line of String(stdout ?? "").split("\n")) {
            try {
              const e = JSON.parse(line);
              if (e?.part?.type === "text" && e.part.text) texts.push(e.part.text);
              const t = e?.part?.type === "step-finish" ? e.part.tokens : undefined;   // usage per model step, summed
              if (t) tokens = { input: (tokens?.input ?? 0) + (t.input ?? 0), output: (tokens?.output ?? 0) + (t.output ?? 0), reasoning: (tokens?.reasoning ?? 0) + (t.reasoning ?? 0), cacheRead: (tokens?.cacheRead ?? 0) + (t.cache?.read ?? 0) };
            } catch { /* non-JSON log line */ }
          }
          if (err && !texts.length) res({ ok: false, text: "", agent, detail: err.killed ? "timeout" : `exit_${err.code}` });
          else res({ ok: true, text: texts.join("\n").trim(), agent, tokens });
        });
      // `opencode run` reads a non-TTY stdin as extra message input and stalls at init until it closes.
      child.stdin?.end();
    });
  }
}

/** A hand-off that needs nothing from the project: the user's request (before the local pre-analysis) names no
 *  file, folder, repository or git state, and the pre-analysis carries no evidence read from files. Anything else keeps the read-only tools. */
export function selfContained(handoff: string): boolean {
  const [request, analysis = ""] = handoff.split(/\n\n---\n/);
  if (/\.(py|ts|tsx|js|jsx|mjs|go|rs|java|kt|rb|swift|c|cc|cpp|h|hpp|sh|md|tex|bib|json|ya?ml|toml|csv|txt|pdf|docx?)\b|[\w.-]+\/[\w.-]+/i.test(request)) return false;
  if (/(프로젝트|저장소|레포|코드베이스|폴더|디렉터리|디렉토리|이 (파일|코드|함수|클래스|모듈)|브랜치|커밋|변경 ?사항|project|repo(sitory)?|codebase|folder|director(y|ies)|this (file|code|function|class|module)|branch|commit|diff|git\b)/i.test(request)) return false;
  // Evidence blocks are "[label]": git status (added to every project hand-off) and the conversation do not count.
  return [...analysis.matchAll(/^\[([^\]\n]+)\]$/gm)].every((m) => /^(git status|conversation so far)$/i.test(m[1].trim()));
}

// Is a frontier model reachable right now? (network + ChatGPT endpoint). Cached for 30 s.
// OPENAFM_FRONTIER=off forces "offline" (benchmark settings, or working on a plane).
let reach = { at: 0, ok: false };
export async function frontierReachable(): Promise<boolean> {
  if (process.env.OPENAFM_FRONTIER === "off") return false;
  if (Date.now() - reach.at < 30_000) return reach.ok;
  let ok = false;
  try { const r = await fetch("https://chatgpt.com/", { method: "HEAD", signal: AbortSignal.timeout(2500) }); ok = r.status > 0; } catch { ok = false; }
  reach = { at: Date.now(), ok };
  return ok;
}
