// The Server skill (skills/server): requests about a remote machine, answered from the Mac.
//   "gpu1에서 train.py 돌려줘"            → upload plan + command, run only on the user's yes (pendingCommand:
//                                          bin/afm-server.ts run …, which the security gate checks again)
//   (after the yes)                       → the job, how to watch it; opens the terminal IDE if the request asked
//   "gpu1 학습 어디까지 됐어?" / "로그"     → the latest job's state and log tail (read-only, no approval)
//   "gpu1 서버 fresh로 열어줘" / "ttt" / "터미널" / "붙어줘"  → a terminal window: Fresh, TTT, a shell, the job's tmux
//   "gpu1 서버 상태" (no job yet)          → what the server has: GPUs, Slurm, tmux, python3, fresh/ttt
// Code is still written on the Mac by the code skill (Copilot → cheap tier → strong tier); this skill only moves
// files, starts commands and reads logs, so a server-side IDE without OpenCode no longer loses that ladder.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { chooseApp, openTerminal, appName } from "../context-builder/apps.ts";
import { check, findJob, freshOnMac, knownServers, planUpload, serverIn, status, viewCommand, type Job, type ServerEntry, type Viewer } from "./remote.ts";

export interface ServerContext { root: string; prompt: string; files: { path: string }[]; ko: boolean; history?: string }
export interface ServerResult { answer: string; verified: boolean; pendingCommand?: string; detail: string; declined?: boolean }

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// A remote machine, not a local dev server ("로컬 서버 띄워", "npm run dev 서버").
const SERVER_WORD = /(서버|\bservers?\b|클러스터|\bcluster\b|\bslurm\b|\bsbatch\b|\bsqueue\b|원격\s?(머신|호스트|컴퓨터)|remote (machine|host|box)|\bgpu\s?(node|노드|box|머신)?\b)/i;
const REMOTE_HINT = /(\bgpu\b|원격|remote|\bssh\b|slurm|sbatch|squeue|클러스터|cluster|학습|훈련|\btrain(ing)?\b|실험|experiment|fresh|\bttt\b|nvidia-smi|\bnode\b|노드)/i;
const LOCAL_SERVER = /(로컬|local|개발|dev|웹|web|api|mcp|프록시|proxy|컨트롤러|controller|localhost|127\.0\.0\.1|포트|\bport\b|npm|vite|next|flask|django|uvicorn|express)\s?(서버|server)/i;
const RUN = /(실행|돌려|돌리|run\b|\btrain\b|학습\s?(시켜|시작|돌려)|훈련|submit|제출|\bsbatch\b|launch|띄워서|시작해)/i;
const STATUS = /(상태|상황|진행|어디까지|끝났|됐어|완료|어때|how('s| is| are)\b|\bgoing\b|status|progress|running|\blogs?\b|로그|결과|results?|output|nvidia-smi|squeue|gpu\s?(사용|메모리|usage|memory)|분석)/i;
const VIEW = /(fresh|\bttt\b|\bide\b|터미널|terminal|attach|접속|붙어|붙여|tmux|열어|open\b|tail\s?-f)/i;

/** Is this a request about a remote machine? A configured server named in it, or the word "server"/"GPU"/"cluster"
 *  with a remote hint, and not a local dev server. */
export function serverIntent(prompt: string, servers: ServerEntry[] = knownServers()): boolean {
  if (LOCAL_SERVER.test(prompt) && !serverIn(prompt, servers)) return false;
  if (serverIn(prompt, servers) && (RUN.test(prompt) || STATUS.test(prompt) || VIEW.test(prompt))) return true;
  return SERVER_WORD.test(prompt) && REMOTE_HINT.test(prompt) && (RUN.test(prompt) || STATUS.test(prompt) || VIEW.test(prompt));
}

const viewerIn = (p: string): Viewer | "attach" | "log" | undefined =>
  /fresh/i.test(p) ? "fresh" : /\bttt\b/i.test(p) ? "ttt" : /(attach|붙어|붙여|tmux|직접\s?(제어|조작))/i.test(p) ? "attach" : /(tail\s?-f|로그.{0,6}(따라|실시간|계속)|follow)/i.test(p) ? "log" : /(터미널|terminal|셸|shell|접속)/i.test(p) ? "shell" : undefined;

/** The command to run, from the request: `backticks`, or a script named in it (or attached) that exists in the project. */
export function commandFor(prompt: string, root: string, files: { path: string }[]): string | undefined {
  const tick = /`([^`\n]{2,300})`/.exec(prompt)?.[1]?.trim();
  if (tick) return tick;
  const named = /([\w./-]+\.(py|sh|ipynb))\b/.exec(prompt)?.[1] ?? files.map((f) => f.path).find((p) => /\.(py|sh)$/.test(p));
  if (!named) return undefined;
  const rel = named.startsWith("/") ? relative(root, named) : named;
  if (rel.startsWith("..") || !existsSync(join(root, rel))) return undefined;
  if (rel.endsWith(".py")) return `python3 ${q(rel).replace(/^'([\w./-]+)'$/, "$1")}`;
  if (rel.endsWith(".sh")) {
    let sbatch = /(slurm|sbatch|큐|queue|제출|submit)/i.test(prompt);
    try { sbatch ||= /^#SBATCH\b/m.test(readFileSync(join(root, rel), "utf8").slice(0, 4000)); } catch { /* unreadable */ }
    return `${sbatch ? "sbatch" : "bash"} ${rel}`;
  }
  return undefined;
}

const mb = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(1)} MB`);
const nodeRun = (args: string) => `/bin/bash ${q(join(REPO, "scripts", "node-run.sh"))} ${q(join(REPO, "bin", "afm-server.ts"))} ${args}`;

