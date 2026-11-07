// Skill evals (2026-11-06, docs/skills-plan.md §7): runs each skill's cases through the controller and scores
// them with programmatic checks only (services/skills/checks.ts). The gate for every change: a case green in
// the baseline must stay green.
//   cases   skills/<id>/evals/cases.jsonl (public: this repository or no folder; no personal paths)
//           ~/OnBud/runtime/evals/private/*.jsonl with --private (real files on this Mac; never committed)
//   safety  readOnly (no apps opened, no jobs started), allowFrontier false (an escalation is recorded, not
//           sent), ONBUD_BENCH=1 (log lines marked, left out of calibration), memory off
//   output  ~/OnBud/runtime/bench/skills/results-<tag>-<time>.jsonl and a scorecard per skill
// usage: node --experimental-strip-types --experimental-sqlite --no-warnings tools/skill-eval.ts
//          [--only files,core] [--case id] [--private] [--tag t] [--repeat 3] [--baseline results.jsonl]
//   --repeat: AFM's answers vary between runs; a case is green when most of its runs are (use 3 for the gate)
// Case: {"id", "family"? (paraphrases of one ability, judged together), "act"? (run with readOnly off: only for
//        cases whose effect stays in a fixture or stops at an approval), "cwd"? ("fixture": the fixture folder is
//        the project instead of the home folder), "q", "root": "repo"|"home"|"none"|"fixture:<name>", "history"?: [[user, assistant]...],
//        "expect": {"skill"?, "reasonCode"? (regex), "status"? (regex), "answer"? (regex), "notAnswer"? (regex),
//                   "lang"?: "ko"|"en"|"any", "cited"?: false, "latencyMs"?}}
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k: string, d = "") => (args.includes(k) ? args[args.indexOf(k) + 1] ?? d : d);
Object.assign(process.env, { ONBUD_BENCH: "1", ONBUD_MEMORY: "off" });
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const { loadRegistry, SKILLS_DIR } = await import("../services/skills/registry.ts");
const { replyLanguage, languageOf, citedPathsExist, noFrontier, withinLatency } = await import("../services/skills/checks.ts");
const { ApfelProvider } = await import("../services/afm-adapter/apfel.ts");
const { Controller } = await import("../services/controller/controller.ts");

interface Case { id: string; family?: string; act?: boolean; cwd?: "fixture"; q: string; root?: "repo" | "home" | "none" | `fixture:${string}`; history?: [string, string][]; private?: boolean;
  expect: { skill?: string; reasonCode?: string; status?: string; answer?: string; notAnswer?: string; lang?: string; langStrict?: boolean; cited?: boolean; latencyMs?: number } }

const reg = loadRegistry();
if (reg.errors.length) { console.error("skill registry errors:\n  " + reg.errors.join("\n  ")); process.exit(2); }
const only = opt("--only").split(",").filter(Boolean);
const caseId = opt("--case");
const cases: (Case & { pack: string })[] = [];
const readCases = (file: string, pack: string, priv: boolean) => {
  for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim() || line.startsWith("//")) continue;
    try { const c = JSON.parse(line) as Case; cases.push({ ...c, private: priv || c.private, pack: c.expect?.skill ?? pack }); }
    catch (e) { console.error(`${file}:${i + 1}: ${(e as Error).message}`); process.exit(2); }
  }
};
for (const s of reg.skills) { const f = join(SKILLS_DIR, s.id, "evals", "cases.jsonl"); if (existsSync(f)) readCases(f, s.id, false); }
const PRIV = join(HOME, "runtime", "evals", "private");
if (args.includes("--private") && existsSync(PRIV)) for (const f of readdirSync(PRIV).filter((n) => n.endsWith(".jsonl"))) readCases(join(PRIV, f), "core", true);
const todo = cases.filter((c) => (!only.length || only.includes(c.pack)) && (!caseId || c.id === caseId));

