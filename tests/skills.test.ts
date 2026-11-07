import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const { loadRegistry, validateManifest, SKILLS_DIR } = await import("../services/skills/registry.ts");
const { languageOf, replyLanguage, citedPathsExist } = await import("../services/skills/checks.ts");
const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

test("skill registry: the repository's skills load with no errors", () => {
  const r = loadRegistry();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.skills.map((s) => s.id).sort(), ["code", "convert", "core", "files", "frontier", "git", "mac", "personal", "security", "server", "shortcuts", "web", "writing"]);
});

test("skill registry: every reason code the controller can emit is owned by exactly one skill", () => {
  const r = loadRegistry();
  const codes = new Set<string>();
  const ctl = src("services/controller/controller.ts"), dec = src("services/laya-router/decision.ts"), ls = src("services/controller/local-skills.ts");
  for (const m of ctl.matchAll(/reasonCode(?: = |: )"([a-z_]+)"/g)) codes.add(m[1]);
  for (const m of ctl.matchAll(/"(decima_code_hard|algorithmic_code|unverifiable_code)"/g)) codes.add(m[1]);
  for (const m of dec.matchAll(/d\("[A-Z_]+", "([a-z_]+)"\)/g)) codes.add(m[1]);
  // built codes: local_<skill>, local_<task type>, local_job_<action>, decima_<route>, complex_<type>
  const skills = /export type LocalSkill = ([^;]+);/.exec(ls)![1].match(/"([a-z_]+)"/g)!.map((s) => s.slice(1, -1));
  for (const s of skills) codes.add(`local_${s}`);
  for (const t of ["error_summary", "code_explain", "diff_summary", "small_edit", "document_overview", "document_question", "other"]) codes.add(`local_${t}`);
  for (const a of ["apply", "review", "discard", "run"]) codes.add(`local_job_${a}`);
  for (const a of ["LOCAL_AFM", "FRONTIER_GPT", "FRONTIER_CLAUDE", "RUN_VERIFICATION", "ASK_USER"]) codes.add(`decima_${a.toLowerCase()}`);
  codes.add("complex_design"); codes.add("complex_multi_file_change");
  // any other code built from a template (`afm_answer_${failure}`) must have an owner for its prefix
  const enumerated = new Set(["local_", "local_job_", "decima_", "complex_"]);
  for (const m of ctl.matchAll(/`([a-z_]+_)\$\{/g)) if (!enumerated.has(m[1])) codes.add(`${m[1]}x`);
  assert.ok(codes.size > 50, `found ${codes.size} codes`);
  const unowned = [...codes].filter((c) => !r.ownerOf(c));
  assert.deepEqual(unowned, [], "add these reason codes to a skill's reasonCodes");
});

test("skill contract: the rules between capabilities, lanes and egress", () => {
  const ok = { id: "demo", version: "0.1.0", contract: "1.1", description: "A demo skill for the tests.", examples: ["a", "b"], reasonCodes: ["demo_x"], capabilities: ["read"], lane: "contained", egress: "none", checks: ["reply_language"] };
  assert.deepEqual(validateManifest(ok), []);
  assert.match(validateManifest({ ...ok, capabilities: ["read", "frontier"] }).join(), /frontier needs egress "capsule"/);
  assert.match(validateManifest({ ...ok, capabilities: ["read", "network"] }).join(), /network needs egress/);
  assert.match(validateManifest({ ...ok, egress: "query" }).join(), /without network or frontier/);
  assert.match(validateManifest({ ...ok, lane: "irreversible", capabilities: ["read", "run_approved"] }).join(), /no automatic lane/);
  assert.match(validateManifest({ ...ok, checks: ["looks_good"] }).join(), /unknown check/);
  assert.match(validateManifest({ ...ok, contract: "2.0" }).join(), /contract major/);
  assert.match(validateManifest({ ...ok, capabilities: ["read", "job"] }, true).join(), /third-party skills may only read and propose/);
});

test("skill registry: a third-party skill that clashes or overreaches is reported and the rest still load", () => {
  const extra = mkdtempSync(join(tmpdir(), "skills-d-"));
  const put = (id: string, m: object) => { mkdirSync(join(extra, id)); writeFileSync(join(extra, id, "skill.json"), JSON.stringify(m)); };
  put("greedy", { id: "greedy", version: "0.1.0", contract: "1.0", description: "Wants to start jobs.", examples: ["a", "b"], reasonCodes: ["greedy_x"], capabilities: ["read", "job"], lane: "wide", egress: "none", checks: [] });
  put("clash", { id: "clash", version: "0.1.0", contract: "1.0", description: "Claims a core code.", examples: ["a", "b"], reasonCodes: ["local_other"], capabilities: ["read"], lane: "contained", egress: "none", checks: [] });
  const r = loadRegistry(SKILLS_DIR, [extra]);
  assert.ok(r.errors.some((e) => /greedy: third-party/.test(e)));
  assert.ok(r.errors.some((e) => /local_other .*owned by both/.test(e)));
  assert.ok(!r.skills.some((s) => s.id === "greedy"));
  assert.equal(r.skills.filter((s) => !s.thirdParty).length, 13);
});

test("skills folder: manifests and public cases carry no personal paths", () => {
  const bad: string[] = [];
  // home paths and this machine's user name (read at run time, so no name is written here)
  const PERSONAL = new RegExp(["/Users/", userInfo().username].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  const walk = (d: string) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.isDirectory()) walk(p); else if (PERSONAL.test(readFileSync(p, "utf8"))) bad.push(p); } };
  walk(SKILLS_DIR);
  assert.deepEqual(bad, []);
});

test("checks: reply language ignores paths, quotes and code", () => {
  assert.equal(languageOf("Find the PDF in ~/Desktop/연구 자료/논문 about Sparse Attention please"), "en");
  assert.equal(languageOf("연구 자료 폴더에서 Sparse Attention 논문 찾아줘"), "ko");
  assert.equal(languageOf("`ok`"), undefined);
  assert.equal(replyLanguage("What is the current branch?", "현재 브랜치는 `main`이에요. 최근 커밋은 세 개예요.").ok, false);
  assert.equal(replyLanguage("What is the current branch?", "The current branch is `main`.").ok, true);
});

test("checks: cited paths must exist", () => {
  const root = mkdtempSync(join(tmpdir(), "cite-"));
  writeFileSync(join(root, "a.py"), "");
  assert.equal(citedPathsExist("See `a.py:3` and `src/b.ts`.", root).ok, false);
  assert.equal(citedPathsExist("See `a.py:3`.", root).ok, true);
  // a branch of the repository is not a missing path
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal(citedPathsExist("On `main`, tracking `origin/main`.", root).ok, true);
  assert.equal(citedPathsExist("See `origin/nope`.", root).ok, false);
});

test("language contract: the request's own words decide; masked parts survive a translation or it is dropped", async () => {
  const { requestLanguage, mask, unmask, fitLanguage } = await import("../services/skills/language.ts");
  assert.equal(requestLanguage("Find the PDF in ~/Desktop/연구 자료 about Sparse Attention"), "en");
  assert.equal(requestLanguage("터미널 열어줘"), "ko");   // short: any Hangul, as before
  assert.equal(requestLanguage("ls"), "en");
  const m = mask("See `src/a.py` and https://x.y/z, 42 files, by Jordan Lee-Moreno.", "ko");
  assert.ok(m.parts.includes("`src/a.py`") && m.parts.includes("42") && m.parts.includes("Jordan"));
  assert.equal(unmask(m.masked, m.parts), "See `src/a.py` and https://x.y/z, 42 files, by Jordan Lee-Moreno.");
  assert.equal(unmask(m.masked.replace("⟦0⟧", ""), m.parts), undefined);
  const fake = (out: (u: string) => string) => ({ name: "fake", generate: async (r: any) => ({ ok: true, json: { text: out(r.user) }, latencyMs: 1 }) }) as any;
  const en = "The current branch is `main` and there are 3 uncommitted files in the project folder.";
  // a faithful translation (tokens kept) replaces the answer; the footer stays
  const ok = await fitLanguage(fake((u) => `현재 브랜치는 ${u.match(/⟦\d+⟧/g)![0]}이고 프로젝트 폴더에 커밋하지 않은 파일이 ${u.match(/⟦\d+⟧/g)![1]}개 있어요.`), `${en}\n\n— AFM controller · LOCAL_AFM · x`, "ko");
  assert.equal(ok.why, "translated"); assert.match(ok.text!, /`main`.*3개/); assert.match(ok.text!, /— AFM controller · LOCAL_AFM · x$/);
  // a translation that drops a token is not used
  const lost = await fitLanguage(fake(() => "현재 브랜치는 메인이고 파일이 세 개 있어요. 프로젝트 폴더에 있어요."), en, "ko");
  assert.equal(lost.why, "lost_parts"); assert.equal(lost.text, undefined);
  assert.equal((await fitLanguage(fake((u) => u), en, "en")).why, "same");
});

test("find frame: topic, content cue and names from the request's structure, any topic, both languages", async () => {
  const { findFrame, isFindRequest } = await import("../services/context-builder/finder.ts");
  const f = findFrame("Find the research paper pdf file about Graph Rewiring in the content, and suggest the link.");
  assert.equal(f.topic, "Graph Rewiring"); assert.equal(f.content, true); assert.deepEqual(f.names, ["Graph Rewiring", "GraphRewiring"]);
  assert.equal(findFrame("Sparse Mixture 관련 논문 찾아줘").topic, "Sparse Mixture");
  assert.equal(findFrame("Sparse Mixture가 언급된 PDF 찾아줘").topic, "Sparse Mixture");
  assert.equal(findFrame("연구 자료 폴더에서 Sparse Mixture에 대한 PDF 찾아줘").topic, "Sparse Mixture");
  // names as before when there is no topic
  assert.deepEqual(findFrame("예산.xlsx 파일 어디 있어?").names, ["예산.xlsx"]);
  assert.deepEqual(findFrame("find .cache folder").names, [".cache"]);
  assert.equal(findFrame("find report.pdf").topic, undefined);
  assert.ok(isFindRequest("Which file mentions Graph Rewiring in its content?"));
  assert.ok(!isFindRequest("Which file defines compute_total?"));
});

test("language: identifiers do not count; CamelCase names are kept through a translation", async () => {
  const { languageOf, mask } = await import("../services/skills/language.ts");
  assert.equal(languageOf("services 폴더에 afm-adapter/, context-builder/, controller/, laya-router/, memory/ 가 있고 각각 역할이 달라요."), "ko");
  assert.equal(languageOf("The services folder has afm-adapter/ and context-builder/ with different roles."), "en");
  const m = mask("OnBud wraps GitHub Copilot and Apple's model; Lee-Moreno wrote it.", "ko");
  for (const n of ["OnBud", "GitHub", "Copilot", "Lee-Moreno"]) assert.ok(m.parts.includes(n), n);
});

test("language: markdown table rows are kept whole in a translation", async () => {
  const { mask, unmask } = await import("../services/skills/language.ts");
  const t = "Two files changed.\n\n| file | change |\n|---|---|\n| `src/text.py` | split on whitespace |\n\nDone.";
  const m = mask(t, "ko");
  assert.ok(m.parts.includes("| `src/text.py` | split on whitespace |") && m.parts.includes("|---|---|"));
  assert.equal(unmask(m.masked, m.parts), t);
});

test("router: entries come from the manifests; a pick must meet the skill's own conditions", async () => {
  const { entriesOf } = await import("../services/skills/router.ts");
  const { routedSkillApplies } = await import("../services/controller/local-skills.ts");
  const ids = entriesOf().map((e) => e.id);
  const ls = readFileSync(join(import.meta.dirname, "..", "services/controller/local-skills.ts"), "utf8");
  const all = /export type LocalSkill = ([^;]+);/.exec(ls)![1].match(/"([a-z_]+)"/g)!.map((s) => s.slice(1, -1));
  assert.deepEqual([...ids].sort(), [...all].sort(), "every local skill has router entries, and only those");
  assert.equal(routedSkillApplies("docstrings", "What does this project do?", []), false);
  assert.equal(routedSkillApplies("docstrings", "add docs", [{ path: "a.py" }]), true);
  assert.equal(routedSkillApplies("commit_message", "How do I write a commit message?", []), false);
  assert.equal(routedSkillApplies("mac_health", "Check the health of my Mac.", []), true);
});

test("skill switches: personal data skills are off until enabled; any skill can be disabled", async () => {
  const { mkdtempSync: md, mkdirSync: mk, writeFileSync: w } = await import("node:fs");
  const home = md(join(tmpdir(), "home-")); mk(join(home, "config"));
  const prev = process.env.ONBUD_HOME; process.env.ONBUD_HOME = home;
  const { enabled } = await import("../services/skills/settings.ts");
  try {
    assert.equal(enabled("personal"), false); assert.equal(enabled("mac"), true);
    w(join(home, "config", "skills.json"), JSON.stringify({ enabled: ["personal"], disabled: ["web"] }));
    assert.equal(enabled("personal"), true); assert.equal(enabled("web"), false);
  } finally { if (prev === undefined) delete process.env.ONBUD_HOME; else process.env.ONBUD_HOME = prev; }
});

test("language: nine languages by script and function words; English text stays English", async () => {
  const { languageOf, requestLanguage } = await import("../services/skills/language.ts");
  const cases: [string, string][] = [["What files are in the docs folder?", "en"], ["docs 폴더에 어떤 파일이 있어?", "ko"], ["docs フォルダーにはどんなファイルがありますか？", "ja"],
    ["docs 文件夹里有哪些文件？", "zh"], ["¿Qué archivos hay en la carpeta docs?", "es"], ["Quels fichiers sont dans le dossier docs ?", "fr"],
    ["Welche Dateien sind im Ordner docs?", "de"], ["Quais arquivos estão na pasta docs?", "pt"], ["Quali file ci sono nella cartella docs?", "it"],
    ["There is no file named die.py in the folder, I was told.", "en"], ["Am I ahead or behind origin? What should I do before pushing?", "en"], ["La cartella services contiene i seguenti file", "it"], ["Run the tests and fix the failures in parser.py", "en"]];
  for (const [t, l] of cases) assert.equal(languageOf(t), l, t);
  assert.equal(requestLanguage("報告書.pdf"), "zh");
});

test("graph: independent nodes run together; a failed check returns that unit only, at most three times", async () => {
  const { runGraph, MAX_ATTEMPTS } = await import("../services/skills/graph.ts");
  const order: string[] = [];
  let tries = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const g = await runGraph([
    { id: "a", kind: "code", run: async () => { order.push("a+"); await sleep(30); order.push("a-"); return 1; } },
    { id: "b", kind: "code", run: async () => { order.push("b+"); await sleep(30); order.push("b-"); return 2; } },
    { id: "c", kind: "worker", deps: ["a", "b"], run: async (i, back) => { tries++; return (i.a as number) + (i.b as number) + (back ? 10 : 0); }, check: (o) => ({ ok: o > 10, reason: "too small", evidence: `got ${o}` }) },
    { id: "d", kind: "worker", run: async () => 0, check: () => ({ ok: false, reason: "never" }) },
    { id: "e", kind: "gate", deps: ["d"], run: async () => "unreachable" },
  ]);
  assert.deepEqual(order.slice(0, 2).sort(), ["a+", "b+"]);   // both started before either finished
  assert.equal(g.outputs.c, 13); assert.equal(tries, 2);
  const rec = Object.fromEntries(g.record.map((r) => [r.id, r]));
  assert.equal(rec.d.status, "failed"); assert.equal(rec.d.attempts, MAX_ATTEMPTS);
  assert.equal(rec.e.status, "skipped");
  assert.equal(rec.a.status, "done");   // a correct unit is not redone
});

test("job graph: edges only where a file or the tests cross", async () => {
  const { jobGraph } = await import("../services/controller/jobs.ts");
  const job = { steps: [
    { n: 1, action: "edit_file", path: "a.py", notes: [], status: "done" }, { n: 2, action: "edit_file", path: "b.py", notes: ["attempt 1 failed — x"], status: "done" },
    { n: 3, action: "edit_file", path: "a.py", notes: [], status: "done" }, { n: 4, action: "create_file", path: "tests/test_a.py", notes: [], status: "done" },
    { n: 5, action: "run_tests", notes: [], status: "done" }] } as any;
  const g = Object.fromEntries(jobGraph(job).nodes.map((n) => [n.id, n]));
  assert.deepEqual(g.s2.deps, []); assert.deepEqual(g.s3.deps, ["s1"]); assert.deepEqual(g.s4.deps, ["s1", "s2", "s3"]);
  assert.deepEqual(g.s5.deps, ["s1", "s2", "s3", "s4"]); assert.equal(g.s2.attempts, 2);
});

test("strategy memory: generalised plans per skill, a window, contrast recall, reds count against recalled plans", async () => {
  const { mkdtempSync: md } = await import("node:fs");
  process.env.ONBUD_STRATEGY_DB = join(md(join(tmpdir(), "strat-")), "s.sqlite");
  const { recordStrategy, recallStrategy, strategyOutcome, generalise, WINDOW } = await import("../services/skills/strategy.ts");
  try {
    assert.equal(generalise("add parse_date to src/util/dates.py and test 3 cases with 'x'"), "add parse_date to <path> and test <n> cases with <q>");
    recordStrategy("code", "add a slugify function to text.py with tests", "1. insert text.py: slugify; 2. create_file tests/test_text.py; 3. run_tests", "green", "copilot");
    recordStrategy("code", "add a word_count function to text.py with tests", "1. edit_file text.py: rewrite everything", "red", "afm");
    recordStrategy("writing", "add a related work section", "1. create_file related.tex", "green", "afm");
    const r = recallStrategy("code", "add a reverse_words function to strings.py with tests")!;
    assert.match(r.text, /^WORKED for .*insert <file>/m); assert.match(r.text, /^FAILED for .*rewrite everything/m);
    assert.ok(!/related/.test(r.text)); assert.ok(r.text.length <= 600);
    assert.equal(recallStrategy("code", "fix the login redirect bug"), undefined);
    strategyOutcome(r.ids, "red"); strategyOutcome(r.ids, "red");
    recordStrategy("code", "x", "y", "green", "afm");   // pruning runs on write
    assert.equal(recallStrategy("code", "add a reverse_words function to strings.py with tests"), undefined);
    for (let i = 0; i < WINDOW + 5; i++) recordStrategy("code", `task ${i}`, "plan", "green", "afm");
  } finally { delete process.env.ONBUD_STRATEGY_DB; }
});

test("skill switches apply to stage skills too: web turned off answers how to turn it on", async () => {
  const { mkdtempSync: md, mkdirSync: mk, writeFileSync: w } = await import("node:fs");
  const home = md(join(tmpdir(), "home-")); mk(join(home, "config"));
  w(join(home, "config", "skills.json"), JSON.stringify({ disabled: ["web"] }));
  const prev = process.env.ONBUD_HOME; process.env.ONBUD_HOME = home;
  try {
    const { Controller } = await import("../services/controller/controller.ts");
    const fake = { name: "f", generate: async () => ({ ok: false, failure: "x", latencyMs: 1 }), health: async () => ({ ok: true }) } as any;
    const o = await new Controller({ afm: fake }).handle({ prompt: "Search the web for the SearXNG JSON API" });
    assert.equal(o.reasonCode, "skill_disabled"); assert.match(o.answer ?? "", /turned off/);
  } finally { if (prev === undefined) delete process.env.ONBUD_HOME; else process.env.ONBUD_HOME = prev; }
});

test("language: a long answer may lose a fifth of its names in translation, never code, paths or a short answer's name", async () => {
  const { mask, unmask } = await import("../services/skills/language.ts");
  const long = mask("OnBud wraps Apple Foundation Models on Macs, with Spotlight and OpenCode. See `src/a.py`.", "ko");
  const t = long.masked.replace(/⟦\d+⟧/g, (m) => m);
  const lostName = t.replace(`⟦${long.parts.indexOf("Macs")}⟧`, "맥");
  assert.ok(unmask(lostName, long.parts, long.names));
  const lostCode = t.replace(`⟦${long.parts.indexOf("`src/a.py`")}⟧`, "");
  assert.equal(unmask(lostCode, long.parts, long.names), undefined);
  const short = mask("Jordan Lee-Moreno signed it.", "ko");
  assert.equal(unmask(short.masked.replace("⟦0⟧", "파이널"), short.parts, short.names), undefined);
});

test("skill contract 1.2: capability and egress \"remote\" go together", () => {
  const ok = { id: "demo", version: "0.1.0", contract: "1.2", description: "A demo skill for the tests.", examples: ["a", "b"], reasonCodes: ["demo_x"], capabilities: ["read", "remote"], lane: "contained", egress: "remote", checks: ["reply_language"] };
  assert.deepEqual(validateManifest(ok), []);
  assert.match(validateManifest({ ...ok, egress: "none" }).join(), /"remote" go together/);
  assert.match(validateManifest({ ...ok, capabilities: ["read"] }).join(), /"remote" go together/);
  assert.match(validateManifest({ ...ok, private: true }).join(), /private skill cannot send/);
});