export async function serverSkill(c: ServerContext): Promise<ServerResult> {
  const K = c.ko, servers = knownServers();
  const approved = /controller ran:\n\$ [^\n]*afm-server\.ts'? run [\s\S]*?ONBUD_JOB (\{[^\n]+\})/.exec(c.history ?? "");
  if (approved) {   // the user said yes and the job started: say how to watch it, and open the view if asked
    let job: Job | undefined; try { job = JSON.parse(approved[1]); } catch { /* malformed */ }
    if (job) return started(job, c, servers.find((s) => s.host === job!.host));
  }
  const failedRun = /controller ran:\n\$ [^\n]*afm-server\.ts'? run [^\n]*\n([\s\S]*?)\[exit (\d+|timeout)\]/.exec(c.history ?? "");
  if (failedRun) return { answer: (K ? "서버 작업을 시작하지 못했어요:\n\n```\n" : "The server job did not start:\n\n```\n") + failedRun[1].trim().slice(-1500) + "\n```", verified: false, detail: "run_failed" };

  // one server registered in servers.json is the default; ~/.ssh/config aliases must be named (no surprise logins)
  const registered = servers.filter((x) => x.source === "config");
  const s = serverIn(c.prompt, servers) ?? (registered.length === 1 ? registered[0] : undefined);
  if (!s) {
    return { verified: true, detail: "no_server", answer: servers.length
      ? (K ? `어느 서버인가요? 알고 있는 서버: ${servers.map((x) => `\`${x.name}\``).join(", ")}. 요청에 이름을 넣어 주세요.` : `Which server? Known: ${servers.map((x) => `\`${x.name}\``).join(", ")}. Name it in the request.`)
      : (K ? "등록된 서버가 없어요. `~/.ssh/config`에 `Host gpu1` 항목을 만들거나 `~/OnBud/config/servers.json`에 `{\"servers\": {\"gpu1\": {\"host\": \"gpu1\", \"dir\": \"~/work/proj\"}}}`를 넣어 주세요. OnBud은 키 파일을 읽지 않고, 시스템 `ssh`가 접속해요."
          : "No servers yet. Add `Host gpu1` to `~/.ssh/config` or `{\"servers\": {\"gpu1\": {\"host\": \"gpu1\", \"dir\": \"~/work/proj\"}}}` to `~/OnBud/config/servers.json`. OnBud never reads key files; the system `ssh` connects.") };
  }
  const p = c.prompt, explicitView = viewerIn(p);
  if (RUN.test(p) && !(/(어디까지|끝났|됐어|status|progress)/i.test(p))) return plan(s, c);
  if (explicitView && !STATUS.test(p.replace(/(fresh|ttt|터미널|terminal)/gi, ""))) return view(s, explicitView, c);
  if (STATUS.test(p)) return jobStatus(s, c);
  return view(s, explicitView ?? s.viewer ?? (freshOnMac() ? "fresh" : "shell"), c);
}

