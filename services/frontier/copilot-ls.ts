// GitHub Copilot through its official language server (2026-11-03): @github/copilot-language-server (MIT), the
// package GitHub ships so that "any editor or IDE" can use Copilot over LSP. OnBud is such a client for the code
// it writes: it opens the file it is working on and asks for an inline completion (textDocument/inlineCompletion),
// the feature that is unlimited on every Copilot plan, Student and Free included (chat, agents and the CLI spend
// AI credits). Like an editor it reports the suggestion as shown and, when the code is kept, as accepted.
// Usage stays within what an editor would send for the same work: one request per step of a task the user asked
// for, a few steps per task, at least MIN_GAP_MS apart, and an hourly cap (no bulk or background use).
// Install: npm install @github/copilot-language-server in ~/OnBud/runtime/copilot-ls; sign in once with
// `node services/frontier/copilot-ls.ts signin` (GitHub device flow in the browser).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
export const LS_JS = join(HOME, "runtime", "copilot-ls", "node_modules", "@github", "copilot-language-server", "dist", "language-server.js");
const VERSION = "0.1.0";
// perHour: 120 by default; ONBUD_COPILOT_PER_HOUR changes it (benchmarks: a run of 81 tasks with the stress test
// needs ~300 requests, and a throttled request silently became a Codex call — found 2026-11-06). An editor with
// automatic suggestions sends a request at every typing pause, several hundred an hour.
export const LIMITS = { minGapMs: 1500, perHour: Number(process.env.ONBUD_COPILOT_PER_HOUR ?? 120) };

export class CopilotLS {
  private proc?: ChildProcess;
  private buf = Buffer.alloc(0);
  private id = 0;
  private waiting = new Map<number, (m: any) => void>();
  private lastCall = 0;
  private calls: number[] = [];
  /** requests sent and requests refused by the hourly cap, for cost reports */
  stats = { requests: 0, throttled: 0 };
  status = "unknown";
  private version = new Map<string, number>();

  static available(): boolean { return existsSync(LS_JS); }

  async start(root: string): Promise<void> {
    if (this.proc) return;
    this.proc = spawn(process.execPath, [LS_JS, "--stdio"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env } });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d));
    this.proc.on("exit", () => { this.proc = undefined; });
    await this.request("initialize", {
      processId: process.pid, rootUri: pathToFileURL(root).href, workspaceFolders: [{ uri: pathToFileURL(root).href, name: "project" }],
      capabilities: { workspace: { workspaceFolders: true }, window: { showDocument: { support: false } } },
      initializationOptions: { editorInfo: { name: "OnBud", version: VERSION }, editorPluginInfo: { name: "onbud-copilot", version: VERSION } },
    });
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", { settings: { telemetry: { telemetryLevel: "off" } } });
  }

  stop(): void { try { this.proc?.kill(); } catch { /* gone */ } this.proc = undefined; }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const head = this.buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, head).toString())?.[1] ?? 0);
      if (this.buf.length < head + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(head + 4, head + 4 + len).toString("utf8"));
      this.buf = this.buf.subarray(head + 4 + len);
      if (msg.id !== undefined && !msg.method && this.waiting.has(msg.id)) { this.waiting.get(msg.id)!(msg); this.waiting.delete(msg.id); }
      else if (msg.method === "didChangeStatus") this.status = String(msg.params?.kind ?? this.status);
      else if (msg.id !== undefined && msg.method) this.send({ jsonrpc: "2.0", id: msg.id, result: null });   // server requests (showMessageRequest, …)
    }
  }
  private send(m: unknown) {
    const b = Buffer.from(JSON.stringify(m), "utf8");
    this.proc?.stdin!.write(`Content-Length: ${b.length}\r\n\r\n`);
    this.proc?.stdin!.write(b);
  }
  notify(method: string, params: unknown) { this.send({ jsonrpc: "2.0", method, params }); }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = ++this.id;
    return new Promise((res) => {
      const t = setTimeout(() => { this.waiting.delete(id); res({ error: { message: "timeout" } }); }, timeoutMs);
      this.waiting.set(id, (m) => { clearTimeout(t); res(m); });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async checkStatus(): Promise<{ status: string; user?: string }> {
    const r = await this.request("checkStatus", {});
    return { status: String(r.result?.status ?? r.error?.message ?? "error"), user: r.result?.user };
  }

  /** One inline completion at (line, character) of `text`, opened as `path`; undefined when none, throttled out,
   *  or not signed in. */
  async complete(path: string, languageId: string, text: string, line: number, character: number): Promise<{ text: string; item: any } | undefined> {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < 3600_000);
    if (this.calls.length >= LIMITS.perHour) { this.stats.throttled++; return undefined; }
    const wait = this.lastCall + LIMITS.minGapMs - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now(); this.calls.push(this.lastCall); this.stats.requests++;
    const uri = pathToFileURL(path).href;
    const v = (this.version.get(uri) ?? 0) + 1;
    this.version.set(uri, v);
    if (v === 1) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: v, text } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version: v }, contentChanges: [{ text }] });
    const r = await this.request("textDocument/inlineCompletion", {
      textDocument: { uri, version: v }, position: { line, character },
      context: { triggerKind: 1 }, formattingOptions: { tabSize: 4, insertSpaces: true },
    }, 20_000);
    const item = r.result?.items?.[0];
    if (!item) return undefined;
    this.notify("textDocument/didShowCompletion", { item });
    return { text: String(item.insertText ?? ""), item };
  }

  /** Reports a kept suggestion as accepted, as an editor does when the user takes it. */
  accept(item: any): void { if (item?.command) void this.request("workspace/executeCommand", item.command, 5000); }
  close(path: string): void { this.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(path).href } }); this.version.delete(pathToFileURL(path).href); }
}

