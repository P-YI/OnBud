import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaml, loadPolicy, systemFor } from "../services/policy/policy.ts";
import { estimateTokens } from "../services/context-builder/capsule.ts";

test("yaml subset parser", () => {
  const y = parseYaml(`# c\nversion: v1\na:\n  n: 5   # inline\n  b: true\n  s: "x y"\nlist:\n  - one\n  - 2\nempty:\n`);
  assert.deepEqual(y, { version: "v1", a: { n: 5, b: true, s: "x y" }, list: ["one", 2], empty: null });
  assert.throws(() => parseYaml("not yaml at all"));
});

test("repo policy loads, maps every local task type to a skill, fits the budget", () => {
  const p = loadPolicy();
  assert.equal(p.version, "routing-v0.8");
  assert.match(p.hash, /^[0-9a-f]{12}$/);
  assert.equal(p.rules.defaultFrontier, "FRONTIER_GPT");
  for (const t of p.rules.localTypes!.filter((t) => t !== "other")) {
    const s = systemFor(p, t);
    assert.ok(s.skill, `no skill for ${t}`);
    // system prompt + skill must stay small: leave the capsule its 5500-token envelope
    assert.ok(estimateTokens(s.text) < 600, `${t} system prompt too large`);
  }
  assert.equal(systemFor(p, "other").skill, undefined);
});

test("policy hash changes when a skill changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  cpSync(new URL("../policies/", import.meta.url).pathname, dir, { recursive: true });
  const before = loadPolicy(dir).hash;
  writeFileSync(join(dir, "skills", "code-explain.md"), "changed\n");
  assert.notEqual(loadPolicy(dir).hash, before);
});

test("missing skill file is a load error, not a silent default", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  mkdirSync(join(dir, "skills"));
  writeFileSync(join(dir, "AFM.md"), "x");
  writeFileSync(join(dir, "routing.yaml"), "version: t\nskills:\n  code_explain: nope\n");
  assert.throws(() => loadPolicy(dir), /no file/);
});
