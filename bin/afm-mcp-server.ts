// MCP server (stdio, JSON-RPC 2.0) that lends the local OnBud tools to a frontier agent (Codex in
// OpenCode): AFM works as the intern on local material.
//   read_document    PDF/Word/slides/sheets/hwpx/epub/images → text (OCR on-device), optional page search
//   find_files       files/folders by name across the Mac (Spotlight + hidden folders), private paths filtered
//   afm_summarize    on-device AFM summary of a document or text (long PDFs: map-reduce over relevant pages),
//                    so the raw document stays on the Mac and Codex receives only the summary
//   afm_write        short drafts (abstract, paragraph, caption, commit message) by AFM
//   latex_check      compile with latexmk (offline) + citation/reference checks
//   latex_table      CSV/TSV → booktabs table
//   latex_polish     masked prose rewrite of given .tex lines; returns the replacement, never writes
//   afm_task         hand a small, self-contained local step to the whole local agent (controller: skills, AFM,
//                    Decima advice when it is on): an answer or a proposal comes back; it never runs commands,
//                    edits files, opens apps, starts local jobs or calls a frontier model (no loop back to Codex)
//   afm_code         code written by GitHub Copilot's inline completion (unlimited on every plan) for one file —
//                    a new file or one named function — returned as a diff for Codex to review and apply
// No tool writes files: Codex applies changes with its own edit tool, under OpenCode's approvals.
// Paths: relative to the project (ONBUD_MCP_ROOT or the working directory) or absolute under $HOME;
// the security gate's secret paths are refused. Everything runs on this Mac.

import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { ApfelProvider } from "../services/afm-adapter/apfel.ts";
import { findPdfPages, readDocument } from "../services/context-builder/documents.ts";
import { findByName, renderFound, type FindKind } from "../services/context-builder/finder.ts";
import { checkReferences, compileLatex, csvToLatexTable, findMainTex, hasTeX, maskLatex, renderLatexReport, unmaskLatex } from "../services/context-builder/latex.ts";
import { gatePath, redact } from "../services/security/gate.ts";
import { openDb } from "../services/telemetry/db.ts";
import { Controller } from "../services/controller/controller.ts";
import { MemoryStore } from "../services/memory/memory.ts";
import { copilotProposal } from "../services/controller/jobs.ts";
import { copilotFiller } from "../services/frontier/copilot-ls.ts";