// CLI: status | signin
// Real paths on both sides: run through a symlink (~/OnBud is one after an upgrade from 0.1.0), argv[1] is the link path
// while import.meta.url is already resolved.
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return false; } })();
if (isMain) {
  const ls = new CopilotLS();
  await ls.start(process.cwd());
  const s = await ls.checkStatus();
  console.log("status:", s.status, s.user ?? "");
  if (process.argv[2] === "signin" && s.status !== "OK" && s.status !== "AlreadySignedIn") {
    const r = await ls.request("signIn", {}, 60_000);
    const res = r.result ?? {};
    console.log(`Open ${res.verificationUri ?? "https://github.com/login/device"} and enter the code: ${res.userCode}`);
    if (res.command) { const done = await ls.request("workspace/executeCommand", res.command, 600_000); console.log("sign-in:", JSON.stringify(done.result ?? done.error ?? {}).slice(0, 200)); }
    console.log("status:", (await ls.checkStatus()).status);
  }
  ls.stop();
  process.exit(0);
}

export interface Filler { complete: CopilotLS["complete"]; accept: CopilotLS["accept"]; close: CopilotLS["close"] }
/** Code between `prefix` and `suffix`, written by successive inline completions at the cursor (as an editor gets
 *  them while the user keeps accepting): stops when a completion is empty, repeats, or `rounds` is reached.
 *  Returns the text inserted and the items to report as accepted if the result is kept. */
export async function fill(ls: Filler, path: string, languageId: string, prefix: string, suffix: string, rounds = 6): Promise<{ text: string; items: any[] }> {
  let inserted = "";
  const items: any[] = [];
  for (let i = 0; i < rounds; i++) {
    const before = prefix + inserted;
    const lines = before.split("\n");
    const r = await ls.complete(path, languageId, before + suffix, lines.length - 1, lines.at(-1)!.length);
    // insertText can repeat the current line's start (it replaces the range from the line start): keep the new part.
    let add = r?.text ?? "";
    const cur = lines.at(-1)!;
    if (add.startsWith(cur)) add = add.slice(cur.length);
    // empty, or the same text again (Copilot repeats itself when the code is already complete)
    if (!add.trim() || inserted.replace(/\n$/, "").endsWith(add.replace(/\n$/, ""))) break;
    inserted += add;
    items.push(r!.item);
    if (!add.endsWith("\n")) inserted += "\n";
  }
  ls.close(path);
  return { text: inserted, items };
}

let shared: { ls: CopilotLS; ok: boolean; at: number } | undefined;
/** The shared, signed-in language server, or undefined (not installed, signed out, or ONBUD_COPILOT=off).
 *  The sign-in state is re-checked every 10 minutes. */
export async function copilotFiller(root = homedir()): Promise<CopilotLS | undefined> {
  if (process.env.ONBUD_COPILOT === "off" || !CopilotLS.available()) return undefined;
  if (shared && Date.now() - shared.at < 10 * 60_000) return shared.ok ? shared.ls : undefined;
  const ls = shared?.ls ?? new CopilotLS();
  try {
    await ls.start(root);
    const s = await ls.checkStatus();
    shared = { ls, ok: s.status === "OK" || s.status === "AlreadySignedIn", at: Date.now() };
  } catch { shared = { ls, ok: false, at: Date.now() }; }
  return shared.ok ? shared.ls : undefined;
}
