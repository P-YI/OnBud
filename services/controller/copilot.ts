// GitHub Copilot from the local agent (2026-11-03), within Copilot's own terms: the agent never calls Copilot's
// servers for answers. It hands work to VS Code's Copilot chat (`code chat`, where Auto and the included models are
// unlimited on Student/Free plans, as are inline and next-edit suggestions), and it reads the plan's remaining usage
// with the signed-in GitHub CLI (the same endpoint VS Code shows it from). Premium requests (200 a month on the
// Student plan) are only spent if the user picks a premium model in VS Code.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillContext, SkillResult } from "./local-skills.ts";

const gh = () => new Promise<{ code: number; out: string }>((res) =>
  execFile("gh", ["api", "/copilot_internal/user"], { timeout: 15_000, env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "" } },
    (e: any, out) => res({ code: e ? 1 : 0, out: String(out ?? "") })));

export interface CopilotUsage { plan: string; sku: string; reset?: string; chat?: Quota; completions?: Quota; premium?: Quota }
interface Quota { unlimited: boolean; entitlement: number; remaining: number; percent: number }
export async function copilotUsage(): Promise<CopilotUsage | undefined> {
  const r = await gh();
  if (r.code !== 0) return undefined;
  try {
    const d = JSON.parse(r.out);
    const q = (k: string): Quota | undefined => { const x = d.quota_snapshots?.[k]; return x ? { unlimited: !!x.unlimited, entitlement: Number(x.entitlement ?? 0), remaining: Number(x.remaining ?? 0), percent: Number(x.percent_remaining ?? 0) } : undefined; };
    return { plan: String(d.copilot_plan ?? "?"), sku: String(d.access_type_sku ?? "?"), reset: d.quota_reset_date, chat: q("chat"), completions: q("completions"), premium: q("premium_interactions") };
  } catch { return undefined; }
}

const ASK_ONLY = /(크레딧|credits?|quota|사용량|남은|한도|limit|usage)/i;
export async function copilotSkill(c: SkillContext): Promise<SkillResult> {
  const K = c.ko;
  if (ASK_ONLY.test(c.prompt) && !/(보내|넘겨|맡겨|send|hand)/i.test(c.prompt)) {
    const u = await copilotUsage();
    if (!u) return { answer: K ? "Copilot 사용량을 읽지 못했어요. 터미널에서 `gh auth login`으로 GitHub에 로그인돼 있는지 확인해 주세요." : "Could not read Copilot usage; check `gh auth login`.", verified: false, detail: "no_usage" };
    const fmt = (x?: Quota) => (!x ? "–" : x.unlimited ? (K ? "무제한" : "unlimited") : `${x.remaining} / ${x.entitlement} (${x.percent.toFixed(0)}%)`);
    const student = /educational|free/i.test(u.sku);
    return { verified: true, detail: `${u.sku} premium ${u.premium?.remaining ?? "?"}`,
      answer: (K ? `**GitHub Copilot** (${u.sku})\n\n| 항목 | 남은 양 |\n|---|---|\n| 채팅 (Auto·기본 모델) | ${fmt(u.chat)} |\n| 코드 자동완성 (인라인·NES) | ${fmt(u.completions)} |\n| 프리미엄 요청 | ${fmt(u.premium)} |\n\n초기화: ${u.reset ?? "–"}`
        : `**GitHub Copilot** (${u.sku})\n\n| Item | Remaining |\n|---|---|\n| Chat (Auto, included models) | ${fmt(u.chat)} |\n| Completions (inline, NES) | ${fmt(u.completions)} |\n| Premium requests | ${fmt(u.premium)} |\n\nResets: ${u.reset ?? "–"}`)
        + (student ? (K ? "\n\n_이 플랜은 모델을 직접 고를 수 없고 Auto만 돼요. VS Code에서 Auto 채팅과 자동완성을 쓰면 프리미엄 요청이 줄지 않아요. \"copilot에게 보내줘\"라고 하면 지금 요청을 VS Code Copilot 채팅으로 넘겨요._" : "\n\n_This plan is Auto-only. Auto chat and completions in VS Code do not use premium requests; say \"send to copilot\" to hand a request to VS Code's Copilot chat._") : "") };
  }
  const { vscodeCli, copilotChat } = await import("../context-builder/apps.ts");
  if (!vscodeCli()) return { answer: K ? "VS Code가 없어서 Copilot 채팅으로 넘길 수 없어요." : "VS Code is not installed, so the request cannot go to Copilot chat.", verified: false, detail: "no_vscode" };
  // The request without the hand-off words; "copilot으로 보내줘" alone sends the previous request of the conversation.
  let req = c.prompt.replace(/(github\s+)?(copilot|코파일럿)(에게|한테|으로|로|에)?/gi, "").replace(/(보내|넘겨|맡겨|물어\s?봐|열어)\s?(줘|주세요)?|\b(send|hand|ask)\b( (it|this))?( to)?/gi, "").replace(/\s+/g, " ").trim().replace(/^[:：,.\-–—\s]+/, "");
  if (req.replace(/[^\p{L}\p{N}]/gu, "").length < 6) {
    const prev = [...(c.history ?? "").matchAll(/^user:\s*(.+)$/gim)].map((m) => m[1].trim()).filter((x) => !/(copilot|코파일럿)/i.test(x)).at(-1);
    if (!prev) return { answer: K ? "Copilot에게 보낼 요청을 함께 적어 주세요 (예: \"copilot에게 보내줘: src/app.py의 버그 고쳐줘\")." : "Add the request to send (e.g. \"send to copilot: fix the bug in src/app.py\").", verified: false, detail: "no_request" };
    req = prev;
  }
  const mode: "ask" | "agent" = /(수정|고쳐|추가|구현|작성|만들어|바꿔|리팩터|fix|add|implement|write|create|change|refactor|edit)/i.test(req) ? "agent" : "ask";
  const files = c.root ? c.files.map((f) => join(c.root, f.path)).filter((f) => existsSync(f)) : [];
  const ok = await copilotChat(req, c.root || undefined, files, mode);
  return { verified: ok, detail: `code chat ${mode}`,
    answer: ok ? (K ? `**VS Code Copilot 채팅**으로 보냈어요 (${mode === "agent" ? "에이전트" : "질문"} 모드${files.length ? `, 파일 ${files.length}개 첨부` : ""}).\n\n> ${req}\n\n_모델이 Auto면 크레딧(프리미엄 요청)이 줄지 않아요. 편집할 때는 인라인 제안과 Next Edit Suggestions도 무제한이에요._`
      : `Sent to **VS Code Copilot chat** (${mode} mode${files.length ? `, ${files.length} files attached` : ""}).\n\n> ${req}\n\n_With Auto, no premium requests are used; inline and next-edit suggestions are unlimited too._`)
      : (K ? "VS Code를 열지 못했어요." : "Could not open VS Code.") };
}