const VERSION = "0.1.0";
// Project folder: MCP "roots" from the client when it offers them, else ONBUD_MCP_ROOT or the working
// directory. The OpenCode service starts MCP servers in the home folder, which is never used as a project.
let ROOT = resolve(process.env.ONBUD_MCP_ROOT ?? process.cwd());
const projectRoot = () => (ROOT === homedir() || ROOT === "/" ? undefined : ROOT);
const LOG = resolve(process.env.ONBUD_HOME ?? resolve(homedir(), "OnBud"), "runtime", "logs", "mcp.jsonl");
const log = (e: Record<string, unknown>) => { try { appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n"); } catch { /* best effort */ } };
let afm: ApfelProvider | undefined;
const model = () => (afm ??= new ApfelProvider({ defaultTimeoutMs: 60_000 }));
let db: ReturnType<typeof openDb> | undefined;
let ctl: Controller | undefined;
const cache = () => { try { return (db ??= openDb()); } catch { return undefined; } };

/** Resolve a user/agent-supplied path to (root, rel) that the gate accepts, or throw. */
function locate(p: string): { root: string; rel: string } {
  if (!isAbsolute(p) && !p.startsWith("~/") && !projectRoot()) throw new Error("no project folder is known: pass an absolute path");
  const abs = isAbsolute(p) ? p : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(ROOT, p);
  if (!abs.startsWith(homedir() + "/")) throw new Error("path must be inside your home folder");
  const root = projectRoot() && (abs.startsWith(ROOT + "/") || abs === ROOT) ? ROOT : resolve(abs, "..");
  const rel = relative(root, abs) || ".";
  const g = gatePath(rel, root, "read");
  if (g.verdict === "deny") throw new Error(`blocked by the security gate (${g.reasons.join(", ")})`);
  if (!existsSync(abs)) throw new Error(`not found: ${p}`);
  return { root, rel };
}

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const TOOLS = [
  { name: "read_document", description: "Read a local document (PDF incl. scanned pages via on-device OCR, Word, PowerPoint, Excel, HWPX, EPUB, Keynote/Pages/Numbers, images, notebooks, text). Use `query` to read the PDF pages most relevant to it instead of the first pages.",
    inputSchema: { type: "object", properties: { path: S("File path, relative to the project or absolute under ~"), query: S("Optional: words to find the relevant PDF pages"), max_chars: { type: "integer", description: "Default 8000" } }, required: ["path"] } },
  { name: "find_files", description: "Find files or folders by name anywhere in the user's home folder, including hidden folders like ~/.cache (Spotlight + bounded search). Names only; private locations are excluded.",
    inputSchema: { type: "object", properties: { name: S("Name or part of it, e.g. thesis or .cache"), kind: S("Optional filter", { enum: ["any", "folder", "pdf", "word", "slides", "sheet", "image", "code", "text"] }) }, required: ["name"] } },
  { name: "afm_summarize", description: "Summarize a document or text with the on-device Apple model (free, private: the raw text never leaves the Mac). Good for long PDFs before deciding what to read in full.",
    inputSchema: { type: "object", properties: { path: S("Document path (or use text)"), text: S("Text to summarize (or use path)"), focus: S("Optional question or aspect to focus on"), language: S("Answer language", { enum: ["ko", "en"] }) } } },
  { name: "afm_write", description: "Draft a short piece of text with the on-device Apple model: abstract, paragraph, caption, email, commit message. Give the facts in `context`; it does not invent citations.",
    inputSchema: { type: "object", properties: { instruction: S("What to write"), context: S("Facts and notes to use"), language: S("Output language", { enum: ["ko", "en"] }) }, required: ["instruction"] } },
  { name: "latex_check", description: "Compile a LaTeX project offline with latexmk (shell-escape off, output outside the project) and check citations/references (.bib keys, \\ref/\\label). Returns errors as file:line.",
    inputSchema: { type: "object", properties: { main: S("Optional main .tex (relative to the project); found automatically otherwise"), compile: { type: "boolean", description: "false = only the citation/reference check (default true)" } } } },
  { name: "latex_table", description: "Turn a CSV/TSV file into a booktabs LaTeX table (numeric columns right-aligned).",
    inputSchema: { type: "object", properties: { path: S("CSV or TSV file"), caption: S("Optional caption"), label: S("Optional \\label key") }, required: ["path"] } },
  { name: "latex_polish", description: "Rewrite the prose of given lines of a .tex file with the on-device model while keeping every LaTeX command, citation and math exactly (they are masked). Returns the replacement text; it does not edit the file.",
    inputSchema: { type: "object", properties: { path: S(".tex file"), from_line: { type: "integer" }, to_line: { type: "integer" }, request: S("How to rewrite, e.g. more concise and academic") }, required: ["path", "from_line", "to_line", "request"] } },
  { name: "afm_task", description: "Hand a small, self-contained local step to the on-device OnBud agent (free, private; Decima advises its routing when enabled). Good for: questions about local documents, spreadsheets (every row, group headings) and slides; git state, worktrees and change summaries; commit messages and release notes; the cause in an error log; action-item tables; secret/security scans; Mac status; counting or finding files. Returns an answer, or a proposal (command, edit) that you apply yourself — it never runs commands, edits files, opens apps or starts long jobs. If it answers that the step is too hard, do it yourself.",
    inputSchema: { type: "object", properties: { request: S("The step, in plain words, as you would ask a colleague (Korean or English); name files relative to the project"),
      folder: S("Absolute path of the project folder you are working in (pass it: OpenCode 2 shares one tool server across sessions, so the server may not know your folder)") }, required: ["request", "folder"] } },
  { name: "afm_code", description: "Have GitHub Copilot (inline completion: no premium requests, no Codex tokens) write the code for ONE file: a new file, or the body of one function named in `request` in an existing file. Returns a unified diff plus a syntax check; nothing is written. Review the diff and apply it with your own edit tool if it is right (it can be wrong: check it, run the tests). Good for routine implementations whose behaviour you can state in a sentence or two; keep design and tricky logic yourself.",
    inputSchema: { type: "object", properties: { folder: S("Absolute path of the project folder"), path: S("File to write, relative to the folder"),
      request: S("What the code must do, naming the function to (re)write, e.g. 'implement parse_date(s): ISO date or dd.mm.yyyy → date; raise ValueError otherwise'") }, required: ["folder", "path", "request"] } },
  { name: "server_jobs", description: "Read the jobs OnBud started on the user's remote servers (GPU servers, Slurm clusters; Server skill): with `job` (or `latest: true`) its state (running, done + exit code, Slurm state) and the log's last lines, read over the user's SSH; without, the list. It never uploads, starts or stops anything: the user asks the afm agent for that, and approves it.",
    inputSchema: { type: "object", properties: { job: S("Job id (e.g. j84c8joo4); omit to list jobs"), latest: { type: "boolean", description: "The most recent job" }, lines: { type: "number", description: "Log lines to return (default 60, max 400)" } } } },
];

const textSchema = (key: string, desc: string) => ({ type: "object" as const, properties: { [key]: { type: "string" as const, description: desc } }, required: [key], additionalProperties: false });

async function afmText(system: string, user: string, key: string, desc: string, maxTokens = 900): Promise<string> {
  const r = await model().generate({ system, user, schema: textSchema(key, desc), maxTokens, timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`on-device model failed (${r.failure}${r.detail ? `: ${r.detail}` : ""})`);
  return String((r.json as any)[key] ?? "");
}

async function call(name: string, a: any): Promise<string> {
  switch (name) {
    case "read_document": {
      const { root, rel } = locate(String(a.path));
      const pages = a.query && rel.toLowerCase().endsWith(".pdf")
        ? (await findPdfPages(resolve(root, rel), String(a.query).split(/\s+/))).hits.slice(0, 4).map((h) => h.page).sort((x, y) => x - y) : undefined;
      const d = await readDocument(root, rel, { maxChars: Math.min(Number(a.max_chars) || 8000, 20_000), pdfPages: 4, pages: pages?.length ? pages : undefined, db: cache() });
      if (d.error) throw new Error(d.error);
      return `${rel} — ${d.spotlightKind ?? d.kind}${d.pages ? `, ${d.pages} pages` : ""}${d.title ? `, "${d.title}"` : ""} (${d.method}${pages?.length ? `, pages ${pages.join(",")}` : ""}${d.truncated ? ", excerpt" : ""})\n\n${d.text}`;
    }
    case "find_files": {
      const found = await findByName([String(a.name)], { project: projectRoot(), kind: (a.kind ?? "any") as FindKind, max: 15 });
      return found.length ? found.map((f) => `${f.path}${f.dir ? "/" : ""}  (${f.dir ? "folder" : `${f.bytes} B`}, ${f.modified})`).join("\n") : renderFound([], [String(a.name)], false);
    }
    case "afm_summarize": {
      const ko = a.language === "ko";
      let text = a.text ? redact(String(a.text)).text : "";
      let label = "text";
      if (!text && a.path) {
        const { root, rel } = locate(String(a.path));
        label = rel;
        const isPdf = rel.toLowerCase().endsWith(".pdf");
        const pages = isPdf && a.focus ? (await findPdfPages(resolve(root, rel), String(a.focus).split(/\s+/))).hits.slice(0, 6).map((h) => h.page).sort((x, y) => x - y) : undefined;
        const d = await readDocument(root, rel, { maxChars: 24_000, pdfPages: 8, pages: pages?.length ? pages : undefined, db: cache() });
        if (d.error) throw new Error(d.error);
        text = d.text;
      }
      if (!text.trim()) throw new Error("give path or text");
      // Map-reduce in ~4.5k-character chunks (AFM's 8k-token window), at most 5 chunks.
      const chunks = text.match(/[\s\S]{1,4500}/g)!.slice(0, 5);
      const sys = `Summarize faithfully in ${ko ? "Korean" : "English"}. Keep names, numbers and terms exactly. No speculation.${a.focus ? ` Focus: ${a.focus}` : ""}`;
      const parts: string[] = [];
      for (const c of chunks) parts.push(await afmText(sys, c, "summary", "3-6 sentence summary of this part", 500));
      const final = parts.length === 1 ? parts[0] : await afmText(sys, parts.map((p, i) => `Part ${i + 1}: ${p}`).join("\n\n"), "summary", "One coherent summary of all parts, 5-8 sentences", 800);
      return `Summary of ${label} (on-device AFM, ${chunks.length} chunk${chunks.length > 1 ? "s" : ""}${text.length > 22_500 ? ", first part of a long document" : ""}):\n\n${final}`;
    }
    case "afm_write": {
      const ko = a.language === "ko";
      return afmText(`You are a careful academic writing assistant. Write in ${ko ? "Korean" : "English"}. Use only the facts given in CONTEXT; never invent citations, numbers or results.`,
        `INSTRUCTION: ${a.instruction}\n\nCONTEXT:\n${redact(String(a.context ?? "")).text.slice(0, 12_000)}`, "text", "The written text only");
    }
    case "latex_check": {
      if (!hasTeX()) throw new Error("no TeX installation found (/Library/TeX/texbin)");
      // The LaTeX project is the folder of an absolute `main`, else the known project folder.
      let texRoot = projectRoot();
      let hint = a.main ? String(a.main) : undefined;
      if (hint && (isAbsolute(hint) || hint.startsWith("~/"))) { const l = locate(hint); texRoot = l.root; hint = l.rel; }
      if (!texRoot) throw new Error("no project folder is known: pass `main` as an absolute path to the .tex file");
      const main = findMainTex(texRoot, hint);
      if (!main) throw new Error("no main .tex with \\documentclass and \\begin{document} in the project");
      const refs = checkReferences(texRoot, main);
      if (a.compile === false) return JSON.stringify(refs, null, 1);
      const rep = await compileLatex(texRoot, main);
      return renderLatexReport(rep, texRoot, main, false, refs) + (rep.pdf ? `\nPDF: ${rep.pdf}` : "");
    }
    case "latex_table": {
      const { root, rel } = locate(String(a.path));
      return csvToLatexTable(readFileSync(resolve(root, rel), "utf8").split("\n").slice(0, 200).join("\n"), a.caption ? String(a.caption) : "", a.label ? String(a.label) : "tab:data");
    }
    case "latex_polish": {
      const { root, rel } = locate(String(a.path));
      if (!rel.endsWith(".tex")) throw new Error("latex_polish works on .tex files");
      const lines = readFileSync(resolve(root, rel), "utf8").split("\n");
      const from = Number(a.from_line), to = Number(a.to_line);
      if (!(from >= 1 && to >= from && to <= lines.length && to - from < 40)) throw new Error(`line range must be within 1..${lines.length}, at most 40 lines`);
      const original = lines.slice(from - 1, to).join("\n");
      const { masked, parts } = maskLatex(original);
      const out = await afmText("You are an academic copy editor. Rewrite as asked: better word choice and structure. Tokens like ⟦3⟧ are LaTeX markup: keep each exactly once, attached to the same words. Do not add facts.",
        `REQUEST: ${a.request}\n\nTEXT:\n${masked}`, "rewritten", "The rewritten text with every ⟦n⟧ token kept");
      const restored = unmaskLatex(out, parts);
      if (!restored) throw new Error("the model dropped LaTeX markup; nothing to apply — try a smaller range");
      return `Replacement for ${rel} lines ${from}-${to} (markup unchanged; apply with your edit tool):\n\n${restored}`;
    }
    case "afm_task": {
      // The whole local agent, read-only and without a frontier (no loop back to the caller).
      // context memory read-only (the controller never writes it for a read-only task)
      ctl ??= new Controller({ afm: model(), db: cache(), memory: cache() ? new MemoryStore(cache()!) : undefined });
      const t0 = Date.now();
      // The caller's folder (OpenCode 2 starts one MCP server per service, rooted at "/" or home, not per session);
      // only a real folder inside the home folder, never the home folder itself.
      let root = projectRoot();
      if (a.folder) {
        const f = resolve(String(a.folder).replace(/^~(?=\/|$)/, homedir()));
        let dir = false; try { dir = statSync(f).isDirectory(); } catch { /* missing */ }
        if (!dir || !f.startsWith(homedir() + "/")) throw new Error("folder must be an existing folder inside your home folder");
        root = f;
      }
      const o = await ctl.handle({ prompt: String(a.request ?? ""), root, frontEnd: "mcp", allowFrontier: false, readOnly: true });
      const meta = `[OnBud · ${o.reasonCode || o.status} · ${((Date.now() - t0) / 1000).toFixed(1)}s · on-device]`;
      if (o.status === "escalation_required" || o.status === "failed")
        return `${meta}\nThe local agent could not do this step (${o.reasonCode}). Do it yourself.${o.capsule ? `\n\nWhat it gathered:\n${o.capsule.slice(0, 3000)}` : ""}`;
      const proposal = o.pendingCommand ? `\n\nProposed command (not run; run it with your own tool if appropriate):\n${o.pendingCommand}`
        : o.pendingEdit ? "\n\nThis is a proposed edit (not applied); apply it with your own edit tool if appropriate." : "";
      return `${meta}\n${o.answer ?? ""}${proposal}`;
    }
    case "afm_code": {
      const f = resolve(String(a.folder ?? "").replace(/^~(?=\/|$)/, homedir()));
      let dir = false; try { dir = statSync(f).isDirectory(); } catch { /* missing */ }
      if (!dir || !f.startsWith(homedir() + "/")) throw new Error("folder must be an existing folder inside your home folder");
      const rel = relative(f, resolve(f, String(a.path ?? "")));
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("path must be inside the folder");
      const g = gatePath(rel, f, "write");
      if (g.verdict === "deny") throw new Error(`blocked by the security gate (${g.reasons.join(", ")})`);
      const ls = await copilotFiller(f);
      if (!ls) return "GitHub Copilot is not available (not installed, signed out, or turned off). Write the code yourself.";
      const t0 = Date.now();
      const p = await copilotProposal(ls, f, rel, String(a.request ?? ""));
      const meta = `[OnBud · Copilot inline completion · ${((Date.now() - t0) / 1000).toFixed(1)}s]`;
      if (!p || !p.diff.trim()) return `${meta}\nCopilot returned no code for this. Write it yourself.`;
      return `${meta} ${p.what}; syntax: ${p.syntax ? `ERROR ${p.syntax.slice(0, 400)}` : "ok"}\nProposed diff (not applied — review, apply with your edit tool, then run the tests):\n\n${redact(p.diff).text.slice(0, 12000)}`;
    }
    case "server_jobs": {
      const R = await import("../services/server/remote.ts");
      const job = a.job ? R.findJob(String(a.job)) : a.latest ? R.findJob() : undefined;
      if (!a.job && !a.latest) return R.listJobs().slice(-20).map((j) => `${j.id}  ${j.host}  ${j.started.slice(0, 16)}  ${j.kind}  ${j.command}`).join("\n") || "No server jobs yet.";
      if (!job) throw new Error(`no job ${a.job ?? ""}`.trim());
      const r = await R.status(job, Math.min(400, Number(a.lines) || 60));
      if (!r.ok) return `[OnBud · ${job.host}] ${r.error}`;
      return `[OnBud · ${job.host} · ${job.id}] ${r.status.state}${r.status.exitCode !== undefined ? ` (exit ${r.status.exitCode})` : ""}\n$ ${job.command}\nfolder ${job.dir}, log ${job.log}\n\n${redact(r.status.tail).text.slice(-12000)}`;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC over stdio
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
let clientRoots = false;
const ROOTS_ID = "onbud-roots";
/** Ask the client for its workspace roots (server → client request); the reply arrives as a response line. */
function askRoots() { send({ jsonrpc: "2.0", id: ROOTS_ID, method: "roots/list" }); }

function serve() {
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let m: any;
  try { m = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  if (m.id === ROOTS_ID && !m.method) {   // response to our roots/list
    const uri = (m.result?.roots ?? []).map((r: any) => String(r.uri ?? "")).find((u: string) => u.startsWith("file://"));
    if (uri) { const dir = decodeURIComponent(new URL(uri).pathname); if (dir.startsWith(homedir() + "/") && existsSync(dir)) ROOT = dir; }
    log({ event: "roots", root: ROOT, n: m.result?.roots?.length ?? 0 });
    return;
  }
  const reply = (result: unknown) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, result });
  try {
    switch (m.method) {
      case "initialize":
        clientRoots = !!m.params?.capabilities?.roots;
        log({ event: "initialize", client: m.params?.clientInfo?.name, roots: clientRoots, cwd: process.cwd() });
        return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "onbud", version: VERSION }, instructions: "Local, private tools backed by the on-device Apple model. Prefer afm_summarize/read_document with query for long local documents, and afm_task for small routine local steps (git state, change summaries, spreadsheet lookups, secret scans, file counts), to save tokens; keep reasoning-heavy work yourself. For routine code in one file (a new helper, a function body whose behaviour you can state briefly) call afm_code first: GitHub Copilot writes it for free and you review the diff, apply it and run the tests; write it yourself when the diff is wrong or the logic is subtle. server_jobs reads the state and log of jobs OnBud started on the user's servers. No tool writes files." });
      case "ping": return reply({});
      case "notifications/initialized":
      case "notifications/roots/list_changed":
        if (clientRoots) askRoots();
        return;
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const t0 = Date.now();
        try {
          const text = await call(m.params?.name, m.params?.arguments ?? {});
          log({ event: "call", tool: m.params?.name, ok: true, ms: Date.now() - t0, chars: text.length });
          return reply({ content: [{ type: "text", text: redact(text).text }], isError: false, _meta: { ms: Date.now() - t0 } });
        } catch (e: any) {
          log({ event: "call", tool: m.params?.name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 120) });
          return reply({ content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true });
        }
      }
      default:
        if (m.id !== undefined && !String(m.method ?? "").startsWith("notifications/")) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  } catch (e: any) {
    send({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});
rl.on("close", () => process.exit(0));
}
if (process.argv[1]?.endsWith("afm-mcp-server.ts")) serve();
export { TOOLS, call, locate };
