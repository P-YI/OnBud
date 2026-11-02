// Dev splits for developing and tuning the system, disjoint from the test subsets (asserted below).
// usage: node --experimental-strip-types tools/bench/make-dev-subsets.ts
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const D = join(process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM"), "runtime", "bench", "code");
const S = new URL("./subsets/", import.meta.url).pathname;
const jsonl = (f: string) => readFileSync(join(D, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ids = (f: string) => new Set<string>(JSON.parse(readFileSync(join(S, f), "utf8")).ids);
let seed = 31102026;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const sample = <T,>(xs: T[], n: number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
const STD = new Set(readFileSync(new URL("./stdlib-modules.txt", import.meta.url), "utf8").split(/\s+/).filter(Boolean));
const libsOf = (s: any) => (Array.isArray(s) ? s : JSON.parse(String(s).replace(/'/g, '"')));
const testImports = (t: string) => [...t.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);

const heTest = ids("humaneval-40.json"), lcbTest = ids("lcb-v6-30.json"), bcbTest = ids("bcb-hard-stdlib.json");
const hard = new Set(jsonl("bcb-hard.jsonl").map((p) => p.task_id));
const he = sample(jsonl("humaneval.jsonl").map((p) => p.task_id).filter((i) => !heTest.has(i)), 30).sort();
const lcb = jsonl("lcb.jsonl").map((p) => p.id).filter((i) => !lcbTest.has(i));
const bcb = sample(jsonl("bcb-full.jsonl").filter((p) => !hard.has(p.task_id) && libsOf(p.libs).every((l: string) => STD.has(l)) && testImports(p.test).every((l) => STD.has(l))).map((p) => p.task_id), 25).sort();
for (const [dev, test, name] of [[he, heTest, "humaneval"], [lcb, lcbTest, "lcb"], [bcb, bcbTest, "bcb"]] as const) {
  const overlap = dev.filter((i) => test.has(i));
  if (overlap.length) throw new Error(`${name}: dev overlaps test: ${overlap.join(",")}`);
}
const meta = { created: "2026-10-31", role: "dev (never used for the final test numbers)", seed: 31102026 };
writeFileSync(join(S, "dev-humaneval-30.json"), JSON.stringify({ ...meta, benchmark: "openai_humaneval", ids: he }, null, 1));
writeFileSync(join(S, "dev-lcb-v6-30.json"), JSON.stringify({ ...meta, benchmark: "livecodebench v6 (the other half of the 60-problem sample)", ids: lcb }, null, 1));
writeFileSync(join(S, "dev-bcb-full-stdlib-25.json"), JSON.stringify({ ...meta, benchmark: "bigcode/bigcodebench v0.1.4 full, stdlib-only, Hard tasks excluded", ids: bcb }, null, 1));
console.log(`dev splits: humaneval ${he.length}, lcb ${lcb.length}, bcb-full ${bcb.length} — disjoint from the test subsets`);
