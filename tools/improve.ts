// Improvement runner (skills plan P7, 2026-11-06): the measurement loop's last step. Reads the latest skill-eval
// results, picks the reddest family (or --family), writes a brief scoped to the skill that owns it, and — only
// with --run --yes-spend-codex — asks Codex (OpenCode's codex agent) to change that skill in a separate worktree,
// then runs the gates there (npm test; skill-eval against the baseline). It never merges: it prints the branch
// and the gate result, and the user decides.
// usage: node --experimental-strip-types --experimental-sqlite --no-warnings tools/improve.ts [--target code] [--results f.jsonl] [--family f] [--run --yes-spend-codex]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const RES = join(HOME, "runtime", "bench", "skills");

// --target code (2026-11-06): the code skill's loop. Reads the latest code-eval runs (s5/copilot), counts where tasks
// are lost (Copilot fails the examples → Codex; Copilot passes the examples but fails hidden tests), and asks Codex
// to improve Copilot's generation side in a separate worktree. Gate: npm test, then Copilot-only runs (no Codex) on
// the dev splits in the worktree against the same runs on HEAD. Hidden tests are never shown to the agent.
if (opt("--target") === "code") {
  const CODE = join(HOME, "runtime", "bench", "code");
  const runsOf = (re: RegExp) => readdirSync(CODE).filter((n) => re.test(n)).map((n) => join(CODE, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const f = opt("--results") ?? runsOf(/^results-lcb-s5-.*\.jsonl$/)[0];
  if (!f) { console.error("no code-eval s5 run yet"); process.exit(2); }
  const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const esc = rows.filter((r) => r.route === "escalated"), wrong = rows.filter((r) => r.route === "copilot" && !r.pass);
  const by = (xs: any[]) => Object.entries(xs.reduce((a: any, r: any) => { const d = /\((\w+)\)/.exec(r.id)?.[1] ?? "?"; a[d] = (a[d] ?? 0) + 1; return a; }, {})).map(([k, v]) => `${k} ${v}`).join(", ");
  const brief = `Improve the OnBud code skill's generation side: GitHub Copilot inline completion as the code writer.

Measured (${f.split("/").pop()}, LiveCodeBench dev, ${rows.length} contest problems): Copilot's code failed the statement's examples (after one retry with the failure as a comment) on ${esc.length} problems (${by(esc)}), and each became a Codex call. ${wrong.length} more passed the examples and failed hidden tests (${by(wrong)}); that verification side (stressTest, gate in services/controller/code-skill.ts) is not part of this task.

Goal: more problems solved by Copilot before Codex, without lowering HumanEval dev or ML. Where to work: copilotCandidate in services/controller/codegen.ts (the editor context Copilot sees: statement as comments, hints, signature) and the retry loop in solveS5 (tools/bench/code-eval.ts) and solveAdaptive. Ideas to test, not requirements: an approach comment AFM writes from the statement before Copilot completes (AFM is local and free), more than one Copilot sample with selection by the examples, a retry hint that names the failing example's input and expected output.

Rules:
- General changes only: nothing keyed to a problem id, title or wording. Never open the hidden tests (the "private" field in runtime/bench/code/lcb.jsonl) or the result files' error fields beyond what this brief says.
- Copilot requests must stay editor-like: at most ~10 per problem on average (LIMITS in services/frontier/copilot-ls.ts is not to be raised).
- Keep the code style of the files (comments say why, dated when they record a measurement).
- Run npm test. Measure with: ONBUD_COPILOT_PER_HOUR=600 node --experimental-strip-types --experimental-sqlite --no-warnings tools/bench/code-eval.ts --bench lcb --mode copilot --no-stress --ids tools/bench/subsets/dev-lcb-v6-30.json --tag p7 (no Codex is spent in --mode copilot), and the same with --bench humaneval --ids tools/bench/subsets/dev-humaneval-30.json.
- Commit on this branch with a message that says what changed and what the measurement showed.`;
  console.log(`results: ${f}\n\n${brief}\n`);
  if (!args.includes("--run")) { console.log("(dry run: add --run --yes-spend-codex to let Codex try this in a separate worktree)"); process.exit(0); }
  if (!args.includes("--yes-spend-codex")) { console.error("--run spends Codex usage: add --yes-spend-codex to confirm"); process.exit(2); }
  const id = `improve-code-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
  const wt = join(HOME, "runtime", "worktrees", id);
  execFileSync("git", ["-C", REPO, "worktree", "add", "-b", `afm/${id}`, wt, "HEAD"], { stdio: "inherit" });
  writeFileSync(join(wt, ".improve-brief.md"), brief);
  // the first run (2026-11-07) passed the main checkout to afm_code's folder argument and edited it, not the worktree
  const scoped = `${brief}\n- Work only in ${wt}. Any tool that takes a folder or path (afm_code, afm_task) gets this worktree, never ${REPO}.`;
  const r = spawnSync(join(homedir(), ".opencode", "bin", "opencode"), ["run", "--auto", "--agent", "codex", scoped], { cwd: wt, stdio: "inherit", timeout: 90 * 60_000 });
  console.log(`codex exit ${r.status}`);
  const test = spawnSync("npm", ["test", "--silent"], { cwd: wt, encoding: "utf8" });
  console.log(`npm test: ${/# fail 0/.test(test.stdout) ? "pass" : "FAIL"}`);
  console.log(`\nbranch afm/${id} in ${wt} — compare its Copilot-only runs with HEAD's; merge only with gains and no regressions.`);
  process.exit(0);
}

const latest = opt("--results") ?? readdirSync(RES).filter((n) => /^results-.*\.jsonl$/.test(n)).map((n) => join(RES, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!latest) { console.error("no skill-eval results yet: run npm run skills:eval first"); process.exit(2); }
const lines = readFileSync(latest, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const runs = lines.filter((x) => !x.summary && !x.private);   // private cases never go into a brief
const summary = lines.filter((x) => x.summary && !x.private);
const verdict = new Map<string, boolean>(summary.length ? summary.map((x) => [x.id, x.ok]) : runs.map((x) => [x.id, x.ok]));
// public cases with their family and request
const cases = new Map<string, any>();
for (const d of readdirSync(join(REPO, "skills"))) {
  const f = join(REPO, "skills", d, "evals", "cases.jsonl");
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const c = JSON.parse(l); cases.set(c.id, { ...c, pack: c.expect?.skill ?? d }); }
}
const red = [...verdict].filter(([id, ok]) => !ok && cases.has(id)).map(([id]) => cases.get(id));
if (!red.length) { console.log(`all public cases green in ${latest}`); process.exit(0); }
const fam = new Map<string, any[]>();
for (const c of red) { const k = c.family ?? c.id; fam.set(k, [...(fam.get(k) ?? []), c]); }
const pick = opt("--family") ?? [...fam].sort((a, b) => b[1].length - a[1].length)[0][0];
const target = fam.get(pick) ?? [];
if (!target.length) { console.error(`no red family ${pick}`); process.exit(2); }
const skill = target[0].pack;
const manifest = JSON.parse(readFileSync(join(REPO, "skills", skill, "skill.json"), "utf8"));
const fails = target.map((c) => {
  const r = runs.filter((x) => x.id === c.id).at(-1);
  const failed = r ? Object.entries(r.checks).filter(([, v]: any) => !v.ok).map(([k, v]: any) => `${k}: ${v.reason}`).join("; ") : "?";
  return `- ${c.id}: "${c.q}" → reasonCode ${r?.reasonCode ?? "?"}; failed: ${failed}${r?.answer ? `\n  answer: ${String(r.answer).slice(0, 300).replace(/\n/g, " ")}` : ""}`;
}).join("\n");

const brief = `Improve the OnBud skill "${skill}" (${manifest.description})

Red eval family "${pick}" (${target.length} case(s)):
${fails}

Rules:
- Change only what this skill needs (its stage in services/controller/controller.ts, its code, skills/${skill}/). Do not touch other skills' code or the security gate.
- The fix must be general: it must hold for other wordings and languages of the same request, not just these sentences. No new trigger regex for these exact words; prefer the manifest's entries (router examples) or a programmatic check.
- Add one more public case to skills/${skill}/evals/cases.jsonl in the same family (another wording or language).
- Run: npm test, and node --experimental-strip-types --experimental-sqlite --no-warnings tools/skill-eval.ts --only ${skill} --repeat 3
- Commit on this branch with a message that says what was wrong and why the change is general.`;

console.log(`results: ${latest}\nfamily: ${pick} (${target.length} red) · skill: ${skill}\n\n${brief}\n`);
if (!args.includes("--run")) { console.log("(dry run: add --run --yes-spend-codex to let Codex try this in a separate worktree)"); process.exit(0); }
if (!args.includes("--yes-spend-codex")) { console.error("--run spends Codex usage: add --yes-spend-codex to confirm"); process.exit(2); }

const id = `improve-${skill}-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
const wt = join(HOME, "runtime", "worktrees", id);
execFileSync("git", ["-C", REPO, "worktree", "add", "-b", `afm/${id}`, wt, "HEAD"], { stdio: "inherit" });
writeFileSync(join(wt, ".improve-brief.md"), brief);
const oc = join(homedir(), ".opencode", "bin", "opencode");
// --auto: a non-interactive run cannot ask, so the codex agent's "ask" permissions are approved (its "deny" rules
// still hold); it works only inside this worktree, and nothing is merged.
const r = spawnSync(oc, ["run", "--auto", "--agent", "codex", brief], { cwd: wt, stdio: "inherit", timeout: 45 * 60_000 });
console.log(`codex exit ${r.status}`);
const test = spawnSync("npm", ["test", "--silent"], { cwd: wt, encoding: "utf8" });
const gate = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "tools/skill-eval.ts", "--repeat", "3", "--tag", id, "--baseline", latest], { cwd: wt, encoding: "utf8" });
console.log(`npm test: ${/# fail 0/.test(test.stdout) ? "pass" : "FAIL"}\n${gate.stdout.split("\n").filter((l) => /scorecard|families|baseline/.test(l)).join("\n")}`);
console.log(`\nbranch afm/${id} in ${wt} — review it; merge only if the gate shows fixes and 0 regressions.`);
