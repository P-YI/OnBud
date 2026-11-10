// Everyday requests (2026-11-09): quick answers by code, System Settings panes, Codex usage from the CLI's logs,
// and the routing fixes found by the everyday probe (help words in quoted text, English sentences read as commands,
// general questions from a personal folder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, quickAnswer } from "../services/controller/quick-answer.ts";
import { openSettingsPane, paneInstalled, settingsPaneIntent } from "../services/controller/settings-pane.ts";
import { codexUsageAnswer, codexUsageIntent, readCodexUsage } from "../services/controller/codex-usage.ts";
import { detectLocalSkill } from "../services/controller/local-skills.ts";
import { isHelpRequest } from "../services/controller/help.ts";
import { generalQuestion, shortTranslation, typedCommand } from "../services/controller/controller.ts";

test("safe arithmetic: precedence, power, percent, parentheses; anything else refused", () => {
  assert.equal(evaluate("2^20"), 1048576);
  assert.equal(evaluate("(3+4)×5"), 35);
  assert.equal(evaluate("2+3*4"), 14);
  assert.equal(evaluate("2^3^2"), 512);
  assert.equal(evaluate("-2^2"), -4);
  assert.equal(evaluate("50%*80"), 40);
  assert.equal(evaluate("process.exit()"), undefined);
  assert.equal(evaluate("1+"), undefined);
});

test("quick answers: the probe's wrong answers are right by code", () => {
  const a = (q: string) => quickAnswer(q, /[가-힣]/.test(q))?.answer ?? "";
  assert.match(a("17% of 2,340 is what?"), /397\.8/);
  assert.match(a("3시간 45분은 몇 분이야?"), /225분/);
  assert.match(a("화씨 100도는 섭씨로 몇 도야?"), /37\.78°C/);
  assert.match(a("What's 2^20?"), /1,048,576/);
  assert.match(a("5 km is how many miles?"), /3\.106856 mi/);
  assert.match(a("30평은 몇 제곱미터야?"), /99\.17/);
  assert.match(a("50000원의 15% 할인하면?"), /42,500/);
  assert.match(a("80에서 100으로 몇 퍼센트 증가야?"), /\+25%/);
});

test("quick answers: the clock uses this Mac's date", () => {
  const now = new Date(2026, 10, 9, 23, 51);   // Monday
  assert.match(quickAnswer("오늘 무슨 요일이야?", true, now)!.answer, /월요일/);
  assert.match(quickAnswer("지금 몇 시야?", true, now)!.answer, /오후 11:51/);
  assert.match(quickAnswer("내일 무슨 요일이야?", true, now)!.answer, /화요일/);
  assert.match(quickAnswer("크리스마스까지 며칠 남았어?", true, now)!.answer, /46일/);
  assert.match(quickAnswer("What's today's date?", false, now)!.answer, /Monday, November 9, 2026/);
});

test("quick answers: not for files, how-tos, phone numbers or general questions", () => {
  for (const q of ["이 PDF의 17%는?", "파이썬 3.12 설치 방법", "010-1234-5678 저장해줘", "Who wrote Pride and Prejudice?", "2026-11-09 일정", "DNS가 뭐야"])
    assert.equal(quickAnswer(q, /[가-힣]/.test(q)), undefined, q);
});

test("settings panes: the pane named, other apps' settings and toggles left alone", () => {
  assert.equal(settingsPaneIntent("설정 앱의 vpn 항목 열어줘")?.pane?.en, "VPN");
  assert.equal(settingsPaneIntent("와이파이 설정 열어줘")?.pane?.en, "Wi-Fi");
  assert.equal(settingsPaneIntent("open Bluetooth settings")?.pane?.en, "Bluetooth");
  assert.equal(settingsPaneIntent("Take me to the privacy settings")?.pane?.en, "Privacy & Security");
  assert.equal(settingsPaneIntent("Open Software Update in System Settings")?.pane?.en, "Software Update");
  assert.deepEqual(settingsPaneIntent("설정 앱의 아무거나 항목 열어줘"), {});
  for (const q of ["Open the settings app.", "VS Code 설정 열어줘", "다크 모드 켜줘", "VPN 설정 방법 알려줘", "git 설정 보여줘"]) assert.equal(settingsPaneIntent(q), undefined, q);
  assert.equal(detectLocalSkill("설정 앱의 vpn 항목 열어줘", []), "launch_app");
  assert.equal(detectLocalSkill("다크 모드 설정 열어줘", []), "launch_app");
  assert.equal(detectLocalSkill("다크 모드 켜줘", []), "mac_control");
});

