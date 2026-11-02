import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchCode, readSnippet, gitDiff, filterSpotlight, recentlyChanged, listDir } from "../services/context-builder/retrieval.ts";
import { renderCapsule } from "../services/context-builder/capsule.ts";
import { makeRepo } from "./helpers.ts";

const fakeKey = "sk-proj-" + "x".repeat(40);
const root = makeRepo({
  "src/metrics.py": "import sklearn.metrics as skm\n\ndef f1_macro(y, p):\n    return skm.f1_score(y, p, average='macro')\n",
  "src/train.py": "from metrics import f1_macro\nAPI_KEY = '" + fakeKey + "'\nprint(f1_macro([1], [1]))\n",
  "docs/notes.md": "f1_macro is our main metric\n",
  ".env": "OPENAI_API_KEY=" + fakeKey + "\nf1_macro=1\n",
});

test("code search finds hits, honours glob, skips secret files, redacts", async () => {
  const all = await searchCode(root, "f1_macro");
  const paths = all.map((h) => h.path);
  assert.ok(paths.includes("src/metrics.py") && paths.includes("src/train.py"));
  assert.ok(!paths.includes(".env"));
  const py = await searchCode(root, "f1_macro", { glob: "*.py" });
  assert.ok(py.every((h) => h.path.endsWith(".py")) && py.length >= 2);
  const key = await searchCode(root, "API_KEY");
  assert.ok(key.length === 1 && !key[0].text.includes(fakeKey));
  assert.deepEqual(await searchCode(root, "   "), []);
});

test("snippet: numbered, bounded, redacted, gated", () => {
  const s = readSnippet(root, "src/train.py", 1, 3);
  assert.ok(!("error" in s));
  if (!("error" in s)) {
    assert.match(s.text, /^1\| from metrics/);
    assert.ok(!s.text.includes(fakeKey));
  }
  assert.deepEqual(readSnippet(root, ".env"), { error: "blocked:secret_path" });
  assert.ok("error" in readSnippet(root, "../../etc/hosts"));
  assert.deepEqual(readSnippet(root, "nope.py"), { error: "not_found" });
});

test("git diff is bounded and redacted", async () => {
  writeFileSync(join(root, "src/metrics.py"), "TOKEN = '" + "ghp_" + "y".repeat(36) + "'\n" + "x = 1\n".repeat(300));
  const d = await gitDiff(root, { maxLines: 40 });
  assert.match(d, /src\/metrics\.py/);
  assert.match(d, /more lines/);
  assert.ok(!d.includes("ghp_" + "y".repeat(36)));
  assert.deepEqual(await recentlyChanged(root), ["docs/notes.md", "src/metrics.py", "src/train.py"].filter((p) => p !== ".env"));
});

test("spotlight results are scoped and filtered", () => {
  const got = filterSpotlight(root, [
    join(root, "docs/notes.md"), join(root, ".env"), join(root, ".opencode/plugin/x.ts"),
    join(root, "node_modules/a/b.js"), "/Users/someone/elsewhere.md", join(root, "src/metrics.py"),
  ], 10);
  assert.deepEqual(got, ["docs/notes.md", "src/metrics.py"]);
});

test("capsule keeps head and newest evidence within budget", () => {
  const evidence = Array.from({ length: 10 }, (_, i) => ({ label: `e${i}`, body: "z".repeat(900) }));
  const r = renderCapsule({ goal: "find bug in src/a.py:12", evidence }, 1000);
  assert.ok(r.tokens <= 1000);
  assert.match(r.text, /GOAL: find bug in src\/a\.py:12/);
  assert.match(r.text, /\[e9\]/);
  assert.doesNotMatch(r.text, /\[e0\]/);
  assert.ok(r.dropped > 0);
});

test("list_dir: one level, dirs first, hides dotfiles and secrets, gated", () => {
  assert.deepEqual(listDir(root, "."), ["docs/", "src/"]);
  assert.deepEqual(listDir(root, "src"), ["metrics.py", "train.py"]);
  assert.deepEqual(listDir(root, "nope"), { error: "not_found" });
  assert.ok("error" in (listDir(root, "../..") as object));
});
