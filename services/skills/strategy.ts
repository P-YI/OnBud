// Strategy memory (skills plan P5, 2026-11-06; after SALE, Alazraki et al., ICML 2026): per skill, the PLANS the
// planners made, with the verdict of the programmatic checks (green: the job's checks passed; red: blocked), not
// the outputs. A planner gets, for a similar task, the plans that worked and the ones that failed, as a short
// contrast (≤ 600 characters: AFM's context is small). Kept apart from context memory (memory.ts): the key is
// the skill and the task's shape, not the project, and everything is generalised (paths, names and numbers
// replaced) so a plan helps in another project. Local only; never sent to a frontier. A window of the last
// WINDOW records per skill (SALE: 10–25 tasks keep the effect); a record that was recalled and then followed by a
// red twice is dropped. ONBUD_STRATEGY=off turns it off; benchmark runs use their own file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redact } from "../security/gate.ts";

export const WINDOW = 25;
const MAX_CHARS = 600;
let db: DatabaseSync | undefined;
let dbPath = "";

function open(): DatabaseSync | undefined {
  if (process.env.ONBUD_STRATEGY === "off") return undefined;
  const home = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
  const p = process.env.ONBUD_STRATEGY_DB ?? join(home, "runtime", process.env.ONBUD_BENCH ? "bench" : "state", process.env.ONBUD_BENCH ? "strategy-bench.sqlite" : "strategy.sqlite");
  if (db && dbPath === p) return db;
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(p); dbPath = p;
  db.exec(`CREATE TABLE IF NOT EXISTS strategy (id INTEGER PRIMARY KEY, skill TEXT NOT NULL, shape TEXT NOT NULL, plan TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('green','red')), source TEXT NOT NULL, created_at TEXT NOT NULL, recalled INTEGER DEFAULT 0, red_after INTEGER DEFAULT 0)`);
  return db;
}

/** Paths, file names, quoted text, identifiers with digits and numbers replaced, secrets masked. */
export function generalise(t: string): string {
  return redact(t).text
    .replace(/["'`“”‘’][^"'`“”‘’\n]{1,80}["'`“”‘’]/g, "<q>")
    .replace(/(~|\.{0,2})?[\w.-]*\/[\w./-]+/g, "<path>")
    .replace(/\b[\w-]+\.(py|ts|js|tsx|md|tex|bib|json|ya?ml|csv|txt|pdf|docx?|pptx?|xlsx|sh|go|rs|java|c|cpp|h)\b/gi, "<file>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

const terms = (t: string) => new Set((t.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((w) => !["file", "path", "the", "and", "for", "with", "this", "that"].includes(w)));
function overlap(a: string, b: string): number {
  const A = terms(a), B = terms(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

export function recordStrategy(skill: string, shape: string, plan: string, verdict: "green" | "red", source: string): void {
  const d = open(); if (!d) return;
  d.prepare("INSERT INTO strategy (skill, shape, plan, verdict, source, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(skill, generalise(shape), generalise(plan).slice(0, 300), verdict, source, new Date().toISOString());
  d.prepare("DELETE FROM strategy WHERE skill = ? AND id NOT IN (SELECT id FROM strategy WHERE skill = ? ORDER BY id DESC LIMIT ?)").run(skill, skill, WINDOW);
  d.prepare("DELETE FROM strategy WHERE red_after >= 2").run();
}

export interface Recall { text: string; ids: number[] }
/** For a similar task (term overlap ≥ 0.3): up to two plans that worked and one that failed, as a contrast. */
export function recallStrategy(skill: string, shape: string): Recall | undefined {
  const d = open(); if (!d) return undefined;
  const g = generalise(shape);
  const rows = (d.prepare("SELECT id, shape, plan, verdict FROM strategy WHERE skill = ? ORDER BY id DESC LIMIT ?").all(skill, WINDOW) as { id: number; shape: string; plan: string; verdict: string }[])
    .map((r) => ({ ...r, sim: overlap(g, r.shape) })).filter((r) => r.sim >= 0.3).sort((a, b) => b.sim - a.sim);
  const green = rows.filter((r) => r.verdict === "green").slice(0, 2), red = rows.filter((r) => r.verdict === "red").slice(0, 1);
  if (!green.length && !red.length) return undefined;
  const lines = [...green.map((r) => `WORKED for "${r.shape.slice(0, 80)}": ${r.plan}`), ...red.map((r) => `FAILED for "${r.shape.slice(0, 80)}": ${r.plan}`)];
  let text = ""; for (const l of lines) if (text.length + l.length + 1 <= MAX_CHARS) text += (text ? "\n" : "") + l;
  const ids = [...green, ...red].map((r) => r.id);
  for (const id of ids) d.prepare("UPDATE strategy SET recalled = recalled + 1 WHERE id = ?").run(id);
  return text ? { text, ids } : undefined;
}

/** The outcome of a task that used recalled records: a red counts against them. */
export function strategyOutcome(ids: number[], verdict: "green" | "red"): void {
  const d = open(); if (!d || verdict === "green") return;
  for (const id of ids) d.prepare("UPDATE strategy SET red_after = red_after + 1 WHERE id = ?").run(id);
}
