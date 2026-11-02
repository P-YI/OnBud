// Measure Codex (GPT-6.1 Sol via OpenCode) tokens per call for each benchmark type, on a small sample,
// to turn call counts into API-equivalent cost. usage: node --experimental-strip-types --experimental-sqlite tools/bench/measure-codex-tokens.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexIn } from "./codex-session.ts";
const B = join(homedir(), "OpenAFM", "runtime", "bench");
const jsonl = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sub = (f: string) => new Set(JSON.parse(readFileSync(new URL(`./subsets/${f}`, import.meta.url), "utf8")).ids);
const he = jsonl(join(B, "code/humaneval.jsonl")).filter((p) => sub("humaneval-40.json").has(p.task_id)).slice(0, 3).map((p) => p.prompt);
const lcbAll = jsonl(join(B, "code/lcb.jsonl")).filter((p) => sub("lcb-v6-30.json").has(p.id));
const lcb = ["easy", "medium", "hard"].map((d) => lcbAll.find((p) => p.difficulty === d)).map((p) => `${p.content}\n\n${p.starter ? `Starter code:\n${p.starter}` : "Read from standard input and write to standard output."}`);
const bcb = jsonl(join(B, "code/bcb-hard.jsonl")).filter((p) => sub("bcb-hard-stdlib.json").has(p.task_id)).slice(0, 3).map((p) => p.complete_prompt);
const dir = join(B, "tmp-cost"); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const out: Record<string, any[]> = {};
for (const [kind, prompts] of [["humaneval", he], ["lcb", lcb], ["bcb", bcb]] as const) {
  for (const p of prompts) {
    const r = await codexIn(dir, `Write complete Python code for this task. Reply with only one python code block.\n\n${p}`, { title: `cost ${kind}` });
    (out[kind] ??= []).push({ ms: r.ms, ...r.tokens });
    console.log(kind, Math.round(r.ms / 1000) + "s", JSON.stringify(r.tokens));
  }
}
// Own-suite style: a document question and a small edit with tests.
const arch = join(homedir(), "Desktop", "MyResearch", "Archive");
for (const q of ["Top Reviewer 문서에서 편지를 발송한 주체가 누구야?", "kcc2026_final.pdf는 몇 쪽이야?"]) {
  const r = await codexIn(arch, q, { title: "cost own" }); (out.own ??= []).push({ ms: r.ms, ...r.tokens }); console.log("own", Math.round(r.ms / 1000) + "s", JSON.stringify(r.tokens));
}
rmSync(dir, { recursive: true, force: true });
writeFileSync(join(B, "codex-tokens.json"), JSON.stringify({ measured: new Date().toISOString(), model: "openai/gpt-6.1-sol (medium)", samples: out }, null, 1));
console.log("written", join(B, "codex-tokens.json"));
process.exit(0);
