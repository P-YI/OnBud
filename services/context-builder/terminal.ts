// Terminal access for AFM (the core Terminal-Bench capability), deliberately narrow:
//   auto-run   only when the security gate says "allow" AND every segment is a known read-only command
//   approval   everything else that is not denied (running programs, tests, writes, installs, network)
//   blocked    gate "deny"
// Execution: /bin/sh -c in the project root, stdin closed, minimal env (no secrets), timeout,
// output capped and redacted, exit code reported. Long-running/interactive programs are not supported.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { argv, gateCommand, redact, splitSegments } from "../security/gate.ts";

export type CommandClass = { mode: "auto" | "approval" | "blocked"; reasons: string[] };

const READ_ONLY = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "egrep", "fgrep", "find", "stat", "file", "du", "df",
  "which", "echo", "printf", "sort", "uniq", "tree", "date", "uname", "cut", "tr", "jq", "basename", "dirname", "realpath", "sw_vers",
  "mdls", "mdfind", "nl", "column", "comm", "diff", "cmp", "md5", "shasum", "true", "test", "["]);
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "remote", "tag", "describe", "shortlog", "grep"]);
const VERSION_ONLY = /^(python3?|node|npm|pip3?|ruby|go|java|swift|cargo|rustc|bun|deno|uv)$/;

export function classifyCommand(command: string, root: string): CommandClass {
  const g = gateCommand(command, root);
  if (g.verdict === "deny") return { mode: "blocked", reasons: g.reasons };
  if (/(^|[^<>&0-9])>>?|\btee\b/.test(command)) return { mode: "approval", reasons: [...g.reasons, "writes_output"] };
  for (const seg of splitSegments(command).segments) {
    const a = argv(seg).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    const head = (a[0] ?? "").split("/").pop()!;
    if (head === "git") {
      const sub = a.slice(1).find((x) => !x.startsWith("-")) ?? "";
      if (!GIT_READ.has(sub) || (sub === "branch" && a.some((x) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)/.test(x)))) return { mode: "approval", reasons: [...g.reasons, `git_${sub || "?"}`] };
      continue;
    }
    if (VERSION_ONLY.test(head) && a.length === 2 && /^(--version|-V|version)$/.test(a[1])) continue;
    if (!READ_ONLY.has(head)) return { mode: "approval", reasons: [...g.reasons, `runs_${head || "?"}`] };
  }
  return g.verdict === "ask" ? { mode: "approval", reasons: g.reasons } : { mode: "auto", reasons: [] };
}

export interface CommandResult { exitCode: number | null; output: string; truncated: boolean; timedOut: boolean; ms: number }

export function execCommand(command: string, root: string, opts: { timeoutMs?: number; maxChars?: number } = {}): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxChars = opts.maxChars ?? 6000;
  const t0 = Date.now();
  return new Promise((res) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
    });
    let out = "";
    let truncated = false;
    const take = (b: Buffer) => { if (out.length < maxChars) out += b.toString("utf8"); else truncated = true; };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (out.length > maxChars) { out = out.slice(0, maxChars); truncated = true; }
      res({ exitCode: code, output: redact(out).text, truncated, timedOut, ms: Date.now() - t0 });
    });
  });
}

export function renderResult(command: string, r: CommandResult): string {
  return `$ ${command}\n${r.output.trimEnd() || "(no output)"}${r.truncated ? "\n… (output truncated)" : ""}\n[exit ${r.timedOut ? "timeout" : r.exitCode}]`;
}
