// Codex usage (2026-11-09): "Codex 토큰 언제 리셋돼?" / "How much Codex do I have left?" answered by code from the
// Codex CLI's own session logs (~/.codex/sessions/**.jsonl, token_count events carry rate_limits). Only those event
// lines are parsed; auth files are never opened. The numbers are as of the last Codex call that logged them.
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_USAGE = /(codex|코덱스)/i;
export const CODEX_USAGE_ASK = /(리셋|초기화|재설정|충전|reset|refresh|사용량|사용률|남은|남았|한도|제한|limit|usage|quota|remaining|left|토큰|tokens?|크레딧|credits?)/i;
/** A question about Codex's own limits (not a request to hand work to Codex). */
export function codexUsageIntent(p: string): boolean {
  return CODEX_USAGE.test(p) && CODEX_USAGE_ASK.test(p) && !/(보내|넘겨|맡겨|시켜|물어|send|hand|ask codex|delegate)/i.test(p) && !/(사용법|how to use|설정 방법)/i.test(p);
}

export interface Window { usedPercent: number; windowMinutes: number; resetsAt: number }
export interface CodexUsage { at: string; plan?: string; primary?: Window; secondary?: Window; reached?: string }

function tail(path: string, bytes = 256 * 1024): string {
  const size = statSync(path).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  return buf.toString("utf8");
}

/** The newest rate_limits the Codex CLI logged, from the most recently written session files. */
export function readCodexUsage(dir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")): CodexUsage | undefined {
  const files: { path: string; m: number }[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[]; try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (s.isFile() && n.endsWith(".jsonl")) files.push({ path: p, m: s.mtimeMs });
    }
  };
  walk(dir, 0);
  let best: CodexUsage | undefined;
  for (const f of files.sort((a, b) => b.m - a.m).slice(0, 5)) {
    const lines = tail(f.path).split("\n").filter((l) => l.includes('"rate_limits"'));
    for (const l of lines.reverse()) {
      try {
        const d = JSON.parse(l), r = d?.payload?.rate_limits;
        if (!r || typeof d.timestamp !== "string") continue;
        const w = (x: any): Window | undefined => x && typeof x.used_percent === "number" ? { usedPercent: x.used_percent, windowMinutes: x.window_minutes, resetsAt: x.resets_at } : undefined;
        const u: CodexUsage = { at: d.timestamp, plan: r.plan_type ?? undefined, primary: w(r.primary), secondary: w(r.secondary), reached: r.rate_limit_reached_type ?? undefined };
        if (!best || u.at > best.at) best = u;
        break;
      } catch { /* a partial first line of the tail */ }
    }
  }
  return best;
}

const span = (min: number, ko: boolean) => min % 1440 === 0 ? (ko ? `${min / 1440}일` : `${min / 1440}-day`) : min % 60 === 0 ? (ko ? `${min / 60}시간` : `${min / 60}-hour`) : `${min}${ko ? "분" : "-minute"}`;
function when(sec: number, now: number, ko: boolean): string {
  const at = new Date(sec * 1000);
  const t = at.toLocaleString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  const left = sec * 1000 - now;
  if (left <= 0) return ko ? `${t} (이미 지남 → 초기화됨)` : `${t} (passed: already reset)`;
  const d = Math.floor(left / 86_400_000), h = Math.floor((left % 86_400_000) / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000);
  const rel = d ? (ko ? `${d}일 ${h}시간 뒤` : `in ${d}d ${h}h`) : h ? (ko ? `${h}시간 ${m}분 뒤` : `in ${h}h ${m}m`) : (ko ? `${m}분 뒤` : `in ${m}m`);
  return `${t} (${rel})`;
}

export function codexUsageAnswer(u: CodexUsage | undefined, ko: boolean, now = Date.now()): { answer: string; verified: boolean; detail: string } {
  if (!u) return { verified: false, detail: "no_codex_log", answer: ko
    ? "Codex 사용량 기록을 찾지 못했어요. Codex CLI(`codex`)를 한 번 쓰면 `~/.codex/sessions`에 한도와 초기화 시각이 남아요. OpenCode로만 쓴 경우에는 기록되지 않아요."
    : "No Codex usage record found. After one Codex CLI (`codex`) call, its limits and reset times are logged under `~/.codex/sessions`; OpenCode-only use does not log them." };
  const row = (w: Window | undefined, label: string) => w ? `| ${label} (${span(w.windowMinutes, ko)}) | ${w.usedPercent.toFixed(0)}% | ${when(w.resetsAt, now, ko)} |` : "";
  const rows = [row(u.primary, ko ? "짧은 창" : "Short window"), row(u.secondary, ko ? "주간 창" : "Weekly window")].filter(Boolean).join("\n");
  const at = new Date(u.at).toLocaleString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const head = ko ? `**Codex 사용량**${u.plan ? ` (${u.plan})` : ""}\n\n| 한도 | 사용 | 초기화 |\n|---|---|---|\n` : `**Codex usage**${u.plan ? ` (${u.plan})` : ""}\n\n| Limit | Used | Resets |\n|---|---|---|\n`;
  const note = ko ? `\n\n_${at}에 마지막으로 Codex를 쓸 때 기록된 값이에요(\`~/.codex/sessions\`). 그 뒤 사용량은 반영되지 않아요._${u.reached ? `\n\n한도 도달: ${u.reached}` : ""}`
    : `\n\n_As logged by the last Codex call at ${at} (\`~/.codex/sessions\`); later use is not counted._${u.reached ? `\n\nLimit reached: ${u.reached}` : ""}`;
  return { verified: true, detail: `codex ${u.primary?.usedPercent ?? "?"}%/${u.secondary?.usedPercent ?? "?"}%`, answer: head + rows + note };
}