const afm = new ApfelProvider({ defaultTimeoutMs: 60_000 });
let afmCalls = 0;   // per case run: the local cost
{ const gen = afm.generate.bind(afm); (afm as any).generate = (r: any) => { afmCalls++; return gen(r); }; }
const ctl = new Controller({ afm });
const outDir = join(HOME, "runtime", "bench", "skills");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const tag = opt("--tag", "dev");
const out = join(outDir, `results-${tag}-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}.jsonl`);
// Generated fixtures (public, synthetic content): built under runtime/evals/fixtures and indexed by Spotlight
// (mdimport), so file-search skills are tested on files every Mac can have. The case runs with the home folder
// as its root, as a real request would.
const { execFileSync } = await import("node:child_process");
const { writeFileSync, rmSync } = await import("node:fs");
// each fixture: a builder, and a phrase Spotlight must find in at least `n` of its files before cases run
const FIXTURES: Record<string, { build: (dir: string) => void; probe: string; n: number }> = {
  "convert-docs": { probe: "", n: 0, build: (dir) => {
    for (const [n, t] of [["part1.pdf", "Part one."], ["part2.pdf", "Part two."]]) { const f = join(dir, `${n}.txt`); writeFileSync(f, t); writeFileSync(join(dir, n), execFileSync("/usr/sbin/cupsfilter", [f], { stdio: ["ignore", "pipe", "ignore"] })); rmSync(f); }
    execFileSync("/usr/bin/sips", ["-s", "format", "png", join(dir, "part1.pdf"), "--out", join(dir, "cover.png")], { stdio: "ignore" });
    writeFileSync(join(dir, "memo.txt"), "Short memo for conversion.");
  } },
  "topic-docs": { probe: ["Velvet", "Lattice"].join(" "), n: 1, build: (dir) => {
    const T = ["Velvet", "Lattice", "Theorem"].join(" ");   // assembled, so this source file does not match it
    const txt = (name: string, body: string) => { const f = join(dir, name); writeFileSync(f, body); return f; };
    const pdf = (name: string, body: string) => { const t = txt(`${name}.txt`, body); writeFileSync(join(dir, name), execFileSync("/usr/sbin/cupsfilter", [t], { stdio: ["ignore", "pipe", "ignore"] })); rmSync(t); };
    pdf("q3_draft_b.pdf", `Notes for the reading group.\nThe ${T} states that every bounded velvet lattice has a fixed point.\nWe prove it in two steps.`);
    const t = txt("memo_k2.txt", `Meeting memo. We discussed the ${T} and the next reading.`);
    execFileSync("/usr/bin/textutil", ["-convert", "docx", "-output", join(dir, "memo_k2.docx"), t]); rmSync(t);
    pdf("velvet_lattice_poster.pdf", "Poster draft. Layout only.");
    pdf("unrelated_notes.pdf", "Groceries: bread, milk, apples.");
  } },
};
const built = new Set<string>();
function fixture(name: string): string {
  const dir = join(HOME, "runtime", "evals", "fixtures", name);
  const fx = FIXTURES[name];
  if (!fx) throw new Error(`unknown fixture ${name}`);
  if (built.has(name)) return dir;
  const indexed = () => { try { return execFileSync("/usr/bin/mdfind", ["-onlyin", dir, `kMDItemTextContent == "*${fx.probe}*"cd`], { encoding: "utf8" }).split("\n").filter(Boolean).length; } catch { return 0; } };
  if (!existsSync(dir) || indexed() < fx.n || fx.n === 0) {   // reuse an indexed copy: a fresh one takes Spotlight a while
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    fx.build(dir);
    try { execFileSync("/usr/bin/mdimport", readdirSync(dir).map((n) => join(dir, n)), { stdio: "ignore", timeout: 30_000 }); } catch { /* best effort */ }
    // wait until Spotlight finds the phrase (up to ~60 s), so a red case means the skill, not the index
    for (let i = 0; i < 30 && indexed() < fx.n; i++) execFileSync("/bin/sleep", ["2"]);
    if (indexed() < fx.n) console.error(`fixture ${name}: Spotlight has not indexed it yet; topic cases may fail for that reason`);
  }
  built.add(name);
  return dir;
}
const rootOf = (c: Case) => (c.root === "home" ? homedir() : c.root === "none" ? undefined
  : c.root?.startsWith("fixture:") ? (c.cwd === "fixture" ? fixture(c.root.slice(8)) : (fixture(c.root.slice(8)), homedir())) : REPO);

