// Housekeeping (2026-11-01): keeps runtime/ from growing without bound. Run at most once a day by the controller
// (and on demand: node --experimental-strip-types services/maintenance/housekeeping.ts [--now]).
//   logs       every *.log / *.jsonl in runtime/logs over 10 MB is copied to <name>.1.gz (older ones shift to .2.gz,
//              .3.gz; the fourth is deleted) and then emptied in place. Copy-then-truncate works for every writer:
//              appendFileSync reopens the file per line, and launchd's stdout files (apfel-serve.log) are opened
//              for append, so the next write lands at the start. Lines written between the copy and the truncate
//              (milliseconds) are lost; logs only.
//   doc_cache  extracted document text: rows not used for 90 days, rows of files that no longer exist, and all but
//              the newest 1000 rows are deleted; then the WAL is checkpointed.
// readLog() reads a log together with its rotated copies, for tools that need the history (threshold calibration,
// the report).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

const RUNTIME = join(process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM"), "runtime");
export const LOG_DIR = join(RUNTIME, "logs");
const STATE = join(RUNTIME, "state", "housekeeping.json");
export const LIMITS = { logBytes: 10 * 1024 * 1024, keep: 3, cacheDays: 90, cacheRows: 1000, everyMs: 24 * 3600_000 };

/** Rotates one file if it is over `maxBytes`; returns true when it did. */
export function rotate(file: string, maxBytes = LIMITS.logBytes, keep = LIMITS.keep): boolean {
  let size = 0;
  try { size = statSync(file).size; } catch { return false; }
  if (size <= maxBytes) return false;
  rmSync(`${file}.${keep}.gz`, { force: true });
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}.gz`)) renameSync(`${file}.${i}.gz`, `${file}.${i + 1}.gz`);
  const tmp = `${file}.rotating`;
  copyFileSync(file, tmp);
  truncateSync(file, 0);
  writeFileSync(`${file}.1.gz`, gzipSync(readFileSync(tmp)), { mode: 0o600 });
  rmSync(tmp, { force: true });
  return true;
}

export function rotateLogs(dir = LOG_DIR, maxBytes = LIMITS.logBytes, keep = LIMITS.keep): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /\.(log|jsonl)$/.test(n)).filter((n) => rotate(join(dir, n), maxBytes, keep));
}

/** A log's lines, oldest first: rotated copies (.3.gz … .1.gz) then the current file. */
export function readLog(file: string, keep = LIMITS.keep): string[] {
  const parts: string[] = [];
  for (let i = keep; i >= 1; i--) { try { parts.push(gunzipSync(readFileSync(`${file}.${i}.gz`)).toString("utf8")); } catch { /* none */ } }
  try { parts.push(readFileSync(file, "utf8")); } catch { /* none */ }
  return parts.join("").split("\n").filter(Boolean);
}

/** Deletes stale document-cache rows; returns how many. */
export function pruneDocCache(db: DatabaseSync, days = LIMITS.cacheDays, maxRows = LIMITS.cacheRows): number {
  let n = 0;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  n += Number(db.prepare("DELETE FROM doc_cache WHERE extracted_at < ?").run(cutoff).changes);
  for (const r of db.prepare("SELECT key, path FROM doc_cache").all() as { key: string; path: string }[]) {
    if (!existsSync(r.path)) n += Number(db.prepare("DELETE FROM doc_cache WHERE key = ?").run(r.key).changes);
  }
  n += Number(db.prepare("DELETE FROM doc_cache WHERE key NOT IN (SELECT key FROM doc_cache ORDER BY extracted_at DESC LIMIT ?)").run(maxRows).changes);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* busy: next time */ }
  return n;
}

/** Runs both when the last run is older than a day (or `force`); never throws. */
export function housekeeping(db?: DatabaseSync, force = false): { ran: boolean; rotated: string[]; pruned: number } {
  try {
    let last = 0;
    try { last = JSON.parse(readFileSync(STATE, "utf8")).at ?? 0; } catch { /* first run */ }
    if (!force && Date.now() - last < LIMITS.everyMs) return { ran: false, rotated: [], pruned: 0 };
    mkdirSync(join(RUNTIME, "state"), { recursive: true });
    // Claim the run first, so two processes starting together do not both rotate.
    writeFileSync(STATE, JSON.stringify({ at: Date.now() }));
    const rotated = rotateLogs();
    const pruned = db ? pruneDocCache(db) : 0;
    writeFileSync(STATE, JSON.stringify({ at: Date.now(), rotated, pruned }));
    return { ran: true, rotated, pruned };
  } catch { return { ran: false, rotated: [], pruned: 0 }; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb } = await import("../telemetry/db.ts");
  console.log(housekeeping(openDb(), process.argv.includes("--now")));
}
