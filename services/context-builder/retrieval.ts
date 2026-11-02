// Deterministic, read-only local retrieval for the controller: code search (rg or git grep),
// git status/diff, bounded file snippets and Spotlight file discovery.
// Every path goes through the security gate's path check; every output is redacted and size-capped.
// Commands run via execFile with argv arrays (no shell), so nothing here is shell-injectable.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gatePath, redact } from "../security/gate.ts";

export interface Hit { path: string; line: number; text: string }

const MAX_OUTPUT = 512 * 1024;

function run(cmd: string, args: string[], cwd: string, timeoutMs = 5000): Promise<{ code: number; stdout: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } },
      (err: any, stdout) => res({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout ?? "") }));
  });
}

let rgAvailable: boolean | undefined;
async function hasRg(cwd: string): Promise<boolean> {
  if (rgAvailable === undefined) rgAvailable = (await run("rg", ["--version"], cwd, 2000)).code === 0;
  return rgAvailable;
}

function allowed(root: string, rel: string): boolean {
  return gatePath(rel, root, "read").verdict === "allow";
}

/** Fixed-string search by default; returns at most `max` hits from allowed files. */
export async function searchCode(root: string, pattern: string, opts: { glob?: string; max?: number; regex?: boolean } = {}): Promise<Hit[]> {
  const max = opts.max ?? 20;
  if (!pattern.trim()) return [];
  let out: string;
  if (await hasRg(root)) {
    const args = ["--line-number", "--no-heading", "--color=never", "--max-columns=300", "--max-count=5"];
    if (!opts.regex) args.push("--fixed-strings");
    if (opts.glob && opts.glob !== "*") args.push("--glob", opts.glob);
    args.push("--", pattern, ".");
    out = (await run("rg", args, root)).stdout;
  } else {
    const args = ["grep", "--untracked", "--line-number", "--no-color", "-I", "--max-count=5"];
    args.push(opts.regex ? "-E" : "-F", "-e", pattern, "--");
    // git pathspec globs match across directories ("*.py" also matches src/a/b.py)
    if (opts.glob && opts.glob !== "*") args.push(opts.glob);
    out = (await run("git", args, root)).stdout;
  }
  const hits: Hit[] = [];
  for (const line of out.split("\n")) {
    const m = /^(?:\.\/)?([^:]+):(\d+):(.*)$/.exec(line);
    if (!m || !allowed(root, m[1])) continue;
    hits.push({ path: m[1], line: Number(m[2]), text: redact(m[3].trim().slice(0, 240)).text });
    if (hits.length >= max) break;
  }
  return hits;
}

export interface Snippet { path: string; start: number; end: number; text: string; truncated: boolean }

/** Read lines [start, end] (1-based, inclusive) of an allowed text file, capped at maxLines. */
export function readSnippet(root: string, path: string, start = 1, end?: number, maxLines = 80): Snippet | { error: string } {
  const g = gatePath(path, root, "read");
  if (g.verdict !== "allow") return { error: `blocked:${g.reasons.join(",")}` };
  const abs = resolve(root, path);
  try {
    if (statSync(abs).size > 2 * 1024 * 1024) return { error: "file_too_large" };
    const lines = readFileSync(abs, "utf8").split("\n");
    const s = Math.max(1, start);
    const e = Math.min(lines.length, end ?? s + maxLines - 1, s + maxLines - 1);
    const body = lines.slice(s - 1, e).map((l, i) => `${s + i}| ${l}`).join("\n");
    return { path: relative(root, abs), start: s, end: e, text: redact(body).text, truncated: e < (end ?? lines.length) };
  } catch (e: any) {
    return { error: e?.code === "ENOENT" ? "not_found" : "read_failed" };
  }
}

/** Bounded, gated directory listing (one level). Hidden entries and secret files are omitted. */
export function listDir(root: string, path = ".", max = 60): string[] | { error: string } {
  const rel = path.trim() || ".";
  const g = gatePath(rel, root, "read");
  if (g.verdict !== "allow") return { error: `blocked:${g.reasons.join(",")}` };
  try {
    const abs = resolve(root, rel);
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .filter((e) => gatePath(join(rel, e.name), root, "read").verdict === "allow")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return entries.length > max ? [...entries.slice(0, max), `… (${entries.length - max} more)`] : entries;
  } catch (e: any) {
    return { error: e?.code === "ENOENT" ? "not_found" : e?.code === "ENOTDIR" ? "not_a_directory" : "list_failed" };
  }
}

export async function gitStatus(root: string): Promise<string> {
  const r = await run("git", ["status", "--short", "--branch"], root);
  return r.code === 0 ? redact(r.stdout.slice(0, 4000)).text : "";
}

/** Bounded diff: stat summary plus the first `maxLines` lines of the patch. */
export async function gitDiff(root: string, opts: { staged?: boolean; path?: string; maxLines?: number } = {}): Promise<string> {
  const base = ["diff", "--no-color", "--no-ext-diff"];
  if (opts.staged) base.push("--staged");
  const tail = opts.path && allowed(root, opts.path) ? ["--", opts.path] : [];
  const stat = await run("git", [...base, "--stat", ...tail], root);
  const patch = await run("git", [...base, "-U2", ...tail], root);
  const lines = patch.stdout.split("\n");
  const max = opts.maxLines ?? 120;
  const body = lines.slice(0, max).join("\n") + (lines.length > max ? `\n… (${lines.length - max} more lines)` : "");
  return redact(`${stat.stdout.trim()}\n${body}`).text;
}

export async function recentlyChanged(root: string, days = 7, max = 15): Promise<string[]> {
  const r = await run("git", ["log", `--since=${days}.days`, "--name-only", "--pretty=format:"], root);
  const seen = new Set<string>();
  for (const p of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (allowed(root, p)) seen.add(p);
    if (seen.size >= max) break;
  }
  return [...seen];
}

// Spotlight is used for *file discovery* only (names, docs, notes, PDFs). Measured limits on this Mac:
// .ts files are typed as MPEG-2 transport streams (no text content indexed), hidden directories are
// skipped and new files appear with a delay — so code content search stays with rg/git grep.
const SPOTLIGHT_SKIP = /(^|\/)(\.[^/]+|node_modules|dist|build|__pycache__)(\/|$)/;

export function filterSpotlight(root: string, absPaths: string[], max: number): string[] {
  const r = resolve(root);
  const out: string[] = [];
  for (const abs of absPaths) {
    if (!abs.startsWith(r + "/")) continue;
    const rel = abs.slice(r.length + 1);
    if (SPOTLIGHT_SKIP.test(rel) || !allowed(root, rel)) continue;
    out.push(rel);
    if (out.length >= max) break;
  }
  return out;
}

export async function spotlightFind(root: string, query: string, opts: { nameOnly?: boolean; max?: number } = {}): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const args = ["-onlyin", resolve(root)];
  if (opts.nameOnly) args.push("-name", q);
  else args.push(q);
  const r = await run("/usr/bin/mdfind", args, root, 4000);
  return filterSpotlight(root, r.stdout.split("\n").filter(Boolean), opts.max ?? 15);
}
