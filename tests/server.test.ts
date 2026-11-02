import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "openafm-home-"));
process.env.OPENAFM_HOME = home;
mkdirSync(join(home, "config"), { recursive: true });
writeFileSync(join(home, "config", "apfel.token"), "t".repeat(64));
const { needsEdits, render, isYes } = await import("../bin/afm-agent-server.ts");
const { isSessionId } = await import("../services/controller/opencode-session.ts");

test("hand-off mode: file-changing tasks switch to the codex agent, questions get read-only analysis", () => {
  assert.ok(needsEdits("generate_grpo.py 전체를 여러 모듈로 리팩터링해줘", "complex_multi_file_change"));
  assert.ok(needsEdits("anything", "afm_edit_failed_tests"));
  assert.ok(!needsEdits("이 저장소의 아키텍처를 설명해줘", "complex_design"));
  assert.ok(isSessionId("ses_0123456789abcdefABCD"));
  assert.ok(!isSessionId("../../etc"));
  const o: any = { status: "escalation_required", route: "FRONTIER_GPT", reasonCode: "complex_multi_file_change", capsule: "c", steps: [] };
  assert.match(render(o, 1, false, true, true, true), /편집 가능한 codex 에이전트/);
  assert.match(render(o, 1, false, true, true, false), /`전환`이라고 답하세요/);
  assert.match(render(o, 1, false, true, false, true), /에이전트를 \*\*codex\*\*로 바꿔 주세요/);   // 1.x CLI: no session id
  assert.ok(isYes("예"));
});
