// Explicit paths (2026-11-11): a file or folder named by an absolute or ~/ path is where every skill works, even
// outside the open folder (Spotlight opens ~/Desktop); hidden folders and secret files are refused, missing files
// are reported, and an approval runs in the folder the work moved to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explicitPaths, pathProblems, scopeFor } from "../services/context-builder/explicit-paths.ts";

const home = mkdtempSync(join(tmpdir(), "onbud-paths-"));
mkdirSync(join(home, "Downloads", "My Paper"), { recursive: true });
mkdirSync(join(home, "Documents", "data"), { recursive: true });
mkdirSync(join(home, ".ssh"), { recursive: true });
writeFileSync(join(home, "Downloads", "My Paper", "notes v2.txt"), "notes");
writeFileSync(join(home, "Documents", "data", "scores.csv"), "a,b\n1,2\n");
writeFileSync(join(home, "Downloads", "server.pem"), "x");
writeFileSync(join(home, ".ssh", "config"), "Host x");

test("paths with spaces, Korean particles, quotes and absolute paths", () => {
  const p = (q: string) => explicitPaths(q, home).map((x) => x.abs.slice(home.length));
  assert.deepEqual(p("~/Downloads/My Paper/notes v2.txt 요약해줘"), ["/Downloads/My Paper/notes v2.txt"]);
  assert.deepEqual(p("~/Documents/data/scores.csv에서 b 값 알려줘"), ["/Documents/data/scores.csv"]);
  assert.deepEqual(p(`Summarize "${home}/Downloads/My Paper/notes v2.txt" please`), ["/Downloads/My Paper/notes v2.txt"]);
  assert.deepEqual(p("~/Documents/data 폴더 파일 목록"), ["/Documents/data"]);
  assert.deepEqual(p("summarize notes v2.txt"), []);
});

test("scope: a file's folder; several paths → their common folder", () => {
  const one = scopeFor(explicitPaths("~/Downloads/My Paper/notes v2.txt 요약", home))!;
  assert.equal(one.root, join(home, "Downloads", "My Paper"));
  assert.deepEqual(one.files, ["notes v2.txt"]);
  const two = scopeFor(explicitPaths("compare ~/Downloads/My Paper/notes v2.txt and ~/Documents/data/scores.csv", home))!;
  assert.equal(two.root, home);
  assert.deepEqual(two.files.sort(), ["Documents/data/scores.csv", "Downloads/My Paper/notes v2.txt"]);
  assert.equal(scopeFor([]), undefined);
});

test("hidden folders and secret files are never used; missing files are reported", () => {
  for (const q of ["Summarize ~/.ssh/config", "~/Downloads/server.pem 읽어줘"]) {
    const f = explicitPaths(q, home);
    assert.deepEqual(f, [], q);
    assert.equal(pathProblems(q, f, home).blocked.length, 1, q);
  }
  const q = "~/Downloads/nothere.txt 요약해줘";
  assert.deepEqual(pathProblems(q, explicitPaths(q, home), home), { blocked: [], missing: ["~/Downloads/nothere.txt"] });
  const ok = "~/Downloads/My Paper/notes v2.txt 요약해줘";
  assert.deepEqual(pathProblems(ok, explicitPaths(ok, home), home), { blocked: [], missing: [] });
});
