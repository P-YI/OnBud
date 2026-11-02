// Run one prompt in a fresh OpenCode session (codex agent) in `dir`, answering permission prompts the way a
// careful user would: approve what the security gate allows, reject what it denies. Used by the benchmarks
// for the Codex-only setting and for S1 hand-offs. Returns the final text and counts.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startSessionIn } from "../../services/controller/opencode-session.ts";
import { gateCommand } from "../../services/security/gate.ts";

const svc = () => JSON.parse(readFileSync(join(homedir(), ".local/state/opencode/service.json"), "utf8"));
async function api(m: string, p: string, b?: unknown): Promise<any> {
  const s = svc();
  const r = await fetch(s.url + p, { method: m, headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Basic " + Buffer.from("opencode:" + s.password).toString("base64") }, body: b === undefined ? undefined : JSON.stringify(b), signal: AbortSignal.timeout(30_000) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}

export interface CodexRun { ok: boolean; text: string; approvals: number; rejections: number; ms: number; detail?: string; tokens?: { input: number; output: number; reasoning: number; cacheRead: number } }

export async function codexIn(dir: string, prompt: string, opts: { title?: string; timeoutMs?: number } = {}): Promise<CodexRun> {
  const t0 = Date.now();
  const st = await startSessionIn(dir, "codex", opts.title ?? "bench", prompt);
  if (!st.ok || !st.sessionID) return { ok: false, text: "", approvals: 0, rejections: 0, ms: Date.now() - t0, detail: st.detail };
  const sid = st.sessionID;
  let approvals = 0, rejections = 0, idle = 0, text = "";
  while (Date.now() - t0 < (opts.timeoutMs ?? 300_000)) {
    await new Promise((r) => setTimeout(r, 3000));
    const perms = (await api("GET", `/api/session/${sid}/permission`))?.data ?? [];
    for (const p of perms) {
      const res: string[] = p.resources ?? [];
      const outside = res.some((x) => /^\//.test(x) && !x.startsWith(dir));
      const denied = p.action === "shell" ? res.some((c) => gateCommand(c, dir).verdict === "deny") : false;
      const ok = !outside && !denied && p.action !== "external_directory";
      await api("POST", `/api/session/${sid}/permission/${p.id}/reply`, { decision: ok ? "once" : "reject" });
      ok ? approvals++ : rejections++;
    }
    const msgs = (await api("GET", `/api/session/${sid}/message?limit=100&order=asc`))?.data ?? [];
    const texts = msgs.filter((m: any) => m.type === "assistant").flatMap((m: any) => (m.content ?? []).filter((c: any) => c.type === "text" && c.text).map((c: any) => c.text));
    if (texts.length) text = texts[texts.length - 1];
    const last = msgs[msgs.length - 1];
    // Done only when the session reports idle (an early "I'll do X" message is not the end of the turn).
    if (!perms.length && last?.type === "idle" && texts.length) { if (++idle >= 2) break; } else idle = 0;
  }
  // Token usage as OpenCode recorded it for the session (before it is deleted).
  const info = (await api("GET", `/api/session/${sid}`).catch(() => undefined))?.data;
  const tk = info?.tokens;
  await api("POST", `/api/session/${sid}/interrupt`).catch(() => {});
  await api("DELETE", `/api/session/${sid}`).catch(() => {});
  return { ok: !!text, text, approvals, rejections, ms: Date.now() - t0,
    tokens: tk ? { input: tk.input ?? 0, output: tk.output ?? 0, reasoning: tk.reasoning ?? 0, cacheRead: tk.cache?.read ?? 0 } : undefined };
}
