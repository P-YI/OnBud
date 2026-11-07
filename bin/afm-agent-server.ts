// OpenAI-compatible front for the adaptive controller, so OpenCode (CLI 1.x or the v2 desktop app)
// can pick "AFM agent" as a model. Each chat turn runs the controller: retrieval + guided AFM tools,
// answered locally or returned as an escalation note. Loopback only, bearer token required.
// Escalations are offered, not forced: the reply asks "hand this to Codex?" and an affirmative next
// turn ("예", "넘겨", "yes", "go") runs a read-only codex agent through the 1.x CLI, where the
// security-gate plugin redacts secrets, and streams its answer back into the same chat.
// usage: node --experimental-strip-types --experimental-sqlite bin/afm-agent-server.ts   (PORT=11435)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { ApfelProvider } from "../services/afm-adapter/apfel.ts";
import { Controller, type Outcome } from "../services/controller/controller.ts";
import { loadPolicy } from "../services/policy/policy.ts";
import { OpenCodeFrontier } from "../services/controller/frontier-opencode.ts";
import { openDb } from "../services/telemetry/db.ts";
import { SqliteTelemetry } from "../services/telemetry/telemetry.ts";
import { MemoryStore } from "../services/memory/memory.ts";
import { contractMode, requestLanguage } from "../services/skills/language.ts";
import { classifyCommand, execCommand, renderResult } from "../services/context-builder/terminal.ts";
import { revealInFinder } from "../services/context-builder/finder.ts";
import { copilotChat, vscodeCli } from "../services/context-builder/apps.ts";
import { settle, startSession } from "../services/context-builder/sessions.ts";
import { applyToProject, diffOf, type EditProposal } from "../services/controller/edit-loop.ts";
import { projectHash } from "../services/telemetry/telemetry.ts";
import { buildCheckpoint, isCompactionRequest } from "../services/controller/compaction.ts";
import { handOffSession, isSessionId, startSessionIn } from "../services/controller/opencode-session.ts";
import { readFileSync as readText } from "node:fs";

const PORT = Number(process.env.AFM_AGENT_PORT ?? 11435);
const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const TOKEN = readFileSync(join(HOME, "config", "apfel.token"), "utf8").trim();
const MODEL_ID = "afm-controller";
const MAX_BODY = 16 * 1024 * 1024;   // OpenCode resends the whole conversation every turn

const db = openDb();
const telemetry = new SqliteTelemetry(db);
const controller = new Controller({ afm: new ApfelProvider(), telemetry, memory: new MemoryStore(db), db });
const frontier = new OpenCodeFrontier({ agent: "codex-handoff" });

// Launcher settings (apps/spotlight): "x-onbud-setting: s2" (rules only) or "s3" (+ Decima advise) runs the
// request like the evaluation settings, without web search or Codex; "x-onbud-web: on" (the launcher's web
// search plugin) keeps the approval-gated web search on. Without the setting header nothing changes.
type Setting = "s2" | "s3";
const SETTING_ENV: Record<Setting, Record<string, string>> = {
  s2: { ONBUD_DECIMA_MODE: "off", ONBUD_FRONTIER: "off", ONBUD_WEB: "off" },
  s3: { ONBUD_DECIMA_MODE: "advise", ONBUD_FRONTIER: "off", ONBUD_WEB: "off" },
};
const settingControllers = new Map<string, Controller>();
/** Applies the setting's env for one request (safe: one request at a time) and returns the restore function. */
function enterSetting(setting: Setting, web = false): () => void {
  const saved = Object.fromEntries(Object.keys(SETTING_ENV[setting]).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SETTING_ENV[setting], web ? { ONBUD_WEB: "on" } : {});
  return () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
}
/** "x-onbud-router-model" (s3): another router model installed in Ollaya instead of the policy's decima_model.
 *  The digest pin still applies: a model the thresholds were not calibrated on runs in shadow. */
const ROUTER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;
function controllerFor(setting: Setting | undefined, routerModel?: string): Controller {
  if (!setting) return controller;
  const model = setting === "s3" && routerModel && ROUTER_MODEL.test(routerModel) ? routerModel : undefined;
  const key = model ? `${setting}:${model}` : setting;
  let c = settingControllers.get(key);
  if (!c) {
    const policy = loadPolicy();
    if (model && model !== policy.decision.decima.model) policy.decision.decima = { ...policy.decision.decima, model };
    // Built inside enterSetting, so the controller reads that setting's Decima mode.
    settingControllers.set(key, c = new Controller({ afm: new ApfelProvider(), telemetry, memory: new MemoryStore(db), db, policy }));
  }
  return c;
}

