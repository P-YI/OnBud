// MCP server (stdio, JSON-RPC 2.0) that lends the local OpenAFM tools to a frontier agent (Codex in
// OpenCode): AFM works as the intern on local material.
//   read_document    PDF/Word/slides/sheets/hwpx/epub/images → text (OCR on-device), optional page search
//   find_files       files/folders by name across the Mac (Spotlight + hidden folders), private paths filtered
//   afm_summarize    on-device AFM summary of a document or text (long PDFs: map-reduce over relevant pages),
//                    so the raw document stays on the Mac and Codex receives only the summary
//   afm_write        short drafts (abstract, paragraph, caption, commit message) by AFM
//   latex_check      compile with latexmk (offline) + citation/reference checks
//   latex_table      CSV/TSV → booktabs table
//   latex_polish     masked prose rewrite of given .tex lines; returns the replacement, never writes
// No tool writes files: Codex applies changes with its own edit tool, under OpenCode's approvals.
// Paths: relative to the project (OPENAFM_MCP_ROOT or the working directory) or absolute under $HOME;
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

const VERSION = "0.1.0";
// Project folder: MCP "roots" from the client when it offers them, else OPENAFM_MCP_ROOT or the working
// directory. The OpenCode service starts MCP servers in the home folder, which is never used as a project.
let ROOT = resolve(process.env.OPENAFM_MCP_ROOT ?? process.cwd());
const projectRoot = () => (ROOT === homedir() || ROOT === "/" ? undefined : ROOT);
const LOG = resolve(process.env.OPENAFM_HOME ?? resolve(homedir(), "OpenAFM"), "runtime", "logs", "mcp.jsonl");
const log = (e: Record<string, unknown>) => { try { appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n"); } catch { /* best effort */ } };
let afm: ApfelProvider | undefined;
const model = () => (afm ??= new ApfelProvider({ defaultTimeoutMs: 60_000 }));
let db: ReturnType<typeof openDb> | undefined;
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
      const refs = checkReferences(texRoot);
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
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC over stdio
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
let clientRoots = false;
const ROOTS_ID = "openafm-roots";
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
          serverInfo: { name: "openafm", version: VERSION }, instructions: "Local, private tools backed by the on-device Apple model. Prefer afm_summarize/read_document with query for long local documents to save tokens; no tool writes files." });
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
