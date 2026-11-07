// Fixed, seeded benchmark subsets shared by every setting here and by the server kit (same ids everywhere).
// usage: node --experimental-strip-types tools/bench/make-subsets.ts
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const D = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "bench", "code");
const OUT = new URL("./subsets/", import.meta.url).pathname;
const jsonl = (f: string) => readFileSync(join(D, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let seed = 20261030;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const sample = <T,>(xs: T[], n: number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

const he = jsonl("humaneval.jsonl").map((p) => p.task_id);
const heSub = sample(he, 40).sort((a, b) => Number(a.split("/")[1]) - Number(b.split("/")[1]));
const lcb = jsonl("lcb.jsonl");
const lcbSub = ["easy", "medium", "hard"].flatMap((d) => sample(lcb.filter((p) => p.difficulty === d), 10)).map((p) => p.id);
const STD = new Set(readFileSync(new URL("./stdlib-modules.txt", import.meta.url), "utf8").split(/\s+/).filter(Boolean));
const libsOf = (s: any) => (Array.isArray(s) ? s : JSON.parse(String(s).replace(/'/g, '"')));
// The task's declared libs AND every module its test code imports must be standard library.
const testImports = (t: string) => [...t.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
const bcb = jsonl("bcb-hard.jsonl").filter((p) => libsOf(p.libs).every((l: string) => STD.has(l)) && testImports(p.test).every((l) => STD.has(l)));
const bcbSub = sample(bcb, 25).map((p) => p.task_id).sort();
const meta = { created: "2026-10-30", seed: 20261030, note: "Same ids for every setting and for the server kit. LCB = release v6 (test6.jsonl) sample of 60 by difficulty, then 10/10/10. BCB = v0.1.4 hard, stdlib-only tasks." };
writeFileSync(join(OUT, "humaneval-40.json"), JSON.stringify({ ...meta, benchmark: "openai_humaneval", ids: heSub }, null, 1));
writeFileSync(join(OUT, "lcb-v6-30.json"), JSON.stringify({ ...meta, benchmark: "livecodebench/code_generation_lite release_v6", ids: lcbSub, dates: lcb.filter((p) => lcbSub.includes(p.id)).map((p) => p.date).sort().filter((_, i, a) => i === 0 || i === a.length - 1) }, null, 1));
writeFileSync(join(OUT, "bcb-hard-stdlib.json"), JSON.stringify({ ...meta, benchmark: "bigcode/bigcodebench-hard v0.1.4", ids: bcbSub, stdlib_only_of_148: bcb.length }, null, 1));
console.log(`humaneval ${heSub.length}, lcb ${lcbSub.length}, bcb-hard stdlib ${bcbSub.length} (of ${bcb.length} stdlib-only)`);
