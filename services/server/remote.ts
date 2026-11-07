// Server skill core (2026-11-08): OnBud works on a remote machine (a GPU server, a Slurm cluster) through the
// user's own SSH, and a terminal IDE on the Mac shows that machine. OnBud, AFM, Copilot and Codex keep running
// on the Mac, so the code skill's ladder (Copilot → cheap tier → strong tier) still decides who writes the code;
// only files, commands and logs cross to the server.
//
//   Mac: OnBud (plan · write code · approve · read results)
//     │  ssh / tar over ssh (the system ssh: the user's ~/.ssh/config, agent and keys, read by ssh only)
//     ▼
//   server: <dir>/.onbud/jobs/<id>.{sh,log,exit,pid}   STATUS.md   (tmux session onbud-<id>, or nohup, or Slurm)
//     ▲
//   Mac terminal (Ghostty, iTerm, Terminal): `fresh ssh://host/dir` (files, terminal and LSP run on the server),
//   `ssh -t host 'cd dir && ttt'`, a shell, `tmux attach` to the job, or `tail -F` of its log.
//
// Privacy and safety:
//   - OnBud never opens key files, ~/.ssh contents or passwords. Host names come from ~/OnBud/config/servers.json
//     and from the `Host` lines of ~/.ssh/config (names only; every other line is dropped unread into nothing).
//     BatchMode=yes: a host that needs a password or a new host key is connected once by the user in a terminal.
//   - The upload list is built here: git's tracked + untracked-not-ignored files (or a walk), minus secrets
//     (.env, keys, certificates, credentials) and big files; the user sees the count and size before approving.
//   - A command to run remotely passes the same security gate as a local one (deny → refused).
//   - Nothing is deleted remotely; uploads only add or overwrite files under the chosen folder.
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { gateCommand } from "../security/gate.ts";

const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const RUNTIME = join(HOME, "runtime", "server");
const SSH = () => process.env.ONBUD_SSH ?? "/usr/bin/ssh";

export interface ServerEntry { name: string; host: string; dir?: string; viewer?: Viewer; source: "config" | "ssh_config" }
export type Viewer = "fresh" | "ttt" | "shell";
export type JobKind = "tmux" | "nohup" | "slurm";
export interface Job { id: string; host: string; dir: string; command: string; kind: JobKind; slurmId?: string; log: string; started: string }
export interface Status { state: string; exitCode?: number; tail: string }

// ---------------------------------------------------------------- hosts
export const validHost = (h: string) => /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(h);
/** A remote folder: absolute, ~-relative or home-relative; no "..", no shell characters. */
export const validRemoteDir = (d: string) => /^(~|~\/[\w.\/@+-]*|\/[\w.\/@+-]*|[\w.][\w.\/@+-]*)$/.test(d) && !d.split("/").includes("..");

/** Hosts the user can name: ~/OnBud/config/servers.json {"servers": {"gpu": {"host": "gpu1", "dir": "~/proj", "viewer": "fresh"}}}
 *  first, then ~/.ssh/config `Host` aliases without wildcards. */
export function knownServers(home = homedir()): ServerEntry[] {
  const out: ServerEntry[] = [];
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.ONBUD_HOME ?? join(home, "OnBud"), "config", "servers.json"), "utf8"))?.servers ?? {};
    for (const [name, v] of Object.entries<any>(cfg)) {
      const host = typeof v === "string" ? v : v?.host;
      if (typeof host !== "string" || !validHost(host)) continue;
      out.push({ name, host, dir: typeof v?.dir === "string" && validRemoteDir(v.dir) ? v.dir : undefined, viewer: ["fresh", "ttt", "shell"].includes(v?.viewer) ? v.viewer : undefined, source: "config" });
    }
  } catch { /* no config */ }
  try {
    for (const line of readFileSync(join(home, ".ssh", "config"), "utf8").split("\n")) {
      const m = /^\s*Host\s+(.+)$/i.exec(line);
      if (!m) continue;
      for (const h of m[1].trim().split(/\s+/)) if (validHost(h) && !/[*?!]/.test(h) && !out.some((s) => s.name === h)) out.push({ name: h, host: h, source: "ssh_config" });
    }
  } catch { /* no ssh config */ }
  return out;
}

