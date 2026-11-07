// OnBud Server skill CLI: the commands the controller proposes (and the user approves), also usable directly.
//   afm-server hosts                                   servers you can name (servers.json, ~/.ssh/config Host names)
//   afm-server check  HOST                             what the server has (python3, tmux, Slurm, GPUs, fresh, ttt)
//   afm-server run    HOST --dir D [--push LOCAL] -- CMD   upload LOCAL (secrets and big files left out), start CMD
//   afm-server status [JOB] [-n LINES]                 state and the log's last lines (latest job by default)
//   afm-server stop   JOB
//   afm-server pull   JOB PATH [DEST]                  copy a result back (default ~/OnBud/runtime/server/<host>/<job>/)
//   afm-server open   HOST [--dir D] [--job JOB] [--viewer fresh|ttt|shell|attach|log]   a terminal window on it
// Prints JSON with --json. Lines starting "ONBUD_JOB " carry the started job for the controller.
import { chooseApp, openTerminal } from "../services/context-builder/apps.ts";
import { check, defaultPullDir, findJob, freshOnMac, knownServers, listJobs, planUpload, pull, push, run, status, stop, validHost, validRemoteDir, viewCommand, type Viewer } from "../services/server/remote.ts";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const dash = argv.indexOf("--");
const args = (dash >= 0 ? argv.slice(0, dash) : argv).filter((a) => a !== "--json");
const tail = dash >= 0 ? argv.slice(dash + 1).join(" ") : "";
const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")) && !(i > 0 && args[i - 1] === "-n"));
const out = (o: unknown, text: string) => console.log(json ? JSON.stringify(o) : text);
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
const hostOf = (name?: string) => {
  if (!name) fail("host required (afm-server hosts lists them)");
  const s = knownServers().find((x) => x.name === name);
  const host = s?.host ?? name!;
  if (!validHost(host)) fail(`invalid host: ${name}`);
  return { host, entry: s };
};

switch (pos[0]) {
  case "hosts": {
    const s = knownServers();
    out(s, s.length ? s.map((x) => `${x.name}${x.host !== x.name ? ` → ${x.host}` : ""}${x.dir ? `  ${x.dir}` : ""}  (${x.source})`).join("\n") : "No servers: add one to ~/OnBud/config/servers.json or a Host to ~/.ssh/config.");
    break;
  }
  case "check": {
    const { host } = hostOf(pos[1]);
    const r = await check(host);
    if (!r.ok) fail(r.error.err || `exit ${r.error.code}`);
    const c = (r as any).caps;
    out(c, `${host}: ${c.os}\n${Object.entries(c.tools).filter(([, v]) => v).map(([k]) => k).join(" ") || "(none of the known tools)"}${c.gpus.length ? "\n" + c.gpus.map((g: string) => "GPU " + g).join("\n") : ""}`);
    break;
  }
  case "run": {
    const { host, entry } = hostOf(pos[1]);
    const dir = flag("--dir") ?? entry?.dir;
    if (!dir || !validRemoteDir(dir)) fail("--dir <remote folder> required");
    if (!tail.trim()) fail("the command goes after --");
    const local = flag("--push");
    if (local) {
      const plan = await planUpload(local);
      if (!plan) fail(`refused upload folder: ${local}`);
      const p = await push(host, plan!, dir!);
      if (p.code !== 0) fail(p.err || p.out);
      console.log(`uploaded ${plan!.files.length} files (${(plan!.bytes / 1e6).toFixed(1)} MB)${plan!.secrets.length ? `; left out ${plan!.secrets.length} secret file(s)` : ""}${plan!.large.length ? `; ${plan!.large.length} file(s) over 50 MB` : ""}`);
    }
    const r = await run(host, dir!, tail);
    if (!r.ok) fail((r as any).error);
    const j = (r as any).job;
    console.log(`ONBUD_JOB ${JSON.stringify(j)}`);
    if (!json) console.log(`started ${j.id} on ${host} (${j.kind}${j.slurmId ? ` ${j.slurmId}` : ""}) in ${j.dir}; log ${j.log}`);
    break;
  }
  case "status": {
    const job = findJob(pos[1]);
    if (!job) fail(pos[1] ? `no job ${pos[1]}` : "no jobs yet");
    const r = await status(job!, Number(flag("-n") ?? 40));
    if (!r.ok) fail((r as any).error);
    const s = (r as any).status;
    out({ job, ...s }, `${job!.id} on ${job!.host}: ${s.state}${s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ""}\n$ ${job!.command}\n${s.tail}`);
    break;
  }
  case "jobs": out(listJobs(), listJobs().map((j) => `${j.id}  ${j.host}  ${j.started.slice(0, 16)}  ${j.command}`).join("\n") || "no jobs yet"); break;
  case "stop": {
    const job = findJob(pos[1]);
    if (!job || !pos[1]) fail("which job? (afm-server jobs)");
    const r = await stop(job!);
    if (r.code !== 0) fail(r.err || r.out);
    out({ stopped: job!.id }, `stopped ${job!.id}`);
    break;
  }
  case "pull": {
    const job = findJob(pos[1]);
    if (!job || !pos[2]) fail("usage: afm-server pull JOB PATH [DEST]");
    const dest = pos[3] ?? defaultPullDir(job!.host, job!.id);
    const r = await pull(job!.host, job!.dir, pos[2], dest);
    if (r.code !== 0) fail(r.err || "pull failed");
    out({ dest }, r.out);
    break;
  }
  case "open": {
    const job = flag("--job") ? findJob(flag("--job")) : undefined;
    const { host, entry } = hostOf(job?.host ?? pos[1]);
    let dir = job?.dir ?? flag("--dir") ?? entry?.dir ?? "~";
    const viewer = (flag("--viewer") ?? entry?.viewer ?? (freshOnMac() ? "fresh" : "shell")) as Viewer | "attach" | "log";
    if (!dir.startsWith("/")) {   // Fresh's ssh:// URL needs an absolute path
      const c = await check(host);
      if (!c.ok) fail(c.error.err || "could not reach the server");
      const home = (c as any).caps.home;
      dir = dir === "~" ? home : dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : `${home}/${dir}`;
    }
    const cmd = viewCommand({ host, absDir: dir, viewer, job });
    const term = await chooseApp("terminal");
    if (!term) fail(`no terminal app found; run it yourself: ${cmd}`);
    const ok = await openTerminal(homedir(), cmd, term!);
    out({ ok, command: cmd }, ok ? `opened: ${cmd}` : `could not open a terminal; run it yourself: ${cmd}`);
    break;
  }
  default:
    console.log("usage: afm-server hosts | check HOST | run HOST --dir D [--push LOCAL] -- CMD | status [JOB] | jobs | stop JOB | pull JOB PATH [DEST] | open HOST [--dir D] [--job JOB] [--viewer fresh|ttt|shell|attach|log]");
    if (pos[0]) process.exit(2);
}
