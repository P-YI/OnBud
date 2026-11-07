// Server skill (services/server): host parsing, the upload plan, the gate, and a full run → status → pull cycle
// against a fake ssh that runs the remote side in a temporary "home" on this Mac (no network, no real server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "onbud-remote-"));
const fakeHome = join(base, "remote-home"), oafm = join(base, "oafm");
mkdirSync(join(oafm, "config"), { recursive: true });
writeFileSync(join(oafm, "config", "servers.json"), JSON.stringify({ servers: { gpufake: { host: "gpufake", dir: "~/work/proj" }, bad: { host: "-oProxyCommand=x" } } }));
const ssh = join(base, "ssh");
writeFileSync(ssh, `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2;; -t|-T) shift;; --) shift; break;; *) break;; esac; done
shift
mkdir -p "${fakeHome}"; cd "${fakeHome}"; export HOME="${fakeHome}" PATH=/usr/bin:/bin
exec bash -c "$*"
`);
chmodSync(ssh, 0o755);
process.env.ONBUD_HOME = oafm;
process.env.ONBUD_SSH = ssh;

const R = await import("../services/server/remote.ts");
const S = await import("../services/server/server-skill.ts");
const { detectLocalSkill } = await import("../services/controller/local-skills.ts");

test("server: hosts and folders are validated; servers.json and ~/.ssh/config Host names (no wildcards)", () => {
  assert.ok(R.validHost("gpu1") && R.validHost("me@dev-gpu-2.example.org"));
  for (const h of ["-oProxyCommand=x", "a b", "a;b", "$(x)", ""]) assert.equal(R.validHost(h), false, h);
  assert.ok(R.validRemoteDir("~/work/p") && R.validRemoteDir("/scratch/me") && R.validRemoteDir("proj"));
  for (const d of ["~/../etc", "a;b", "$(x)", "a b", "`x`"]) assert.equal(R.validRemoteDir(d), false, d);
  const home = join(base, "mac-home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "config"), "Host gpu1 gpu1-alt\n  HostName 10.0.0.5\n  IdentityFile ~/.ssh/id_x\nHost *\n  ServerAliveInterval 30\nHost !bad cl?\n");
  const names = R.knownServers(home).map((s) => `${s.name}:${s.source}`);
  assert.deepEqual(names, ["gpufake:config", "gpu1:ssh_config", "gpu1-alt:ssh_config"]);
  assert.equal(R.serverIn("gpu1-alt에서 돌려줘", R.knownServers(home))?.name, "gpu1-alt");
  assert.equal(R.serverIn("run on gpu1 please", R.knownServers(home))?.name, "gpu1");
  assert.equal(R.serverIn("gpu10 상태", R.knownServers(home)), undefined);
});

test("server: intent — remote machines, not local dev servers", () => {
  const sv = [{ name: "gpu1", host: "gpu1", source: "ssh_config" as const }];
  for (const p of ["GPU 서버에서 이 코드를 실행하고 결과를 분석해 줘", "gpu1 학습 어디까지 됐어?", "Open gpu1 in fresh", "클러스터에 sbatch로 train.sh 제출해줘", "How is the training on the GPU server going?", "서버 ttt로 보여줘 gpu1"])
    assert.ok(S.serverIntent(p, sv), p);
  for (const p of ["로컬 서버 띄워줘", "npm run dev 서버 실행해줘", "MCP 서버 로그 보여줘", "start the dev server", "터미널 열어줘", "서버 개발 방법 알려줘"])
    assert.equal(S.serverIntent(p, sv), false, p);
  assert.equal(detectLocalSkill("GPU 서버에서 train.py 돌려줘", []), "server");
  assert.notEqual(detectLocalSkill("로컬 서버 띄워줘", []), "server");
  assert.equal(detectLocalSkill("Downloads 폴더에서 터미널 열어줘", []), "open_app");
});

const proj = join(base, "proj");
mkdirSync(join(proj, "sub"), { recursive: true });
writeFileSync(join(proj, "train.py"), 'print("step 1"); print("done")\n');
writeFileSync(join(proj, "job.sh"), "#!/bin/bash\n#SBATCH --gres=gpu:1\npython3 train.py\n");
writeFileSync(join(proj, ".env"), "TOKEN=1\n");
writeFileSync(join(proj, "sub", "key.pem"), "x\n");
writeFileSync(join(proj, "sub", "data.csv"), "a,b\n");
mkdirSync(join(proj, "node_modules", "x"), { recursive: true });
writeFileSync(join(proj, "node_modules", "x", "i.js"), "1");

test("server: the upload plan leaves out secrets, rebuilt folders and big files; home and credential folders refused", async () => {
  const p = (await R.planUpload(proj))!;
  assert.deepEqual(p.files.sort(), ["job.sh", "sub/data.csv", "train.py"]);
  assert.deepEqual(p.secrets.sort(), [".env", "sub/key.pem"]);
  assert.equal(R.uploadableRoot(process.env.HOME!), undefined);
  assert.equal(R.uploadableRoot("/"), undefined);
  assert.equal(R.uploadableRoot(join(process.env.HOME!, ".ssh")), undefined);
});

test("server: the command comes from backticks or a script in the project (sbatch for #SBATCH)", () => {
  assert.equal(S.commandFor("gpu1에서 `python3 train.py --epochs 3` 돌려", proj, []), "python3 train.py --epochs 3");
  assert.equal(S.commandFor("gpu1에서 train.py 돌려줘", proj, []), "python3 train.py");
  assert.equal(S.commandFor("run job.sh on the cluster", proj, []), "sbatch job.sh");
  assert.equal(S.commandFor("gpu1에서 missing.py 돌려줘", proj, []), undefined);
});

test("server: run → status → pull through ssh, the gate refuses dangerous commands, STATUS.md written", async () => {
  const plan = (await R.planUpload(proj))!;
  const up = await R.push("gpufake", plan, "~/work/proj");
  assert.equal(up.code, 0, up.err);
  assert.ok(existsSync(join(fakeHome, "work/proj/train.py")) && !existsSync(join(fakeHome, "work/proj/.env")) && !existsSync(join(fakeHome, "work/proj/sub/key.pem")));
  const r = await R.run("gpufake", "~/work/proj", "python3 train.py");
  assert.ok(r.ok, (r as any).error);
  const job = (r as any).job;
  assert.equal(job.kind, "nohup");
  let st: any;
  for (let i = 0; i < 40; i++) { st = await R.status(job); if (st.ok && st.status.state === "done") break; await new Promise((res) => setTimeout(res, 150)); }
  assert.equal(st.status.state, "done");
  assert.equal(st.status.exitCode, 0);
  assert.match(st.status.tail, /step 1\ndone/);
  assert.match(readFileSync(join(fakeHome, "work/proj/.onbud/STATUS.md"), "utf8"), new RegExp(`${job.id}\` — done \\(exit 0\\)`));
  const dest = join(base, "pulled");
  const p = await R.pull("gpufake", job.dir, "train.py", dest);
  assert.equal(p.code, 0, p.err);
  assert.ok(existsSync(join(dest, "train.py")));
  const bad = await R.run("gpufake", "~/work/proj", "rm -rf /");
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /security gate/);
  const fail = await R.run("gpufake", "~/work/proj", "python3 -c 'import sys; sys.exit(3)'");
  for (let i = 0; i < 40; i++) { st = await R.status((fail as any).job); if (st.status.state === "done") break; await new Promise((res) => setTimeout(res, 150)); }
  assert.equal(st.status.exitCode, 3);
});