/** The known server a request names (longest name first, whole words). */
export function serverIn(text: string, servers = knownServers()): ServerEntry | undefined {
  const t = text.toLowerCase();
  return [...servers].sort((a, b) => b.name.length - a.name.length)
    .find((s) => new RegExp(`(^|[^a-z0-9_.-])${s.name.toLowerCase().replace(/[.]/g, "\\.")}([^a-z0-9_-]|$)`).test(t));
}

// ---------------------------------------------------------------- ssh
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A remote folder as a shell word ("~/x" → "$HOME"/'x'). */
export const rdir = (d: string) => (d === "~" ? `"$HOME"` : d.startsWith("~/") ? `"$HOME"/${q(d.slice(2))}` : q(d));

let agentSock: string | undefined;
function sshEnv(): NodeJS.ProcessEnv {
  // A controller started by launchd or with a minimal env has no SSH_AUTH_SOCK: ask launchd for the user's agent socket
  // (the macOS ssh-agent, which holds keys unlocked from the keychain). Only the socket path is read, never a key.
  if (!process.env.SSH_AUTH_SOCK && agentSock === undefined && process.platform === "darwin") {
    try { agentSock = execFileSync("/bin/launchctl", ["getenv", "SSH_AUTH_SOCK"], { timeout: 2000, encoding: "utf8" }).trim(); } catch { agentSock = ""; }
  }
  return { ...process.env, ...(agentSock ? { SSH_AUTH_SOCK: agentSock } : {}), LC_ALL: "C" };
}

/** ssh options: no prompts OnBud would have to answer, short connect timeout, one shared connection per host. */
export function sshOptions(): string[] {
  mkdirSync(join(RUNTIME, "ssh"), { recursive: true, mode: 0o700 });
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(RUNTIME, "ssh", "%C")}`, "-o", "ControlPersist=600"];
}

export interface Exec { code: number; out: string; err: string }
/** Runs `script` with bash on the host (sent on stdin, so nothing needs quoting twice). */
export function remote(host: string, script: string, timeoutMs = 60_000, input?: Buffer): Promise<Exec> {
  if (!validHost(host)) return Promise.resolve({ code: 2, out: "", err: `invalid host: ${host}` });
  return new Promise((res) => {
    const args = [...sshOptions(), "--", host, input ? script : "bash -s"];
    const child = execFile(SSH(), args, { env: sshEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" } as any,
      (e: any, out: any, err: any) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out ?? ""), err: String(err ?? "") }));
    child.stdin?.end(input ?? script);
  });
}

/** One line for a failed ssh call: 255 is ssh itself (unreachable, refused, needs a password or a host key). */
export function sshProblem(host: string, r: Exec, ko = false): string {
  if (r.code === 255) {
    const why = r.err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? "";
    return ko ? `**${host}**에 접속하지 못했어요 (${why || "ssh 오류"}). 터미널에서 \`ssh ${host}\`로 한 번 직접 접속해 두세요 — 비밀번호, 키 암호, 새 호스트 키 확인은 OnBud이 대신 입력하지 않아요.`
      : `Could not connect to **${host}** (${why || "ssh error"}). Connect once yourself in a terminal (\`ssh ${host}\`): OnBud never types passwords, key passphrases or host-key confirmations.`;
  }
  return (r.err || r.out).trim().split("\n").slice(-5).join("\n");
}

