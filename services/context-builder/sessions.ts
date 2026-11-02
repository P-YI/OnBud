// Long-running and interactive processes (dev servers, watchers, REPLs, long tests) in tmux, so a
// command can outlive one chat turn and its output can be read later (Terminal-Bench style).
//   - Own tmux server on a private socket (`tmux -L openafm`), never the user's sessions.
//   - Session names: afm-<project hash>-<slug>, so each project sees only its own sessions.
//   - Starting a session or typing into it needs the user's approval (it runs programs);
//     listing, reading output and stopping our own sessions do not.
//   - Minimal environment (no API keys), output redacted when read, at most 3 sessions per project.
// Watch live from a terminal:  tmux -L openafm attach -t <name>

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { redact } from "../security/gate.ts";

const SOCKET = "openafm";
const MAX_PER_PROJECT = 3;
const ENV = ["PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", `HOME=${homedir()}`, "LANG=en_US.UTF-8", "TERM=xterm-256color", "NO_COLOR=1", "PAGER=cat", "GIT_PAGER=cat"];

export interface SessionInfo { name: string; label: string; created: string; dead: boolean; exitStatus?: number; command: string; cwd: string }

let tmuxPath: string | undefined | null;
async function tmuxBin(): Promise<string | undefined> {
  if (tmuxPath === undefined) {
    for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
      if ((await exec(p, ["-V"])).code === 0) { tmuxPath = p; break; }
    }
    tmuxPath ??= null;
  }
  return tmuxPath ?? undefined;
}

function exec(cmd: string, args: string[], timeoutMs = 5000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: Object.fromEntries(ENV.map((e) => e.split(/=(.*)/s).slice(0, 2))) },
      (err: any, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: String(stdout ?? "") + (err ? String(stderr ?? "") : "") }));
    child.stdin?.end();
  });
}

async function tmux(args: string[], timeoutMs = 5000) {
  const bin = await tmuxBin();
  if (!bin) return { code: -1, out: "tmux_not_installed" };
  return exec(bin, ["-L", SOCKET, "-f", "/dev/null", ...args], timeoutMs);
}

export const hasTmux = async () => !!(await tmuxBin());

/** Commands that do not finish on their own: servers, watchers, REPLs, followers. */
export function isLongRunning(command: string): boolean {
  const c = command.trim();
  return /\b(runserver|uvicorn|gunicorn|flask\s+run|jupyter(\s+(lab|notebook))?|http\.server|streamlit\s+run|gradio|tensorboard|nodemon|vite(\s|$)|next\s+dev|webpack\s+serve|docker\s+compose\s+up|tail\s+-[fF]|watch\s|--watch\b|\bserve\b)\b/.test(c)
    || /\bnpm\s+(run\s+)?(dev|start|serve|watch)\b|\b(pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/.test(c)
    || /^(python3?|ipython|node|irb|psql|sqlite3(\s+\S+)?|R|julia|bash|zsh|sh)$/.test(c);
}

export const sessionPrefix = (projectHash: string) => `afm-${projectHash.slice(0, 6)}-`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "job";

export async function listSessions(projectHash?: string): Promise<SessionInfo[]> {
  const r = await tmux(["list-panes", "-a", "-F", "#{session_name}\t#{session_created}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_start_command}\t#{pane_current_path}"]);
  if (r.code !== 0) return [];
  return r.out.split("\n").filter(Boolean).map((l) => {
    const [name, created, dead, status, command, cwd] = l.split("\t");
    return { name, label: name.replace(/^afm-[0-9a-f]{6}-/, ""), created: new Date(Number(created) * 1000).toISOString().slice(0, 16).replace("T", " "),
      dead: dead === "1", exitStatus: status ? Number(status) : undefined, command: command.replace(/^"|"$/g, ""), cwd };
  }).filter((s) => !projectHash || s.name.startsWith(sessionPrefix(projectHash)));
}

/** Start `command` in a detached session in `root`. The caller must have the user's approval. */
export async function startSession(projectHash: string, root: string, command: string, label?: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (!(await hasTmux())) return { ok: false, error: "tmux_not_installed" };
  const mine = await listSessions(projectHash);
  if (mine.filter((s) => !s.dead).length >= MAX_PER_PROJECT) return { ok: false, error: `too_many_sessions (stop one of: ${mine.map((s) => s.label).join(", ")})` };
  let name = sessionPrefix(projectHash) + slug(label ?? command.split(/\s+/).slice(0, 3).join(" "));
  if (mine.some((s) => s.name === name)) name += "-" + Date.now().toString(36).slice(-4);
  const r = await tmux(["new-session", "-d", "-s", name, "-c", root, "-x", "200", "-y", "50", ...ENV.flatMap((e) => ["-e", e]), "/bin/sh", "-c", command]);
  if (r.code !== 0) return { ok: false, error: r.out.trim() || "tmux_failed" };
  await tmux(["set-option", "-t", name, "remain-on-exit", "on"]);   // keep the output after the process ends
  await tmux(["set-option", "-t", name, "history-limit", "5000"]);
  return { ok: true, name };
}

/** Last `lines` lines of a session's output, redacted. */
export async function readSession(name: string, lines = 40): Promise<string> {
  // The pane is 50 rows tall: short output sits at the top with blank rows below it, so capture the
  // whole history and drop blank runs before taking the tail.
  const r = await tmux(["capture-pane", "-p", "-J", "-S", "-", "-E", "-", "-t", name]);
  if (r.code !== 0) return `no such session: ${name}`;
  const text = r.out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return redact(text).text.split("\n").slice(-Math.min(lines, 500)).join("\n");
}

/** Type a line into a session (REPL input, answering a prompt). The caller must have the user's approval. */
export async function sendToSession(name: string, text: string, enter = true): Promise<boolean> {
  const r = await tmux(["send-keys", "-t", name, "-l", text]);
  if (r.code !== 0) return false;
  if (enter) await tmux(["send-keys", "-t", name, "Enter"]);
  return true;
}

export async function stopSession(name: string): Promise<boolean> {
  if (!/^afm-[0-9a-f]{6}-/.test(name)) return false;   // never touch sessions we did not create
  return (await tmux(["kill-session", "-t", name])).code === 0;
}

/** Wait until the output settles or the process exits (for a first look right after starting). */
export async function settle(name: string, maxMs = 4000): Promise<string> {
  let last = "";
  for (let t = 0; t < maxMs; t += 500) {
    await new Promise((r) => setTimeout(r, 500));
    const out = await readSession(name, 40);
    const dead = (await listSessions()).find((s) => s.name === name)?.dead;
    if (dead || (out && out === last && t >= 1000)) return out;
    last = out;
  }
  return last;
}

export function renderSessions(list: SessionInfo[], ko: boolean): string {
  if (!list.length) return ko ? "실행 중인 세션이 없어요." : "No sessions.";
  return list.map((s) => `- \`${s.label}\` — ${s.dead ? (ko ? `종료됨 (exit ${s.exitStatus ?? "?"})` : `exited (${s.exitStatus ?? "?"})`) : (ko ? "실행 중" : "running")} · \`${s.command.slice(0, 80)}\` · ${s.created}`).join("\n");
}
