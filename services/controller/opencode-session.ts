// Talk to the local OpenCode 2.x service (the desktop app's background server) about one session:
// switch its agent and queue a prompt. Used for the AFM → Codex hand-off: after the user agrees, the
// same chat session continues on the editing `codex` agent, so OpenCode's own edit/shell approvals
// and the security-gate plugin apply to everything Codex does.
// Connection details come from ~/.local/state/opencode/service.json (mode 600, written by OpenCode);
// the service listens on 127.0.0.1 only. Reverse-checked on 2.2.3 (/openapi.json) — re-verify after upgrades.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE = join(homedir(), ".local", "state", "opencode", "service.json");

function service(): { url: string; auth: string } | undefined {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(s.url) || !s.password) return undefined;   // loopback only
    return { url: s.url, auth: "Basic " + Buffer.from(`opencode:${s.password}`).toString("base64") };
  } catch { return undefined; }
}

async function call(path: string, body: unknown): Promise<{ ok: boolean; status: number; detail?: string }> {
  const s = service();
  if (!s) return { ok: false, status: 0, detail: "opencode_service_not_found" };
  try {
    const r = await fetch(s.url + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: s.auth }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { ok: r.ok, status: r.status, detail: r.ok ? undefined : (await r.text()).slice(0, 200) };
  } catch (e: any) { return { ok: false, status: 0, detail: e?.name ?? "fetch_failed" }; }
}

export const isSessionId = (s: unknown): s is string => typeof s === "string" && /^ses_[A-Za-z0-9]{8,80}$/.test(s);

/** Switch the session to `agent` and queue `text` so it runs right after the current reply finishes. */
export async function handOffSession(sessionID: string, agent: string, text: string): Promise<{ ok: boolean; step?: string; detail?: string }> {
  if (!isSessionId(sessionID)) return { ok: false, step: "session", detail: "bad_session_id" };
  const sw = await call(`/api/session/${sessionID}/agent`, { agent });
  if (!sw.ok) return { ok: false, step: "switch", detail: `${sw.status} ${sw.detail ?? ""}`.trim() };
  const pr = await call(`/api/session/${sessionID}/prompt`, { text, delivery: "queue" });
  if (!pr.ok) return { ok: false, step: "prompt", detail: `${pr.status} ${pr.detail ?? ""}`.trim() };
  return { ok: true };
}

/** Start a new OpenCode session whose project folder is `dir` (e.g. a job's worktree) and send it `text`.
 *  The agent works inside that folder with OpenCode's normal approvals and the security gate. */
export async function startSessionIn(dir: string, agent: string, title: string, text: string): Promise<{ ok: boolean; sessionID?: string; detail?: string }> {
  const s = service();
  if (!s) return { ok: false, detail: "opencode_service_not_found" };
  try {
    const r = await fetch(s.url + "/api/session", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: s.auth },
      body: JSON.stringify({ title, agent, location: { directory: dir } }), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, detail: `create ${r.status}` };
    const d: any = await r.json();
    const id = d?.data?.id ?? d?.id;
    if (!isSessionId(id)) return { ok: false, detail: "no_session_id" };
    const p = await call(`/api/session/${id}/prompt`, { text });
    return p.ok ? { ok: true, sessionID: id } : { ok: false, sessionID: id, detail: `prompt ${p.status}` };
  } catch (e: any) { return { ok: false, detail: e?.name ?? "fetch_failed" }; }
}