async function plan(s: ServerEntry, c: ServerContext): Promise<ServerResult> {
  const K = c.ko;
  if (!c.root) return { verified: true, detail: "needs_project_folder", answer: K ? "올릴 코드가 있는 프로젝트 폴더를 먼저 열어 주세요." : "Open the project folder with the code to upload first." };
  const cmd = commandFor(c.prompt, c.root, c.files);
  if (!cmd) return { verified: true, detail: "needs_command", answer: K ? `**${s.name}**에서 무엇을 실행할까요? 프로젝트 안의 스크립트 이름(예: \`train.py\`)이나 명령을 \`백틱\`으로 알려 주세요.` : `What should run on **${s.name}**? Name a script in the project (e.g. \`train.py\`) or give the command in \`backticks\`.` };
  const up = await planUpload(c.root);
  if (!up) return { verified: true, detail: "upload_refused", answer: K ? "이 폴더는 통째로 올리지 않아요 (홈, 시스템, 자격 증명 폴더). 프로젝트 폴더를 열어 주세요." : "This folder is not uploaded whole (home, system or credential folders). Open a project folder." };
  const dir = s.dir ?? `~/onbud/${c.root.split("/").pop()!.replace(/[^\w.-]/g, "_")}`;
  const left = [up.secrets.length ? (K ? `비밀 파일 ${up.secrets.length}개(${up.secrets.slice(0, 3).map((f) => `\`${f}\``).join(", ")}${up.secrets.length > 3 ? " …" : ""})` : `${up.secrets.length} secret file(s) (${up.secrets.slice(0, 3).map((f) => `\`${f}\``).join(", ")}${up.secrets.length > 3 ? " …" : ""})`) : "",
    up.large.length ? (K ? `50 MB 넘는 파일 ${up.large.length}개` : `${up.large.length} file(s) over 50 MB`) : ""].filter(Boolean).join(K ? ", " : ", ");
  const wantView = viewerIn(c.prompt);
  const pending = nodeRun(`run ${q(s.name)} --dir ${q(dir)} --push . -- ${q(cmd)}`);
  return { verified: true, detail: `plan ${up.files.length} files`, pendingCommand: pending,
    answer: K
      ? `**${s.name}** 서버의 \`${dir}\`에 파일 ${up.files.length}개(${mb(up.bytes)})를 올리고 \`${cmd}\`를 백그라운드로 실행할게요 (서버에 tmux가 있으면 tmux 세션, \`sbatch\`면 Slurm).${left ? ` 올리지 않는 것: ${left}.` : ""} 서버의 파일은 지우지 않아요.${wantView ? ` 시작되면 ${wantView === "fresh" ? "Fresh" : wantView === "ttt" ? "TTT" : "터미널"}로 보여 드릴게요.` : ""}\n\n진행할까요?`
      : `I'll upload ${up.files.length} files (${mb(up.bytes)}) to \`${dir}\` on **${s.name}** and start \`${cmd}\` in the background (a tmux session when the server has tmux; Slurm for \`sbatch\`).${left ? ` Left out: ${left}.` : ""} Nothing on the server is deleted.${wantView ? ` Once it starts I'll open it in ${wantView === "fresh" ? "Fresh" : wantView === "ttt" ? "TTT" : "a terminal"}.` : ""}\n\nGo ahead?` };
}

async function started(job: Job, c: ServerContext, s?: ServerEntry): Promise<ServerResult> {
  const K = c.ko;
  const how = job.kind === "tmux" ? (K ? `tmux 세션 \`onbud-${job.id}\`(직접 제어: "붙어줘")` : `tmux session \`onbud-${job.id}\` (take over: "attach")`)
    : job.kind === "slurm" ? `Slurm job ${job.slurmId}` : "nohup";
  let opened = "";
  const v = viewerIn(c.prompt) ?? s?.viewer;
  if (v) { const o = await openView(job.host, job.dir, v, job); opened = o.line(K); }
  return { verified: true, detail: `started ${job.kind}`,
    answer: (K ? `**${job.host}**에서 작업 \`${job.id}\`를 시작했어요: \`${job.command}\` — ${how}.\n- 폴더: \`${job.dir}\`\n- 로그: \`${job.log}\` (서버의 \`.onbud/STATUS.md\`에도 상태가 적혀요)\n- 진행 상황: "${s?.name ?? job.host} 진행 상황 알려줘", 화면으로 보기: "${s?.name ?? job.host} fresh로 열어줘" / "ttt로" / "로그 따라가줘"`
      : `Started job \`${job.id}\` on **${job.host}**: \`${job.command}\` — ${how}.\n- folder: \`${job.dir}\`\n- log: \`${job.log}\` (the state is also in \`.onbud/STATUS.md\` on the server)\n- progress: "how is ${s?.name ?? job.host} doing", to watch: "open ${s?.name ?? job.host} in fresh" / "in ttt" / "follow the log"`)
      + (opened ? `\n\n${opened}` : "") };
}