// Actions waiting for the user's answer, keyed by chat session (root + first user message):
//   handoff  → Codex (read-only)          command → run it (tmux session if long-running)
//   edit     → sandbox trial + tests      apply   → write the tested edit to the real file
//   reveal   → a number reveals that find-files result in Finder
interface Pending {
  kind: "handoff" | "command" | "edit" | "apply" | "reveal" | "web" | "job";
  prompt: string; capsule: string; root?: string; reason: string; at: number;
  command?: string; background?: boolean;
  edit?: EditProposal; testCmd?: string;
  paths?: string[];
  sessionID?: string;     // OpenCode 2.x session (x-opencode-session-id): lets a hand-off switch it to the codex agent
  edits?: boolean;        // the task changes files → "yes" switches agents instead of a read-only answer
  web?: { query: string; kind: "general" | "papers" | "encyclopedia" };
  job?: { id: string; action: "run" | "apply" | "discard" | "review" | "compare" | "review_compare"; ids?: string[] };
}
// Persisted (mode 600) so a restart — e.g. node --watch after a code edit — does not drop an approval.
const PENDING_FILE = join(HOME, "runtime", "state", "pending.json");
const pending = new Map<string, Pending>();
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(PENDING_FILE, "utf8")) as Record<string, Pending>)) if (Date.now() - v.at < 30 * 60_000) pending.set(k, v);
} catch { /* first start */ }
function savePending() {
  try {
    mkdirSync(join(HOME, "runtime", "state"), { recursive: true, mode: 0o700 });
    writeFileSync(PENDING_FILE, JSON.stringify(Object.fromEntries(pending)), { mode: 0o600 });
  } catch { /* best effort */ }
}
const _set = pending.set.bind(pending), _del = pending.delete.bind(pending);
pending.set = (k, v) => { const r = _set(k, v); savePending(); return r; };
pending.delete = (k) => { const r = _del(k); savePending(); return r; };
const PENDING_TTL_MS = 30 * 60_000;
const YES = /^(예|네|넵|응|ㅇㅇ|ㅇㅋ|좋아|좋아요|그래|넘겨|넘겨줘|진행|진행해|진행해줘|허용|해줘|부탁해|yes|y|yep|ok|okay|sure|go|go ahead|proceed|allow|do it|hand (it )?off)[.!\s]*$/i;
const NO = /^(아니|아니요|아뇨|ㄴㄴ|싫어|취소|그만|no|n|nope|cancel|stop|don'?t)[.!\s]*$/i;
export const isYes = (s: string) => YES.test(s.trim()) || /^(codex|코덱스)(로|에게|한테)?\s*(넘겨|보내|해)/i.test(s.trim());
export const isNo = (s: string) => NO.test(s.trim());
const SWITCH = /^(전환|전환해|전환해줘|codex로 전환(해줘)?|코덱스로 전환(해줘)?|편집까지|수정까지|switch|switch to codex)[.!\s]*$/i;
const BRANCH = /^(브랜치|브랜치에서|브랜치로|worktree|branch|on a branch|in a branch)[.!\s]*$/i;
const LOCAL = /^(로컬|로컬로|로컬로 진행|로컬로 해줘|오프라인|afm으로|local|locally|offline)[.!\s]*$/i;
const COPILOT = /^(copilot|코파일럿|vs\s?code|vscode|copilot으로|코파일럿으로|copilot에게|코파일럿에게)( 보내줘| 보내| 넘겨줘)?[.!\s]*$/i;
const ANALYSE = /^(분석만|분석만 해줘|읽기 전용|읽기만|read[- ]?only|analy[sz]e only|just analy[sz]e)[.!\s]*$/i;
/** Does the escalated task change files? Then Codex should work as the editing agent, not read-only. */
export function needsEdits(prompt: string, reason: string): boolean {
  return /multi_file_change|small_edit|edit_|afm_edit_failed/.test(reason)
    || /(수정|고쳐|고치|리팩터|리팩토|바꿔|변경|추가|구현|작성|만들어|생성|삭제|이름.*바꿔|fix|refactor|implement|add|change|write|create|rename|update|delete|migrate)/i.test(prompt);
}
let busy = false;   // one task at a time: AFM itself runs with --max-concurrent 1

function authorized(req: IncomingMessage): boolean {
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";

/** OpenCode 1.x puts <env> in the system prompt; v2 adds it as a context block inside earlier
 *  messages (only on the first turn, or when it changes). Take the latest one from any role. */
export function workingDirectory(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const hit = /Working directory:\s*([^\n<]+?)\s*(?:\n|<|$)/.exec(textOf(messages[i].content));
    if (hit) return hit[1].trim();
  }
  return undefined;
}

/** Remove OpenCode's injected context blocks (env, date) from user-visible text. */
export function stripInjected(text: string): string {
  return text
    .replace(/<env>[\s\S]*?<\/env>/g, "")
    .replace(/^Today's date( is now)?:.*$/gm, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

export function checkRoot(dir: string | undefined): { root?: string; why: string } {
  if (!dir) return { why: "no_working_directory_in_request" };
  const abs = resolve(dir);
  if (abs === "/" || abs === homedir()) return { why: "home_or_root" };
  if (!abs.startsWith(homedir() + "/")) return { why: "outside_home" };
  try {
    if (!statSync(abs).isDirectory()) return { why: "not_a_directory" };
    readdirSync(abs);   // macOS privacy (TCC) blocks Desktop/Documents/Downloads for processes without access
    return { root: abs, why: "ok" };
  } catch (e: any) {
    return { why: e?.code === "EPERM" || e?.code === "EACCES" ? "macos_privacy_blocked" : `stat_${e?.code ?? "error"}` };
  }
}
const safeRoot = (dir: string | undefined) => checkRoot(dir).root;

function sessionKey(root: string | undefined, turns: any[]): string {
  // Skip compaction checkpoints so the key does not change when OpenCode compacts the session.
  const first = turns.find((m) => m.role === "user" && !/<conversation-checkpoint>|^## Objective/m.test(textOf(m.content)) && !isCompactionRequest(textOf(m.content)));
  return createHash("sha256").update(`${root ?? ""}\n${stripInjected(textOf(first?.content)).slice(0, 500)}`).digest("hex").slice(0, 16);
}

export function render(o: Outcome, seconds: number, chatOnly = false, ko = false, canSwitch = false, edits = false): string {
  const meta = `\n\n— AFM controller · ${o.route} · ${o.reasonCode}${o.skill ? ` · skill ${o.skill}` : ""} · ${seconds.toFixed(1)}s`
    + (chatOnly && !o.skill ? " · chat only (open a project folder to let AFM read files)" : "");   // a skill that ran without a folder (convert, Mac tasks) did its work
  switch (o.status) {
    case "answered_local":
      return (o.isProposal ? "Proposal only — not applied or tested.\n\n" : "") + (o.answer ?? "") + meta;
    case "escalation_required":
      return (ko
        ? `이 작업은 로컬 AFM으로는 어려워 보여요 (${o.reasonCode}).\n\n` + (canSwitch
          ? (edits
            ? "**Codex(GPT-6.1 Sol)로 전환할까요?** `예`라고 답하면 이 대화가 **편집 가능한 codex 에이전트**로 바뀌고 Codex가 이 요청을 이어서 처리해요. 파일 수정과 명령 실행은 매번 승인 창이 떠요. 분석만 원하면 `분석만`, AFM이 할 일 목록을 만들어 별도 브랜치에서 직접 해 보게 하려면 `로컬`, 그만두려면 `아니요`. (Codex 사용량이 차감돼요)"
            : "**Codex(GPT-6.1 Sol)에게 맡길까요?** `예`라고 답하면 Codex가 이 폴더를 **읽기 전용**으로 분석해서 여기로 답을 가져와요. 파일 수정까지 맡기려면 `전환`이라고 답하세요 — 이 대화가 codex 에이전트로 바뀌어요. (Codex 사용량이 차감돼요)")
          + (edits ? "\n\n`브랜치`라고 답하면 Codex가 메인 대신 **별도 git 브랜치(worktree)**에서 작업해요 — 끝나면 반영하거나 AFM 작업과 비교할 수 있어요." : "")
          : "**Codex(GPT-6.1 Sol)로 넘길까요?** `예` 또는 `넘겨`라고 답하면 Codex가 이 폴더를 **읽기 전용**으로 분석해서 여기로 답을 가져와요 (Codex 사용량이 차감돼요). 파일 수정까지 맡기려면 에이전트를 **codex**로 바꿔 주세요.")
        : `This looks too big for the local model (${o.reasonCode}).\n\n` + (canSwitch
          ? (edits
            ? "**Switch to Codex (GPT-6.1 Sol)?** Reply `yes` and this chat moves to the **editing codex agent**, which continues the request; every file edit and command asks for approval. Reply `branch` to have Codex work on a separate git branch (worktree) instead of main, `local` for the on-device model's to-do list, `analyse only` for a read-only answer, `no` to stop. (Uses your Codex quota.)"
            : "**Hand it to Codex (GPT-6.1 Sol)?** Reply `yes` for a **read-only** analysis here, or `switch` to move this chat to the editing codex agent. (Uses your Codex quota.)")
          : "**Hand it to Codex (GPT-6.1 Sol)?** Reply `yes` and Codex will analyse this folder **read-only** and answer here (uses your Codex quota). To let it edit files, switch the agent to **codex**.")) +
        // VS Code's Copilot chat (Auto: no premium requests on Student/Free plans) as a credit-free alternative.
        (vscodeCli() ? (ko ? "\n\n`copilot`이라고 답하면 Codex 대신 **VS Code Copilot 채팅**으로 넘겨요 (Auto 모델은 크레딧이 줄지 않아요)." : "\n\nReply `copilot` to hand it to **VS Code's Copilot chat** instead (Auto uses no premium requests).") : "") +
        `\n\n<details><summary>local pre-analysis</summary>\n\n${o.capsule ?? ""}\n\n</details>` + meta;
    default:
      return (o.answer ?? "No answer.") + meta;
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse, body: any) {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const last = [...turns].reverse().find((m) => m.role === "user");
  const prompt = stripInjected(textOf(last?.content));
  if (!prompt) return send(res, 400, { error: { message: "no user message" } });
  // OpenCode opened at ~ or outside $HOME (the desktop app's default) → chat only, no file access:
  // searching the whole home folder would expose Documents, Downloads, etc. to retrieval.
  const wd = workingDirectory(messages);
  const check = checkRoot(wd);
  const root = check.root ?? safeRoot(process.env.AFM_AGENT_ROOT);
  try {
    appendFileSync(join(HOME, "runtime", "logs", "afm-agent-requests.jsonl"), JSON.stringify({
      ts: new Date().toISOString(), wd: wd ?? null, root: root ?? null, why: check.why,
      systemChars: messages.filter((m) => m.role === "system").reduce((n, m) => n + textOf(m.content).length, 0),
      turns: turns.length }) + "\n");
  } catch { /* logging is best effort */ }
  const history = turns.slice(0, -1).slice(-4).map((m) => `${m.role}: ${stripInjected(textOf(m.content)).slice(0, 600)}`).join("\n");

  // OpenCode session compaction: answer with a template checkpoint built from the turns (no model call).
  if (isCompactionRequest(prompt)) {
    const all = turns.map((m) => ({ role: m.role, text: stripInjected(textOf(m.content)) }));
    const previous = all.map((t) => t.text).find((t) => /<conversation-checkpoint>|## Objective/.test(t) && !isCompactionRequest(t));
    const summary = buildCheckpoint(all.slice(0, -1).filter((t) => !/<conversation-checkpoint>/.test(t.text)), { root, previous, ko: all.some((t) => t.role === "user" && /[\uac00-\ud7a3]/.test(t.text) && !isCompactionRequest(t.text)) });
    telemetry.toolCall({ tool: "compaction_checkpoint", ok: true, durationMs: 0, resultChars: summary.length });
    const cid = `chatcmpl-afm-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 0, completion_tokens: Math.ceil(summary.length / 3), total_tokens: Math.ceil(summary.length / 3) };
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const c = (delta: Record<string, unknown>, finish: string | null, extra = {}) => `data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(c({ role: "assistant", content: summary }, null));
      res.write(c({}, "stop", { usage }));
      return res.end("data: [DONE]\n\n");
    }
    return send(res, 200, { id: cid, object: "chat.completion", created, model: MODEL_ID, usage, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: summary } }] });
  }

  if (busy) return send(res, 429, { error: { message: "AFM controller is busy with another request" } });
  busy = true;
  const id = `chatcmpl-afm-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

  let ping: ReturnType<typeof setInterval> | undefined;
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(chunk({ role: "assistant", content: "" }, null));
    ping = setInterval(() => res.write(": working\n\n"), 5000);   // keep the client from timing out
  }
  const t0 = Date.now();
  const key = sessionKey(root, turns);
  const ko = contractMode() === "on" ? requestLanguage(prompt) === "ko" : /[\uac00-\ud7a3]/.test(prompt);
  const sid = String(req.headers["x-opencode-session-id"] ?? "");
  const sessionID = isSessionId(sid) ? sid : undefined;   // OpenCode 2.x only; the 1.x CLI sends none
  const hs = String(req.headers["x-onbud-setting"] ?? "").toLowerCase();
  const setting: Setting | undefined = hs === "s2" || hs === "s3" ? hs : undefined;
  const leaveSetting = setting ? enterSetting(setting, String(req.headers["x-onbud-web"] ?? "") === "on") : undefined;
  // Launcher only: each controller step as a content-free chunk, so the panel can show live progress.
  const onStep = setting && body.stream
    ? (s: { kind: string; detail: string }) => res.write(chunk({}, null, { onbud: { step: s.kind, detail: String(s.detail ?? "").slice(0, 160) } }))
    : undefined;
  const controller = controllerFor(setting, String(req.headers["x-onbud-router-model"] ?? "") || undefined);
  try {
    const waiting = pending.get(key);
    let text: string;
    let capsuleTokens = 0;
    const pick = /^\s*(\d{1,2})\s*(번)?\s*(열어.*|open.*)?$/i.exec(prompt);
    if (waiting?.kind === "reveal" && pick && Date.now() - waiting.at < PENDING_TTL_MS) {
      // Reveal one of the paths the finder returned (nothing else can be opened this way).
      const target = waiting.paths?.[Number(pick[1]) - 1];
      const ok = target ? await revealInFinder(target) : false;
      const koR = /[\uac00-\ud7a3]/.test(waiting.prompt);
      text = ok ? (koR ? `Finder에서 ${pick[1]}번 항목을 선택해서 열었어요.` : `Revealed item ${pick[1]} in Finder.`)
        : (koR ? `${pick[1]}번 항목이 없어요 (1–${waiting.paths?.length ?? 0}).` : `No item ${pick[1]} (1–${waiting.paths?.length ?? 0}).`);
    } else if (setting && waiting?.kind === "handoff" && Date.now() - waiting.at < PENDING_TTL_MS
      && (isYes(prompt) || SWITCH.test(prompt.trim()) || ANALYSE.test(prompt.trim()) || BRANCH.test(prompt.trim()))) {
      // S2/S3 never call Codex; the hand-off stays pending for "local" or "no".
      const koW = /[\uac00-\ud7a3]/.test(waiting.prompt);
      text = koW ? "런처의 로컬 모델은 Codex를 직접 부르지 않아요. Codex에게 맡기려면 런처의 **Codex로 보내기** 버튼(Codex 플러그인)을 쓰고, 로컬 AFM이 별도 브랜치에서 해 보게 하려면 `로컬`, 그만두려면 `아니요`라고 답하세요."
        : "The launcher's local models do not call Codex themselves. Use the launcher's **Send to Codex** button (Codex plugin), reply `local` to let the on-device model try on a branch, or `no` to stop.";
    } else if (waiting && waiting.kind !== "reveal" && Date.now() - waiting.at < PENDING_TTL_MS && (isYes(prompt) || isNo(prompt) || (waiting.kind === "handoff" && (SWITCH.test(prompt.trim()) || ANALYSE.test(prompt.trim()) || LOCAL.test(prompt.trim()) || BRANCH.test(prompt.trim()) || COPILOT.test(prompt.trim()))))) {
      pending.delete(key);
      if (waiting.kind === "handoff" && COPILOT.test(prompt.trim())) {
        // The request goes to VS Code's Copilot chat (opened for the user; nothing is sent on their behalf).
        const ok = await copilotChat(waiting.prompt, waiting.root, [], waiting.edits ? "agent" : "ask");
        text = ok ? (ko ? "**VS Code Copilot 채팅**으로 넘겼어요. VS Code에서 이어서 진행하세요 (Auto 모델은 크레딧이 줄지 않아요)." : "Handed to **VS Code's Copilot chat**; continue there (Auto uses no premium requests).")
          : (ko ? "VS Code를 열지 못했어요." : "Could not open VS Code.");
      } else if (waiting.kind === "handoff" && BRANCH.test(prompt.trim()) && waiting.root) {
        // Codex works in its own branch + worktree (new OpenCode session there); main stays untouched.
        const { createFrontierJob, journalPath } = await import("../services/controller/jobs.ts");
        const koW = /[\uac00-\ud7a3]/.test(waiting.prompt);
        try {
          const job = await createFrontierJob(waiting.root, waiting.prompt);
          const task = `${waiting.prompt}\n\n---\n${koW ? "이 폴더는 별도 git worktree 브랜치예요. 여기서만 작업하고, 끝나면 변경을 이 브랜치에 커밋해 주세요. 테스트가 있으면 돌려서 결과를 알려 주세요." : "This folder is a separate git worktree branch. Work only here, commit your changes on this branch when done, and run the tests if there are any."}\n\n${koW ? "로컬 AFM의 사전 분석" : "Local pre-analysis"}:\n${waiting.capsule.slice(0, 5000)}`;
          const r = await startSessionIn(job.workspace.work, "codex", `codex · ${job.id}`, task);
          job.frontierSession = r.sessionID; (await import("../services/controller/jobs.ts")).saveJob(job);
          text = r.ok ? (koW ? `**Codex가 별도 브랜치에서 작업을 시작했어요.**\n\n- 작업: \`${job.id}\` · 브랜치 \`${job.workspace.branch}\`\n- 작업 폴더: \`${job.workspace.work}\` (OpenCode 세션 목록에 \"codex · ${job.id}\"로 보여요)\n- 메인 체크아웃은 그대로예요. 끝나면 \"작업 ${job.id} 반영\", AFM 작업과 비교하려면 \"작업 비교\".\n- 기록: \`${journalPath(job.id)}\``
                : `**Codex started on its own branch.** Job \`${job.id}\`, branch \`${job.workspace.branch}\`, folder \`${job.workspace.work}\` (session "codex · ${job.id}"). Main is untouched; then "job ${job.id} apply" or "compare jobs".`)
            : (koW ? `Codex 세션을 만들지 못했어요 (${r.detail}). 작업 폴더는 준비돼 있어요: \`${job.workspace.work}\`` : `Could not start the Codex session (${r.detail}); the worktree is ready: \`${job.workspace.work}\``);
        } catch (e: any) { text = (koW ? "작업 브랜치를 만들지 못했어요: " : "Could not create the job branch: ") + String(e?.message ?? e).slice(0, 200); }
      } else if (waiting.kind === "handoff" && LOCAL.test(prompt.trim()) && waiting.root) {
        // Do it with the local job engine instead of Codex.
        const out = await controller.handle({ prompt: `${waiting.prompt} (로컬로 진행)`, root: waiting.root, frontEnd: "opencode" });
        if (out.pendingJob) pending.set(key, { kind: "job", prompt: waiting.prompt, capsule: "", root: waiting.root, reason: out.reasonCode, job: out.pendingJob, at: Date.now() });
        text = render(out, (Date.now() - t0) / 1000, false, ko);
      } else if (waiting.kind === "job" && isYes(prompt) && waiting.job) {
        const j = waiting.job;
        if (j.action === "run") {
          if (body.stream) res.write(chunk({ content: (ko ? "로컬 작업을 시작해요 (단계마다 확인하고 커밋해요)…" : "Starting the local job (each step is checked and committed)…") + "\n\n" }, null));
          text = await controller.runLocalJob(j.id, (line) => { if (body.stream) res.write(chunk({ content: `- ${line}\n` }, null)); });
          if (/\(`예` \/ `아니요`\)|\(`yes` \/ `no`\)/.test(text)) pending.set(key, { kind: "job", prompt: waiting.prompt, capsule: "", root: waiting.root, reason: "job_done", job: { id: j.id, action: "apply" }, at: Date.now() });
        } else if (j.action === "apply") text = await controller.applyLocalJob(j.id);
        else if (j.action === "discard") text = await controller.discardLocalJob(j.id);
        else if (j.action === "compare") {
          if (body.stream) res.write(chunk({ content: (ko ? "각 브랜치에서 확인 명령을 실행하는 중…" : "Running the checks in each branch…") + "\n\n" }, null));
          const c = await controller.compareLocalJobs(j.ids ?? [j.id]);
          text = c.text;
          if (c.jobs.length >= 2) pending.set(key, { kind: "job", prompt: waiting.prompt, capsule: "", root: waiting.root, reason: "compare_done", job: { id: j.id, action: "review_compare", ids: j.ids }, at: Date.now(), sessionID: waiting.sessionID ?? sessionID });
        } else {
          // Codex reviews in a new session whose folder is the worktree (or, for two branches, their common parent),
          // so it can read and fix the branch without access outside it.
          const { loadJob, reviewPrompt, jobsRoot } = await import("../services/controller/jobs.ts");
          const jobs = (j.action === "review_compare" ? j.ids ?? [] : [j.id]).map(loadJob).filter((x): x is NonNullable<typeof x> => !!x && !!x.workspace.dir);
          if (!jobs.length) text = ko ? "검토할 작업 브랜치를 찾지 못했어요." : "No job branch to review.";
          else {
            const dir = jobs.length === 1 ? jobs[0].workspace.work : jobsRoot();
            const prompt2 = jobs.length === 1 ? reviewPrompt(jobs[0], ko)
              : (ko ? "아래 브랜치들은 같은 요청을 서로 다른 작업자가 구현한 결과예요. 각각 검토하고 테스트를 돌려서 어느 쪽이 나은지, 각 브랜치의 버그와 고칠 점을 정리해 주세요. 파일은 수정하지 말고 보고만 해 주세요.\n\n" : "These branches implement the same request by different workers. Review each, run the tests, say which is better and list bugs and fixes. Report only; do not edit.\n\n")
                + jobs.map((x) => reviewPrompt(x, ko)).join("\n\n");
            const r = await startSessionIn(dir, "codex", `codex review · ${jobs.map((x) => x.id).join(" vs ")}`, prompt2);
            text = r.ok ? (ko ? `**Codex 검토 세션을 시작했어요** (\"codex review · ${jobs.map((x) => x.id).join(" vs ")}\"). 작업 폴더: \`${dir}\`. 메인 반영은 따로 승인해야 해요.` : `**Started a Codex review session** in \`${dir}\`. Applying to main is approved separately.`)
              : (ko ? `검토 세션을 만들지 못했어요 (${r.detail}). 아래를 Codex에 붙여 넣으세요:\n\n` : `Could not start the review session (${r.detail}). Paste this to Codex:\n\n`) + (r.ok ? "" : "```\n" + prompt2 + "\n```");
          }
        }
      } else if (waiting.kind === "web" && isYes(prompt) && waiting.web) {
        if (body.stream) res.write(chunk({ content: (/[\uac00-\ud7a3]/.test(waiting.prompt) ? "검색하고 결과 페이지를 읽는 중…" : "Searching and reading the top pages…") + "\n\n" }, null));
        const w = await controller.answerFromWeb(waiting.prompt, waiting.web.query, waiting.web.kind);
        text = w.text + `\n\n— AFM controller · web search (${w.backend}) · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
      } else if (waiting.kind === "edit" && isYes(prompt) && waiting.root && waiting.edit) {
        if (body.stream) res.write(chunk({ content: ko ? "샌드박스 사본에서 시험 중…\n\n" : "Trying it in a sandbox copy…\n\n" }, null));
        const tr = await controller.runEditTrial(waiting.root, waiting.prompt, { edit: waiting.edit, testCmd: waiting.testCmd },
          (m) => { if (body.stream) res.write(chunk({ content: m }, null)); });
        if (tr.trial.ok) {
          pending.set(key, { kind: "apply", prompt: waiting.prompt, capsule: "", root: waiting.root, reason: "edit_tested", edit: tr.trial.edit, at: Date.now() });
          text = tr.report + (ko ? `\n\n실제 파일 \`${tr.trial.edit.path}\`에 적용할까요? (\`예\` / \`아니요\`)` : `\n\nApply it to \`${tr.trial.edit.path}\`? (\`yes\` / \`no\`)`);
        } else {
          const capsule = `AFM proposed this edit for ${tr.trial.edit.path}; it failed (${tr.trial.stage}) after ${tr.attempts} attempt(s).\n\n${tr.trial.diff}\n\n${tr.trial.result ? renderResult(tr.trial.command ?? "", tr.trial.result).slice(-2500) : ""}`;
          pending.set(key, { kind: "handoff", prompt: waiting.prompt, capsule, root: waiting.root, reason: "afm_edit_failed_tests", at: Date.now(), sessionID: waiting.sessionID ?? sessionID, edits: true });
          const canSwitch = !!(waiting.sessionID ?? sessionID);
          text = tr.report + (ko
            ? (canSwitch ? "\n\n로컬 AFM으로는 해결하지 못했어요. **codex 에이전트로 전환해서 고칠까요?** (`예` / `분석만` / `아니요`)" : "\n\n로컬 AFM으로는 해결하지 못했어요. **Codex로 넘길까요?** (`예` / `아니요`, 읽기 전용 분석)")
            : (canSwitch ? "\n\nThe local model could not fix it. **Switch to the codex agent to fix it?** (`yes` / `analyse only` / `no`)" : "\n\nThe local model could not fix it. **Hand it to Codex?** (`yes` / `no`, read-only analysis)"));
        }
      } else if (waiting.kind === "apply" && isYes(prompt) && waiting.root && waiting.edit) {
        const before = readText(join(waiting.root, waiting.edit.path), "utf8");
        const r = applyToProject(waiting.root, waiting.edit);
        text = r.ok
          ? (ko ? `\`${waiting.edit.path}\`에 적용했어요. 되돌리려면 \`git checkout -p -- ${waiting.edit.path}\` 또는 편집기에서 실행 취소하세요.` : `Applied to \`${waiting.edit.path}\`. To undo: \`git checkout -p -- ${waiting.edit.path}\` or your editor's undo.`)
            + "\n\n```diff\n" + (await diffOf(waiting.edit.path, before, readText(join(waiting.root, waiting.edit.path), "utf8"))) + "\n```"
          : (ko ? `적용하지 않았어요 (${r.error}). 그 사이 파일이 바뀌었으면 다시 요청해 주세요.` : `Not applied (${r.error}). If the file changed meanwhile, ask again.`);
        telemetry.toolCall({ tool: "apply_edit", ok: r.ok, durationMs: 0, errorType: r.error });
      } else if (waiting.kind === "command" && isYes(prompt) && waiting.root && waiting.command && waiting.background) {
        // Long-running: start in a tmux session and show the first output.
        const cls = classifyCommand(waiting.command, waiting.root);
        if (cls.mode === "blocked") text = (ko ? "보안 게이트가 이 명령을 막았어요" : "The security gate blocked this command") + ` (${cls.reasons.join(", ")}).`;
        else {
          const st = await startSession(projectHash(waiting.root), waiting.root, waiting.command);
          const first = st.ok ? await settle(st.name!, 5000) : "";
          telemetry.toolCall({ tool: "session_start", ok: st.ok, durationMs: Date.now() - t0, errorType: st.error });
          const label = st.name?.replace(/^afm-[0-9a-f]{6}-/, "");
          text = st.ok
            ? (ko ? `백그라운드 세션 \`${label}\`에서 실행 중이에요.` : `Running in background session \`${label}\`.`) + "\n\n```\n" + (first.slice(-2500) || "(no output yet)") + "\n```\n\n"
              + (ko ? `출력 보기: "로그 보여줘" · 종료: "세션 종료해줘" · 직접 보기: \`tmux -L onbud attach -t ${st.name}\`` : `Output: ask "show the log" · stop: "stop the session" · watch: \`tmux -L onbud attach -t ${st.name}\``)
            : (ko ? `세션을 시작하지 못했어요 (${st.error}).` : `Could not start a session (${st.error}).`);
        }
      } else if (waiting.kind === "command" && isYes(prompt) && waiting.command) {
        // A command typed without a project folder (e.g. `opencode auth list`) runs in the home folder and its output is
        // shown as is; with a project, the controller then answers the original request from the output.
        const cwd = waiting.root ?? homedir();
        // User approved a command AFM asked for: run it (the gate still applies), then answer with its output.
        const cls = classifyCommand(waiting.command, cwd);
        if (cls.mode === "blocked") {
          text = (ko ? "보안 게이트가 이 명령을 막았어요" : "The security gate blocked this command") + ` (${cls.reasons.join(", ")}).`;
        } else {
          const r = await execCommand(waiting.command, cwd, { timeoutMs: 120_000 });
          telemetry.toolCall({ tool: "run_command_approved", ok: r.exitCode === 0, durationMs: r.ms, resultChars: r.output.length });
          if (!waiting.root) text = "```\n" + renderResult(waiting.command, r).slice(0, 4000) + "\n```";
          else {
            const out = await controller.handle({ prompt: waiting.prompt, root: waiting.root, frontEnd: "opencode",
              history: `${history}\nuser approved and the controller ran:\n${renderResult(waiting.command, r)}` });
            text = "```\n" + renderResult(waiting.command, r).slice(0, 2500) + "\n```\n\n" + render(out, (Date.now() - t0) / 1000, !waiting.root, ko);
          }
        }
      } else if (isNo(prompt) && waiting.kind !== "handoff") {
        text = ko ? "알겠어요, 아무것도 실행하거나 바꾸지 않았어요." : "OK, nothing was run or changed.";
      } else if (isNo(prompt)) {
        text = ko ? "알겠어요, Codex로 넘기지 않을게요. 범위를 좁혀서(파일 하나, 함수 하나) 다시 물어보시면 로컬에서 시도해 볼게요." : "OK, not handing off. Narrow the question (one file or function) and I will try locally.";
      } else if (waiting.kind === "handoff" && (waiting.sessionID ?? sessionID) && (SWITCH.test(prompt.trim()) || (waiting.edits && !ANALYSE.test(prompt.trim())))) {
        // Switch this OpenCode session to the editing codex agent and queue the request for it.
        const koW = /[\uac00-\ud7a3]/.test(waiting.prompt);
        const task = `${waiting.prompt}\n\n---\n${koW ? "로컬 AFM의 사전 분석 (참고용, 불완전할 수 있음)" : "Local pre-analysis by the on-device model (may be incomplete)"}:\n${waiting.capsule.slice(0, 6000)}${koW ? "\n\n한국어로 답해 주세요." : ""}`;
        const r = await handOffSession((waiting.sessionID ?? sessionID)!, "codex", task);
        telemetry.toolCall({ tool: "switch_to_codex", ok: r.ok, durationMs: Date.now() - t0, errorType: r.ok ? undefined : `${r.step}:${r.detail}` });
        text = r.ok
          ? (koW ? "**codex 에이전트로 전환했어요.** 이 응답이 끝나면 Codex(GPT-6.1 Sol)가 같은 대화에서 요청을 이어서 처리해요. 파일 수정과 명령 실행은 매번 승인 창이 떠요. 작업이 끝난 뒤 AFM으로 돌아오려면 에이전트를 **afm**으로 바꾸세요."
               : "**Switched this chat to the codex agent.** When this reply ends, Codex (GPT-6.1 Sol) continues the request here; every edit and command asks for approval. Switch the agent back to **afm** afterwards.")
          : (koW ? `자동 전환에 실패했어요 (${r.step}: ${r.detail}). 에이전트 선택에서 **codex**를 고른 뒤 같은 요청을 보내 주세요.` : `Could not switch automatically (${r.step}: ${r.detail}). Pick **codex** in the agent selector and send the request again.`);
      } else if (waiting.kind !== "handoff") {
        // Only a hand-off goes to Codex; an approval this server cannot carry out is said, not forwarded.
        text = ko ? "이 승인 대기 항목은 지금 처리할 수 없어요 (프로젝트 폴더가 필요해요). 폴더를 연 뒤 다시 요청해 주세요." : "This pending item cannot be carried out here (it needs a project folder). Open the folder and ask again.";
      } else {
        if (body.stream) res.write(chunk({ content: ko ? "Codex로 넘겼어요 — 읽기 전용으로 분석 중…\n\n" : "Handed to Codex — analysing read-only…\n\n" }, null));
        const handoff = `${waiting.prompt}\n\n---\nLocal pre-analysis by the on-device model (redacted, may be incomplete):\n${waiting.capsule}` +
          (ko ? "\n\nAnswer in Korean." : "");
        const r = await frontier.run(handoff, waiting.root ?? homedir());
        telemetry.modelCall({ provider: frontier.name, model: "openai/gpt-6.1-sol", purpose: "handoff_approved", ok: r.ok, failure: r.detail, latencyMs: Date.now() - t0, costType: "subscription" });
        text = (r.ok ? r.text : (ko ? `Codex 실행에 실패했어요 (${r.detail}). 에이전트를 codex로 바꿔 직접 물어봐 주세요.` : `Codex failed (${r.detail}). Switch the agent to codex and ask directly.`)) +
          `\n\n— codex-handoff (GPT-6.1 Sol, read-only) · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
      }
    } else if ((isYes(prompt) || isNo(prompt)) && prompt.trim().length <= 12) {
      // A bare "yes"/"no" with nothing waiting must not start a task (it once escalated and was then
      // approved by the next "yes"). Say so instead.
      text = ko ? "지금 확인을 기다리는 작업이 없어요 (30분이 지나면 대기 중인 승인도 만료돼요). 하려던 요청을 다시 보내 주세요."
        : "Nothing is waiting for a yes/no right now (pending approvals expire after 30 minutes). Please send the request again.";
    } else {
      const out = await controller.handle({ prompt, root, history: history || undefined, frontEnd: "opencode", onStep });
      const edits = needsEdits(prompt, out.reasonCode);
      if (out.status === "escalation_required") pending.set(key, { kind: "handoff", prompt, capsule: out.capsule ?? "", root, reason: out.reasonCode, at: Date.now(), sessionID, edits });
      if (out.pendingCommand) pending.set(key, { kind: "command", prompt, capsule: out.capsule ?? "", root, reason: out.reasonCode, command: out.pendingCommand, background: out.background, at: Date.now() });
      if (out.pendingEdit) pending.set(key, { kind: "edit", prompt, capsule: "", root, reason: out.reasonCode, edit: out.pendingEdit.edit, testCmd: out.pendingEdit.testCmd, at: Date.now() });
      if (out.pendingJob) pending.set(key, { kind: "job", prompt, capsule: "", root, reason: out.reasonCode, job: out.pendingJob, at: Date.now(), sessionID });
      if (out.pendingWeb) pending.set(key, { kind: "web", prompt, capsule: "", root, reason: out.reasonCode, web: out.pendingWeb, at: Date.now() });
      if (out.revealPaths?.length) pending.set(key, { kind: "reveal", prompt, capsule: "", root, reason: out.reasonCode, paths: out.revealPaths, at: Date.now() });
      text = render(out, (Date.now() - t0) / 1000, !root, ko, !!sessionID, edits);
      capsuleTokens = out.capsuleTokens ?? 0;
    }
    const usage = { prompt_tokens: capsuleTokens, completion_tokens: Math.ceil(text.length / 3), total_tokens: capsuleTokens + Math.ceil(text.length / 3) };
    // Launcher requests also get what is waiting for the user's answer, so it can show yes/no buttons.
    const extra = setting ? { onbud: { setting, awaiting: pending.get(key)?.kind ?? null } } : {};
    if (body.stream) {
      res.write(chunk({ content: text }, null));
      res.write(chunk({}, "stop", { usage, ...extra }));
      res.end("data: [DONE]\n\n");
    } else {
      send(res, 200, { id, object: "chat.completion", created, model: MODEL_ID, usage, ...extra,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }] });
    }
  } catch (e: any) {
    if (body.stream) { res.write(chunk({ content: `AFM controller error: ${e?.message ?? e}` }, "stop")); res.end("data: [DONE]\n\n"); }
    else send(res, 500, { error: { message: String(e?.message ?? e) } });
  } finally {
    if (ping) clearInterval(ping);
    leaveSetting?.();
    busy = false;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") return send(res, 200, { status: "ok", model: MODEL_ID, busy });
  if (!authorized(req)) return send(res, 401, { error: { message: "unauthorized" } });
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return send(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "onbud" }] });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) req.destroy(); else parts.push(c); });
    req.on("end", () => {
      let body: any;
      try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return send(res, 400, { error: { message: "invalid JSON" } }); }
      handleChat(req, res, body);
    });
    return;
  }
  send(res, 404, { error: { message: "not found" } });
});

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("afm-agent-server.ts")) {
  if (!existsSync(join(HOME, "config", "apfel.token"))) throw new Error("missing token file");
  server.listen(PORT, "127.0.0.1", () => console.log(`afm-agent listening on 127.0.0.1:${PORT}`));
}