const REPEAT = Math.max(1, Number(opt("--repeat", "1")) || 1);
const results: { id: string; pack: string; ok: boolean; private?: boolean }[] = [];
for (const c of todo) {
 let passes = 0;
 for (let rep = 0; rep < REPEAT; rep++) {
  const root = rootOf(c);   // builds a fixture before the clock starts
  afmCalls = 0;
  const t0 = Date.now();
  const history = c.history?.map(([u, a]) => `User: ${u}\nAssistant: ${a}`).join("\n");
  let o: any;
  try { o = await ctl.handle({ prompt: c.q, root, history, frontEnd: "eval", allowFrontier: false, readOnly: !c.act }); }
  catch (e) { o = { status: "failed", reasonCode: `exception:${(e as Error).message.slice(0, 80)}`, answer: "", steps: [] }; }
  const ms = Date.now() - t0;
  const answer = String(o.answer ?? o.capsule ?? "");
  const code = String(o.reasonCode ?? "").replace(/:not_in_candidates$/, "");
  const owner = reg.ownerOf(code)?.id ?? "unowned";
  const e = c.expect ?? {};
  const checks: Record<string, { ok: boolean; reason: string }> = {};
  // every reason code needs an owning skill (a new controller branch without one is a contract gap)
  if (code && !code.startsWith("exception:")) checks.owned = { ok: owner !== "unowned", reason: `${code} → ${owner}` };
  if (e.skill) checks.skill = { ok: owner === e.skill, reason: `${owner} (${code})` };
  if (e.reasonCode) checks.reasonCode = { ok: new RegExp(e.reasonCode).test(code), reason: code };
  if (e.status) checks.status = { ok: new RegExp(e.status).test(o.status), reason: o.status };
  if (e.answer) checks.answer = { ok: new RegExp(e.answer, "i").test(answer), reason: e.answer };
  if (e.notAnswer) checks.notAnswer = { ok: !new RegExp(e.notAnswer, "i").test(answer), reason: e.notAnswer };
  if (e.lang !== "any") {
    if (e.lang) {
      const got = languageOf(answer);
      // strict: the reply is in that language; a reply too short to tell passes only if it has that script at all
      const script: Record<string, RegExp> = { ko: /[가-힣]/, ja: /[\u3040-\u30ff]/, zh: /[\u4e00-\u9fff]/ };
      const ok = e.langStrict ? got === e.lang || (!got && !!script[e.lang]?.test(answer)) : !got || got === e.lang;
      checks.reply_language = { ok, reason: `want ${e.lang}, answer ${got ?? "?"}` };
    }
    else checks.reply_language = replyLanguage(c.q, answer);
  }
  if (e.cited !== false) checks.cited_paths_exist = citedPathsExist(answer, root);
  checks.no_frontier = noFrontier(o);
  const budget = e.latencyMs ?? reg.skills.find((s) => s.id === c.pack)?.budget?.latencyMs;
  checks.within_latency = withinLatency(ms, budget);
  const ok = Object.values(checks).every((v) => v.ok);
  if (ok) passes++;
  // private cases: the answer is not stored (it can quote personal files), only the verdicts
  appendFileSync(out, JSON.stringify({ id: c.id, pack: c.pack, rep, private: c.private || undefined, ok, ms, afmCalls, status: o.status, reasonCode: code, owner,
    checks, answer: c.private ? undefined : answer.slice(0, 1500), steps: (o.steps ?? []).map((s: any) => s.kind) }) + "\n", { mode: 0o600 });
  console.log(`${ok ? "GREEN" : "RED  "} ${c.pack.padEnd(9)} ${c.id.padEnd(28)} ${(ms / 1000).toFixed(1)}s${REPEAT > 1 ? ` [${rep + 1}/${REPEAT}]` : ""}  ${Object.entries(checks).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.reason}`).join(" · ")}`);
 }
  const ok = passes * 2 > REPEAT;
  results.push({ id: c.id, pack: c.pack, ok, private: c.private });
  appendFileSync(out, JSON.stringify({ summary: true, id: c.id, pack: c.pack, ok, passes, runs: REPEAT }) + "\n", { mode: 0o600 });
}

const byPack = new Map<string, { n: number; ok: number }>();
for (const r of results) { const b = byPack.get(r.pack) ?? { n: 0, ok: 0 }; b.n++; if (r.ok) b.ok++; byPack.set(r.pack, b); }
console.log("\nscorecard: " + [...byPack].map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(" · ") + `   (written ${out})`);
// families: an ability passes only when every paraphrase of it does
const fam = new Map<string, boolean>();
for (const r of results) { const f = todo.find((c) => c.id === r.id)?.family; if (f) fam.set(f, (fam.get(f) ?? true) && r.ok); }
if (fam.size) console.log("families: " + [...fam].map(([k, v]) => `${k} ${v ? "GREEN" : "RED"}`).join(" · "));

// The gate: a case green in the baseline and red now is a regression.
const base = opt("--baseline");
if (base) {
  const was = new Map<string, boolean>();
  // the per-case summary lines when the baseline has them, else the single runs
  const lines = readFileSync(base, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of lines.some((x) => x.summary) ? lines.filter((x) => x.summary) : lines) was.set(r.id, r.ok);
  const regressed = results.filter((r) => was.get(r.id) === true && !r.ok).map((r) => r.id);
  const fixed = results.filter((r) => was.get(r.id) === false && r.ok).map((r) => r.id);
  console.log(`baseline: ${fixed.length} fixed${fixed.length ? ` (${fixed.join(", ")})` : ""}, ${regressed.length} regressed${regressed.length ? ` (${regressed.join(", ")})` : ""}`);
  if (regressed.length) process.exit(1);
}