async function jobStatus(s: ServerEntry, c: ServerContext): Promise<ServerResult> {
  const K = c.ko, job = findJob(undefined, s.host);
  if (!job) {
    const r = await check(s.host);
    if (!r.ok) return { verified: false, detail: "unreachable", answer: (await import("./remote.ts")).sshProblem(s.host, r.error, K) };
    const t = Object.entries(r.caps.tools).filter(([, v]) => v).map(([k]) => k);
    return { verified: true, detail: "check", answer: (K ? `**${s.name}** (${r.caps.os}) — OnBud이 시작한 작업은 아직 없어요.\n- 도구: ${t.join(", ") || "없음"}` : `**${s.name}** (${r.caps.os}) — no OnBud jobs yet.\n- tools: ${t.join(", ") || "none"}`)
      + (r.caps.gpus.length ? `\n- GPU:\n${r.caps.gpus.map((g) => `  - ${g}`).join("\n")}` : "")
      + (!r.caps.tools.python3 ? (K ? "\n\nFresh로 원격 편집을 하려면 서버에 Python 3가 필요해요." : "\n\nFresh's remote editing needs Python 3 on the server.") : "") };
  }
  const r = await status(job, 30);
  if (!r.ok) return { verified: false, detail: "unreachable", answer: r.error };
  const st = r.status;
  const label = st.state === "done" ? (st.exitCode === 0 ? (K ? "끝났어요 (성공)" : "finished (exit 0)") : (K ? `끝났어요 (실패, exit ${st.exitCode})` : `finished with exit ${st.exitCode}`))
    : st.state === "running" || st.state === "RUNNING" ? (K ? "실행 중" : "running") : st.state === "lost" ? (K ? "프로세스가 없어요 (서버 재시작 등으로 중단된 듯)" : "no process (stopped, e.g. a server restart)") : st.state;
  return { verified: true, detail: `status ${st.state}`,
    answer: `**${s.name}** \`${job.id}\` — ${label}\n\`${job.command}\`\n\n\`\`\`\n${st.tail.split("\n").slice(-25).join("\n") || (K ? "(로그 없음)" : "(no log yet)")}\n\`\`\``
      + (st.state === "done" && st.exitCode !== 0 ? (K ? "\n\n오류 원인을 보려면 로그를 붙여 \"이 에러 원인 찾아줘\"라고 하거나, 화면으로 보려면 \"fresh로 열어줘\"라고 해 주세요." : "\n\nFor the cause, paste the log with \"find the cause of this error\", or say \"open it in fresh\".") : "") };
}

async function openView(host: string, dir: string, viewer: Viewer | "attach" | "log", job?: Job): Promise<{ ok: boolean; cmd: string; line: (ko: boolean) => string }> {
  let abs = dir;
  if (!abs.startsWith("/")) {
    const r = await check(host);
    const home = r.ok ? r.caps.home : "";
    abs = !home ? dir : dir === "~" ? home : dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : `${home}/${dir}`;
  }
  const v = viewer === "fresh" && !freshOnMac() ? "shell" : viewer;
  const cmd = viewCommand({ host, absDir: abs, viewer: v, job });
  const term = await chooseApp("terminal");
  const ok = !!term && await openTerminal(homedir(), cmd, term);
  const name = v === "fresh" ? "Fresh" : v === "ttt" ? "TTT" : v === "attach" ? "tmux" : v === "log" ? "log" : "shell";
  return { ok, cmd, line: (ko) => ok
    ? (ko ? `${term ? appName(term.app) : "터미널"}에서 ${name}(으)로 열었어요: \`${cmd}\`${viewer === "fresh" && v !== "fresh" ? " (Mac에 Fresh가 없어 셸로 열었어요: `brew install fresh-editor`)" : ""}` : `Opened ${name} in ${term ? appName(term.app) : "a terminal"}: \`${cmd}\`${viewer === "fresh" && v !== "fresh" ? " (Fresh is not on this Mac, so a shell: `brew install fresh-editor`)" : ""}`)
    : (ko ? `터미널을 열지 못했어요. 직접 실행: \`${cmd}\`` : `Could not open a terminal; run it yourself: \`${cmd}\``) };
}

async function view(s: ServerEntry, viewer: Viewer | "attach" | "log", c: ServerContext): Promise<ServerResult> {
  const job = findJob(undefined, s.host);
  const dir = job?.dir ?? s.dir ?? "~";
  const o = await openView(s.host, dir, viewer, job);
  return { verified: o.ok, detail: `view ${viewer}`, answer: o.line(c.ko) + (viewer === "ttt" ? (c.ko ? "\n\nTTT는 서버에 설치돼 있어야 해요 (`ttt`가 없으면 셸만 열려요)." : "\n\nTTT must be installed on the server.") : "") };
}