test("settings panes: the pane's URL is opened (fake opener)", async () => {
  const urls: string[] = [];
  const r = await openSettingsPane("설정 앱의 vpn 항목 열어줘", true, async (u) => { urls.push(u); return true; });
  // a Mac without the VPN pane extension falls back to System Settings itself
  const installed = paneInstalled(settingsPaneIntent("vpn 설정 열어줘")!.pane!);
  assert.equal(urls[0], installed ? "x-apple.systempreferences:com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension" : "x-apple.systempreferences:");
  assert.match(r.answer, installed ? /시스템 설정 › VPN/ : /시스템 설정/);
});

test("codex usage: intent, the newest rate_limits line, and the answer", () => {
  assert.ok(codexUsageIntent("Let me know the time when the Codex token is reset."));
  assert.ok(codexUsageIntent("Codex 남은 사용량 알려줘"));
  assert.ok(!codexUsageIntent("codex로 넘겨줘"));
  assert.equal(detectLocalSkill("Codex 토큰 언제 리셋돼?", []), "copilot");
  const dir = mkdtempSync(join(tmpdir(), "onbud-codex-"));
  mkdirSync(join(dir, "2026", "11", "09"), { recursive: true });
  const line = (ts: string, used: number) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1794271053 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1794857853 }, plan_type: "plus" } } });
  writeFileSync(join(dir, "2026", "11", "09", "rollout-a.jsonl"), ["{\"x\":1}", line("2026-11-09T10:00:00.000Z", 10), line("2026-11-09T21:36:45.188Z", 20)].join("\n") + "\n");
  const u = readCodexUsage(dir)!;
  assert.equal(u.primary?.usedPercent, 20);
  assert.equal(u.plan, "plus");
  const a = codexUsageAnswer(u, true, 1794271053_000 - 51 * 60_000);
  assert.match(a.answer, /5시간/);
  assert.match(a.answer, /51분 뒤/);
  assert.match(a.answer, /7일/);
  assert.equal(codexUsageAnswer(undefined, false).verified, false);
});

test("routing fixes from the everyday probe", () => {
  assert.ok(!isHelpRequest("Translate 'thank you for your help' into Japanese."));
  assert.ok(isHelpRequest("git 명령어 알려줘"));
  assert.equal(typedCommand("Write a short polite email declining a meeting tomorrow."), undefined);
  // a how-to is answered (the shortcut), never executed (no screenshot proposed)
  assert.equal(detectLocalSkill("How do I take a screenshot of one window on Mac?", []), "quick_answer");
  assert.match(quickAnswer("맥에서 앱 강제 종료 단축키 알려줘", true)!.answer, /⌥⌘⎋/);
  assert.equal(detectLocalSkill("스크린샷 찍어줘", []), "mac_control");
  assert.ok(isHelpRequest("Summarize what I can do with OnBud."));
  assert.equal(detectLocalSkill("우리 집 와이파이 비밀번호 알려줘", []), "launch_app");
  assert.ok(generalQuestion("Who wrote Pride and Prejudice?"));
  assert.ok(generalQuestion("DNS가 뭔지 한 줄로 설명해줘"));
  for (const q of ["Desktop에 있는 PDF 목록 보여줘", "최근 다운로드한 파일 뭐야?", "내 이력서에서 학력 알려줘", "report.pdf 요약해줘"]) assert.ok(!generalQuestion(q), q);
});

test("short translations: the quoted text and the target language", () => {
  assert.deepEqual({ ...shortTranslation("Translate 'thank you for your help' into Japanese.")!, check: undefined }, { text: "thank you for your help", lang: "Japanese", check: undefined });
  assert.equal(shortTranslation("'고마워요'를 영어로 번역해줘")?.lang, "English");
  assert.equal(shortTranslation("'고마워요'를 영어로 번역해줘")?.text, "고마워요");
  assert.equal(shortTranslation("이 문서를 영어로 번역해줘 report.md"), undefined);
  assert.equal(shortTranslation("What is the capital of Australia?"), undefined);
});
