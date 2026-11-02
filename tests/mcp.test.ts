import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeRepo } = await import("./helpers.ts");

const home = mkdtempSync(join(tmpdir(), "openafm-home-"));
function server(root: string) {
  const p = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", new URL("../bin/afm-mcp-server.ts", import.meta.url).pathname],
    { env: { ...process.env, OPENAFM_HOME: home, OPENAFM_MCP_ROOT: root }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; const waiters = new Map<number, (v: any) => void>();
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  let id = 0;
  const rpc = (method: string, params?: any) => new Promise<any>((res) => { const n = ++id; waiters.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  return { rpc, close: () => p.stdin.end() };
}

test("MCP: handshake, tool list, read-only tools, secret paths refused", async () => {
  // makeRepo lives in tmpdir (outside $HOME): only the protocol and refusals are checked here.
  const s = server(makeRepo({ "notes.md": "# Notes\nGRPO reward\n" }));
  const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "openafm");
  const names = (await s.rpc("tools/list")).result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["read_document", "find_files", "afm_summarize", "afm_write", "latex_check", "latex_table", "latex_polish"]);
  const out = await s.rpc("tools/call", { name: "read_document", arguments: { path: "notes.md" } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /inside your home folder/);
  const sec = await s.rpc("tools/call", { name: "read_document", arguments: { path: "~/.ssh/id_ed25519" } });
  assert.equal(sec.result.isError, true);
  assert.equal((await s.rpc("nope/method")).error.code, -32601);
  s.close();
});