test("server: terminal IDE commands (Fresh on the Mac, TTT/shell/tmux/log over ssh -t)", () => {
  const job = { id: "jx", host: "gpu1", dir: "/home/me/p", command: "python3 t.py", kind: "tmux" as const, log: ".onbud/jobs/jx.log", started: "" };
  assert.equal(R.viewCommand({ host: "gpu1", absDir: "/home/me/p", viewer: "fresh" }), "fresh 'ssh://gpu1/home/me/p'");
  assert.equal(R.viewCommand({ host: "gpu1", absDir: "/home/me/p", viewer: "ttt" }), `ssh -t gpu1 'cd '\\''/home/me/p'\\'' && ttt'`);
  assert.match(R.viewCommand({ host: "gpu1", absDir: "/home/me/p", viewer: "attach", job }), /tmux attach -t onbud-jx/);
  assert.match(R.viewCommand({ host: "gpu1", absDir: "/home/me/p", viewer: "log", job }), /tail -n 200 -F/);
});

test("server skill: a run is a plan the user approves (command quoted), then the started job is reported", async () => {
  const r = await S.serverSkill({ root: proj, prompt: "gpufake에서 `python3 train.py > out.txt` 돌려줘", files: [], ko: true });
  assert.ok(r.pendingCommand, r.answer);
  assert.match(r.pendingCommand!, /afm-server\.ts' run 'gpufake' --dir '~\/work\/proj' --push \. -- 'python3 train.py > out\.txt'$/);
  assert.match(r.answer, /파일 3개.*비밀 파일 2개/s);
  const job = { id: "j1", host: "gpufake", dir: "/srv/p", command: "python3 train.py", kind: "tmux", log: ".onbud/jobs/j1.log", started: "" };
  const after = await S.serverSkill({ root: proj, prompt: "gpufake에서 train.py 돌려줘", files: [], ko: true,
    history: `user approved and the controller ran:\n$ ${r.pendingCommand}\nuploaded 3 files\nONBUD_JOB ${JSON.stringify(job)}\nstarted j1\n[exit 0]` });
  assert.equal(after.pendingCommand, undefined);
  assert.match(after.answer, /작업 `j1`를 시작했어요.*onbud-j1/s);
  const noServer = await S.serverSkill({ root: proj, prompt: "nowhere-host 서버에서 train.py 돌려줘", files: [], ko: false });
  assert.ok(noServer.pendingCommand, "the single servers.json entry is the default");
});
