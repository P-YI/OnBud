// The code skill's difficulty classifier: is a contest-style problem easy enough for Copilot to write?
// Weights: skills/code/difficulty.json, trained by tools/code-difficulty/train.py on DeepMind CodeContests
// (CC BY 4.0; ratings as labels, weights only). Features mirror the training script exactly.
// Measured 2026-11-08 (no Codex calls): AUC on LiveCodeBench difficulty 0.86 (dev split) and 0.92 (the old test
// split), 0.81 on "Copilot solved it locally" (dev logs); Decima's code-difficulty question scored 0.42–0.59 and
// AFM's 1–5 rating 0.65–0.67 on the same problems.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const MIN_WORDS = 60;   // words + bigrams; the shortest of the 120 LCB statements has 95
interface Model { dim: number; threshold: number; weights: number[] }
let model: Model | null | undefined;
function load(): Model | null {
  if (model === undefined) {
    try { model = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "code", "difficulty.json"), "utf8")); }
    catch { model = null; }
  }
  return model ?? null;
}

function words(text: string): string[] {
  const w = text.toLowerCase().replace(/\$[^$]*\$/g, " ").match(/[a-z]{3,}/g) ?? [];
  return [...w, ...w.slice(1).map((b, i) => `${w[i]}_${b}`)];
}

function maxExp(text: string): number {
  const c = text.includes("onstraints") ? text.split("onstraints").pop()! : text;
  const e = [...c.matchAll(/10\^\{?\s*(\d+)/g)].map((m) => Number(m[1]));
  const n = [...c.matchAll(/(?:\\leq?|≤|<=)\s*([\d,]{2,})/g)].map((m) => m[1].replaceAll(",", "").length - 1);
  return Math.min(Math.max(0, ...e, ...n), 18);
}

/** The classifier's score (higher = easier); undefined when the weights are missing. */
export function easyScore(text: string): number | undefined {
  const m = load();
  if (!m) return undefined;
  const x = new Float64Array(m.dim + 4);
  for (const w of words(text)) x[crc32(w) % m.dim] += 1;
  let n = 0;
  for (let i = 0; i < m.dim; i++) n += x[i] * x[i];
  n = Math.sqrt(n);
  if (n) for (let i = 0; i < m.dim; i++) x[i] /= n;
  const me = maxExp(text);
  x.set([Math.log([...text].length + 1) / 8, me / 18, me >= 5 ? 1 : 0, 1], m.dim);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * m.weights[i];
  return s;
}

/** Easy (Copilot first) when the score reaches the threshold chosen on the development split. Undefined without
 *  weights, and for short or mostly non-English requests (the training statements are English problem texts of
 *  a few hundred words; a two-line Korean request has too few features to score). */
export function easyContest(text: string): boolean | undefined {
  if (words(text).length < MIN_WORDS) return undefined;
  const s = easyScore(text), m = load();
  return s === undefined || !m ? undefined : s >= m.threshold;
}
