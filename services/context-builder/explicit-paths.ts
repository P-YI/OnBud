// Explicit paths (2026-11-11): a file or folder the request names by an absolute or ~/ path is where the work
// happens, whatever folder is open (Spotlight opens ~/Desktop). Before, only the convert skill and the LaTeX
// compile looked outside the open folder; other skills read the Desktop instead or answered from another file.
// Rules: inside the home folder only; no hidden folders (~/.ssh, ~/.aws, …); every file must pass the security
// gate (keys, .pem, .env, credentials stay unreadable); the path must exist on this Mac. Paths may contain
// spaces ("~/Documents/My Paper/draft v2.docx"): the longest existing prefix of the words that follow is used.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gatePath } from "../security/gate.ts";

export interface ExplicitPath { abs: string; isDir: boolean; written: string }

const PARTICLE = /(에서|에서는|으로|로|에|의|을|를|은|는|이|가|도|만|안의|안에|폴더|파일|디렉토리|디렉터리)$/;

/** Paths written in the request that exist inside home, longest match first, without duplicates. */
export function explicitPaths(prompt: string, home = homedir()): ExplicitPath[] {
  const out: ExplicitPath[] = [];
  const H = resolve(home);
  const esc = H.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of prompt.matchAll(new RegExp(`(^|[\\s\`'"(“‘:])(~\\/|\\/Users\\/|\\/Volumes\\/|${esc}\\/|~$)`, "g"))) {
    const start = m.index! + m[1].length;
    // quoted path: up to the closing quote
    const q = m[1] && /[`'"“‘]/.test(m[1]) ? prompt.indexOf({ "`": "`", "'": "'", '"': '"', "“": "”", "‘": "’" }[m[1]]!, start) : -1;
    const ends: number[] = [];
    if (q > start) ends.push(q);
    else {
      // every word boundary up to 8 words on, longest first
      let i = start, words = 0;
      while (i <= prompt.length && words < 9) {
        const j = prompt.slice(i).search(/[\s\n]/);
        const end = j < 0 ? prompt.length : i + j;
        ends.unshift(end);
        if (j < 0) break;
        i = end + 1; words++;
      }
    }
    for (const end of ends) {
      let w = prompt.slice(start, end).replace(/[`'"”’),.!?;:]+$/, "");
      for (let k = 0; k < 2 && PARTICLE.test(w) && !exists(expand(w, H)); k++) w = w.replace(PARTICLE, "");
      const abs = expand(w, H);
      const st = stat(abs);
      if (!st) continue;
      if (!(abs === H || abs.startsWith(H + sep) || abs.startsWith("/Volumes/"))) break;
      const rel = relative(H, abs);
      if (rel.split(sep).some((s) => s.startsWith("."))) break;   // hidden folders are never opened this way
      if (!st.isDirectory() && gatePath(basename(abs), dirname(abs), "read").verdict !== "allow") break;
      if (!out.some((o) => o.abs === abs)) out.push({ abs, isDir: st.isDirectory(), written: w });
      break;
    }
  }
  return out;
}

const expand = (w: string, H: string) => resolve(w === "~" ? H : w.startsWith("~/") ? join(H, w.slice(2)) : w).normalize("NFC");
const stat = (p: string) => { try { return statSync(p); } catch { return undefined; } };
const exists = (p: string) => !!stat(p);

/** Where to work for these paths: their deepest common folder (a file's own folder when it is alone), and the
 *  named files relative to it. */
export function scopeFor(paths: ExplicitPath[]): { root: string; files: string[] } | undefined {
  if (!paths.length) return undefined;
  const dirs = paths.map((p) => (p.isDir ? p.abs : dirname(p.abs)));
  let root = dirs[0];
  for (const d of dirs.slice(1)) while (!(d === root || d.startsWith(root + sep))) root = dirname(root);
  return { root, files: paths.filter((p) => !p.isDir).map((p) => relative(root, p.abs)) };
}

/** Paths in the request that are not used: `blocked` (hidden folders, files the security gate keeps closed such as
 *  keys and .env) and `missing` (a file path with an extension that does not exist). Said plainly instead of
 *  answering from another file. */
export function pathProblems(prompt: string, found: ExplicitPath[], home = homedir()): { blocked: string[]; missing: string[] } {
  const H = resolve(home), blocked: string[] = [], missing: string[] = [];
  for (const m of prompt.matchAll(/(?:^|[\s`'"(“‘:])((?:~\/|\/Users\/)[^\s`'"”’)]*)/g)) {
    const w = m[1].replace(/[`'"”’),.!?;:]+$/, "").replace(PARTICLE, "");
    const abs = expand(w, H);
    if (found.some((f) => f.abs === abs || f.abs.startsWith(abs) || abs.startsWith(f.abs + sep))) continue;
    const rel = relative(H, abs);
    const hidden = (abs.startsWith(H + sep) && rel.split(sep).some((s) => s.startsWith("."))) || gatePath(basename(abs), dirname(abs), "read").verdict !== "allow";
    if (hidden) blocked.push(w);
    else if (/\.\w{1,6}$/.test(w) && !exists(abs)) missing.push(w);
  }
  return { blocked, missing };
}
