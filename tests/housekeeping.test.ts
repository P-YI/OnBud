import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { rotateLogs, readLog, pruneDocCache } = await import("../services/maintenance/housekeeping.ts");
const { openDb } = await import("../services/telemetry/db.ts");

test("rotateLogs: over the limit → .1.gz, older shift, the oldest beyond keep is dropped; the file is emptied in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-"));
  const f = join(dir, "controller.jsonl");
  for (let round = 1; round <= 4; round++) {
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => JSON.stringify({ round, i })).join("\n") + "\n");
    assert.deepEqual(rotateLogs(dir, 1000, 3), ["controller.jsonl"]);
    assert.equal(statSync(f).size, 0);
  }
  assert.ok(existsSync(`${f}.3.gz`) && !existsSync(`${f}.4.gz`));
  appendFileSync(f, JSON.stringify({ round: 5 }) + "\n");   // writers keep appending to the same path
  const rounds = readLog(f).map((l) => JSON.parse(l).round);
  assert.deepEqual([...new Set(rounds)], [2, 3, 4, 5]);   // round 1 dropped (keep 3)
  writeFileSync(join(dir, "small.log"), "x\n");
  assert.deepEqual(rotateLogs(dir, 1000, 3), []);
  assert.equal(readFileSync(join(dir, "small.log"), "utf8"), "x\n");
});

test("pruneDocCache: old rows, rows of deleted files, and rows beyond the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-db-"));
  const db = openDb(":memory:");
  const keep = join(dir, "a.pdf"); writeFileSync(keep, "x");
  const ins = db.prepare("INSERT INTO doc_cache(key, path, extracted_at, json) VALUES (?,?,?,?)");
  ins.run("old", keep, "2020-01-01T00:00:00.000Z", "{}");
  ins.run("gone", join(dir, "deleted.pdf"), new Date().toISOString(), "{}");
  for (let i = 0; i < 5; i++) ins.run(`k${i}`, keep, new Date(Date.now() - i * 1000).toISOString(), "{}");
  assert.equal(pruneDocCache(db, 90, 3), 4);   // old + gone + 2 beyond the newest 3
  assert.deepEqual((db.prepare("SELECT key FROM doc_cache ORDER BY extracted_at DESC").all() as any[]).map((r) => r.key), ["k0", "k1", "k2"]);
});