// ---------------------------------------------------------------- what the server has
export interface Capabilities { os: string; home: string; tools: Record<string, boolean>; gpus: string[] }
const TOOLS = ["python3", "git", "docker", "sbatch", "squeue", "nvidia-smi", "tmux", "fresh", "ttt", "rsync"];
export async function check(host: string): Promise<{ ok: true; caps: Capabilities } | { ok: false; error: Exec }> {
  const r = await remote(host, `echo "OS $(uname -sm)"; echo "HOME $HOME"; for t in ${TOOLS.join(" ")}; do command -v $t >/dev/null 2>&1 && echo "HAS $t"; done
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null | sed 's/^/GPU /'; true`, 20_000);
  if (r.code !== 0) return { ok: false, error: r };
  const lines = r.out.split("\n");
  const has = new Set(lines.filter((l) => l.startsWith("HAS ")).map((l) => l.slice(4).trim()));
  return { ok: true, caps: { os: lines.find((l) => l.startsWith("OS "))?.slice(3).trim() ?? "", home: lines.find((l) => l.startsWith("HOME "))?.slice(5).trim() ?? "",
    tools: Object.fromEntries(TOOLS.map((t) => [t, has.has(t)])), gpus: lines.filter((l) => l.startsWith("GPU ")).map((l) => l.slice(4).trim()) } };
}

// ---------------------------------------------------------------- upload
// Never uploaded: secrets and things that are rebuilt on the server.
const SECRET = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|credentials(\.\w+)?|secrets?\.(json|ya?ml|toml)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)|\.ssh\/.*|\.aws\/.*|\.gnupg\/.*|\.kube\/.*)$/i;
const SKIP_DIR = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|\.mypy_cache|\.pytest_cache|\.DS_Store|\.onbud|\.build|build|dist|\.next|target|wandb|\.ipynb_checkpoints)(\/|$)/;
export const MAX_FILE = 50 * 1024 * 1024;

export interface UploadPlan { root: string; files: string[]; bytes: number; secrets: string[]; large: string[] }

/** Refuses folders that should never be uploaded whole (home, /, the system, credential folders). */
export function uploadableRoot(dir: string): string | undefined {
  const d = resolve(dir), h = homedir();
  if (d === "/" || d === h || !d.startsWith(h + "/") && !d.startsWith("/tmp/") && !d.startsWith("/private/") && !d.startsWith("/var/folders/") && !d.startsWith("/Volumes/")) return undefined;
  if (/(^|\/)(\.ssh|\.aws|\.gnupg|Library|\.config)(\/|$)/.test(relative(h, d))) return undefined;
  return d;
}

export async function planUpload(dir: string): Promise<UploadPlan | undefined> {
  const root = uploadableRoot(dir);
  if (!root || !existsSync(root)) return undefined;
  let rels: string[] | undefined;
  if (existsSync(join(root, ".git"))) {
    const r = await new Promise<string | undefined>((res) => execFile("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], { maxBuffer: 64 * 1024 * 1024 }, (e, o) => res(e ? undefined : String(o))));
    rels = r?.split("\0").filter(Boolean);
  }
  if (!rels) {
    rels = [];
    const walk = (d: string) => {
      if (rels!.length > 20_000) return;
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (SKIP_DIR.test(rel)) continue;
        if (e.isDirectory()) walk(rel); else if (e.isFile()) rels!.push(rel);
      }
    };
    walk("");
  }
  const plan: UploadPlan = { root, files: [], bytes: 0, secrets: [], large: [] };
  for (const rel of rels) {
    if (SKIP_DIR.test(rel)) continue;
    if (SECRET.test(rel)) { plan.secrets.push(rel); continue; }
    let size = 0; try { const s = statSync(join(root, rel)); if (!s.isFile()) continue; size = s.size; } catch { continue; }
    if (size > MAX_FILE) { plan.large.push(rel); continue; }
    plan.files.push(rel); plan.bytes += size;
  }
  return plan;
}

/** tar of the planned files, piped into `tar -x` in the remote folder (created if missing). Works with any server
 *  that has tar; nothing remote is deleted. */
export async function push(host: string, plan: UploadPlan, dir: string): Promise<Exec> {
  if (!validRemoteDir(dir) || dir === "~" || dir === "/") return { code: 2, out: "", err: `refused remote folder: ${dir}` };
  if (!plan.files.length) return { code: 2, out: "", err: "nothing to upload" };
  const tar = await new Promise<Buffer>((res, rej) => {
    const c = spawn("/usr/bin/tar", ["-czf", "-", "--no-xattrs", "-C", plan.root, "-T", "-"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const chunks: Buffer[] = [];
    c.stdout.on("data", (b) => chunks.push(b));
    c.on("error", rej);
    c.on("close", (code) => (code === 0 ? res(Buffer.concat(chunks)) : rej(new Error(`tar exit ${code}`))));
    c.stdin.end(plan.files.join("\n") + "\n");
  });
  return remote(host, `mkdir -p ${rdir(dir)} && tar -xzf - -C ${rdir(dir)} 2>/dev/null && echo OK $(cd ${rdir(dir)} && pwd)`, 10 * 60_000, tar);
}

// ---------------------------------------------------------------- jobs
const JOBS = () => join(RUNTIME, "jobs.json");
export function listJobs(): Job[] { try { return JSON.parse(readFileSync(JOBS(), "utf8")); } catch { return []; } }
function saveJob(j: Job) {
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  const all = [...listJobs().filter((x) => x.id !== j.id), j].slice(-100);
  writeFileSync(JOBS(), JSON.stringify(all, null, 1), { mode: 0o600 });
}
export const findJob = (id?: string, host?: string) => {
  const all = listJobs().filter((j) => !host || j.host === host);
  return id ? all.find((j) => j.id === id) : all[all.length - 1];
};
export const isSlurm = (cmd: string) => /^\s*sbatch\b/.test(cmd);

/** Starts `command` in the remote folder in the background and records the job. A tmux session (onbud-<id>) when
 *  the server has tmux, so the user can attach and take over; else nohup; `sbatch …` is submitted to Slurm.
 *  The command passes the local security gate first. */
export async function run(host: string, dir: string, command: string): Promise<{ ok: true; job: Job } | { ok: false; error: string }> {
  if (!validRemoteDir(dir)) return { ok: false, error: `refused remote folder: ${dir}` };
  const g = gateCommand(command, "/");
  if (g.verdict === "deny") return { ok: false, error: `the security gate blocks this command (${g.reasons.join(", ")})` };
  if (/ONBUD_EOF/.test(command) || /[\0\r]/.test(command)) return { ok: false, error: "refused command text" };
  const id = "j" + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4);
  const J = `.onbud/jobs/${id}`;
  const script = `set -e
mkdir -p ${rdir(dir)}/.onbud/jobs && cd ${rdir(dir)}
cat > ${J}.sh <<'ONBUD_EOF'
#!/usr/bin/env bash
# OnBud job ${id}: started from the Mac; this file, the log and the exit code live next to it.
cd "$(dirname "$0")/../.."
export PYTHONUNBUFFERED=1   # live log lines from Python
{ ${command}
} 2>&1 | tee -a ${J}.log
echo "\${PIPESTATUS[0]}" > ${J}.exit
ONBUD_EOF
chmod 700 ${J}.sh; : > ${J}.log
printf '| %s | %s | \`%s\` |\\n' "${id}" "$(date '+%Y-%m-%d %H:%M')" ${q(command.replace(/\|/g, "\\|").slice(0, 200))} >> .onbud/jobs.md
${isSlurm(command)
    ? `out=$(bash -lc ${q(command)} 2>&1) || { echo "$out"; exit 3; }; echo "$out" >> ${J}.log
n=$(printf '%s' "$out" | sed -n 's/.*Submitted batch job \\([0-9][0-9]*\\).*/\\1/p' | head -1)
lg=$(scontrol show job "$n" 2>/dev/null | sed -n 's/.*StdOut=\\([^ ]*\\).*/\\1/p' | head -1)
echo "KIND slurm $n"; echo "LOG \${lg:-slurm-$n.out}"`
    : `if command -v tmux >/dev/null 2>&1; then tmux new-session -d -s onbud-${id} -c "$(pwd)" "bash -l $(pwd)/${J}.sh"; echo "KIND tmux"
else nohup bash -l ${J}.sh >/dev/null 2>&1 </dev/null & echo $! > ${J}.pid; echo "KIND nohup"; fi
echo "LOG ${J}.log"`}
echo "DIR $(pwd)"`;
  const r = await remote(host, script, 60_000);
  const get = (k: string) => r.out.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1).trim();
  const kind = get("KIND")?.split(" ") ?? [];
  if (r.code !== 0 || !kind[0]) return { ok: false, error: sshProblem(host, r) || `exit ${r.code}` };
  const job: Job = { id, host, dir: get("DIR") ?? dir, command, kind: kind[0] as JobKind, slurmId: kind[1], log: get("LOG") ?? `${J}.log`, started: new Date().toISOString() };
  saveJob(job);
  await writeStatusFile(job, { state: "started", tail: "" });
  return { ok: true, job };
}

const logPath = (j: Job) => (j.log.startsWith("/") ? q(j.log) : `${q(j.dir)}/${q(j.log)}`);

/** State and the last lines of the log. States: running, done (exitCode), lost (no process and no exit code),
 *  Slurm's own (PENDING, RUNNING, COMPLETED, FAILED, …), missing (the folder is gone). */
export async function status(job: Job, lines = 40): Promise<{ ok: true; status: Status } | { ok: false; error: string }> {
  const J = `.onbud/jobs/${job.id}`;
  const state = job.kind === "slurm"
    ? `s=$(squeue -h -j ${Number(job.slurmId) || 0} -o %T 2>/dev/null); [ -z "$s" ] && s=$(sacct -j ${Number(job.slurmId) || 0} -n -X -o State 2>/dev/null | head -1 | tr -d ' '); echo "STATE \${s:-unknown}"`
    : `if [ -f ${J}.exit ]; then echo "STATE done $(cat ${J}.exit)"; elif ${job.kind === "tmux" ? `tmux has-session -t onbud-${job.id} 2>/dev/null` : `[ -f ${J}.pid ] && kill -0 "$(cat ${J}.pid)" 2>/dev/null`}; then echo "STATE running"; else echo "STATE lost"; fi`;
  const r = await remote(job.host, `cd ${q(job.dir)} 2>/dev/null || { echo "STATE missing"; exit 0; }\n${state}\necho ---TAIL---\ntail -n ${Math.max(1, Math.min(lines, 400))} ${logPath(job)} 2>/dev/null; true`, 20_000);
  if (r.code !== 0) return { ok: false, error: sshProblem(job.host, r) };
  const [head, tail = ""] = r.out.split("---TAIL---\n");
  const st = /STATE (\S+)(?: (\d+))?/.exec(head);
  const s: Status = { state: st?.[1] ?? "unknown", exitCode: st?.[2] !== undefined ? Number(st[2]) : undefined, tail: tail.trimEnd() };
  await writeStatusFile(job, s);
  return { ok: true, status: s };
}

/** .onbud/STATUS.md in the remote folder: what OnBud is running there, so a terminal IDE's file tree shows it. */
async function writeStatusFile(job: Job, s: Status) {
  const body = `# OnBud on this server\n\nLatest job: \`${job.id}\` — ${s.state}${s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ""}, checked ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n\n`
    + `- command: \`${job.command}\`\n- runs as: ${job.kind}${job.slurmId ? ` ${job.slurmId}` : ""}${job.kind === "tmux" ? ` (attach: \`tmux attach -t onbud-${job.id}\`)` : ""}\n- log: \`${job.log}\`\n\nAll jobs started here: [jobs.md](jobs.md)\n`;
  await remote(job.host, `cd ${q(job.dir)} 2>/dev/null && mkdir -p .onbud && cat > .onbud/STATUS.md`, 15_000, Buffer.from(body));
}

export async function stop(job: Job): Promise<Exec> {
  const J = `.onbud/jobs/${job.id}`;
  const cmd = job.kind === "slurm" ? `scancel ${Number(job.slurmId) || 0}` : job.kind === "tmux" ? `tmux kill-session -t onbud-${job.id}` : `kill "$(cat ${J}.pid)"`;
  return remote(job.host, `cd ${q(job.dir)} && ${cmd} && echo stopped`, 20_000);
}

/** Copies a remote file or folder (relative to the job's folder, or absolute) into `dest` on the Mac; refused above
 *  `maxMB`. Default destination: ~/OnBud/runtime/server/<host>/<job>/ (private, outside any project). */
export async function pull(host: string, base: string, path: string, dest: string, maxMB = 1024): Promise<Exec> {
  if (!validRemoteDir(path) || !validRemoteDir(base)) return { code: 2, out: "", err: `refused path: ${path}` };
  const src = isAbsolute(path) ? q(path) : `${q(base)}/${q(path)}`;
  const size = await remote(host, `du -sk ${src} 2>/dev/null | cut -f1`, 20_000);
  const kb = Number(size.out.trim());
  if (size.code !== 0 || !Number.isFinite(kb) || !size.out.trim()) return { code: 2, out: "", err: size.code === 255 ? sshProblem(host, size) : `not found on ${host}: ${path}` };
  if (kb > maxMB * 1024) return { code: 2, out: "", err: `${Math.round(kb / 1024)} MB is over the ${maxMB} MB limit` };
  mkdirSync(dest, { recursive: true });
  return new Promise((res) => {
    const ssh = spawn(SSH(), [...sshOptions(), "--", host, `cd "$(dirname ${src})" && tar -czf - "$(basename ${src})"`], { env: sshEnv() });
    const tar = spawn("/usr/bin/tar", ["-xzf", "-", "-C", dest]);
    let err = "";
    ssh.stdout.pipe(tar.stdin);
    ssh.stderr.on("data", (b) => (err += b));
    tar.on("close", (code) => res({ code: code ?? 1, out: code === 0 ? `OK ${join(dest, basename(path))}` : "", err }));
  });
}
export const defaultPullDir = (host: string, id: string) => join(RUNTIME, host.replace(/[^\w.-]/g, "_"), id);

// ---------------------------------------------------------------- terminal IDE views
/** The terminal command that shows the server: Fresh on the Mac (`fresh ssh://host/abs-dir`, its file tree,
 *  terminal and LSP run on the server; Fresh needs Python 3 there), TTT on the server, a shell, the job's tmux
 *  session, or its log. `absDir` must be absolute for Fresh (resolve "~" with check() first). */
export function viewCommand(o: { host: string; absDir: string; viewer: Viewer | "attach" | "log"; job?: Job }): string {
  const ssh = `ssh -t ${o.host}`;
  switch (o.viewer) {
    case "fresh": return `fresh ${q(`ssh://${o.host}${o.absDir.startsWith("/") ? "" : "/"}${o.absDir}`)}`;
    case "ttt": return `${ssh} ${q(`cd ${q(o.absDir)} && ttt`)}`;
    case "attach": return o.job?.kind === "tmux" ? `${ssh} ${q(`tmux attach -t onbud-${o.job.id}`)}` : viewCommand({ ...o, viewer: "log" });
    case "log": return o.job ? `${ssh} ${q(`tail -n 200 -F ${logPath(o.job)}`)}` : viewCommand({ ...o, viewer: "shell" });
    default: return `${ssh} ${q(`cd ${q(o.absDir)} && exec $SHELL -l`)}`;
  }
}

/** Is a terminal IDE available on the Mac (Fresh) or on the server (TTT)? */
export const freshOnMac = () => ["/opt/homebrew/bin/fresh", "/usr/local/bin/fresh", join(homedir(), ".cargo", "bin", "fresh"), join(homedir(), ".local", "bin", "fresh")].find((p) => existsSync(p));
