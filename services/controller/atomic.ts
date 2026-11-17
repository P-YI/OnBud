// Files appear whole or not at all (2026-11-17). A tool writes to a hidden temporary name next to the target
// (same folder, so the rename stays on one volume), and the file is moved into place only when the tool succeeded
// and its output was checked. A stopped or failed run leaves no half-written file; an existing file is never
// replaced by a new output (placeNew fails instead), and an overwrite (writeAtomic) is one rename.
import { closeSync, existsSync, fsyncSync, linkSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** A temporary path next to `final`, hidden, keeping its extension (tools such as sips read the format from it). */
export function tmpFor(final: string): string {
  const ext = extname(final);
  return join(dirname(final), `.${basename(final, ext)}.onbud-${process.pid}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

/** Moves a finished temporary file to `final`, which must not exist (a link fails if it does: no overwrite). */
export function placeNew(tmp: string, final: string): void {
  linkSync(tmp, final);
  unlinkSync(tmp);
}

/** Removes a temporary file, if it is there. */
export function discard(tmp: string | undefined): void {
  if (!tmp) return;
  try { unlinkSync(tmp); } catch { /* already gone */ }
}

/** Replaces `path` with `data` in one step, keeping its permissions: written and flushed under a temporary name,
 *  then renamed over the original. */
export function writeAtomic(path: string, data: string | Buffer): void {
  const tmp = tmpFor(path);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  try {
    writeFileSync(tmp, data, { mode });
    const fd = openSync(tmp, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) { discard(tmp); throw e; }
}

/** The outputs of one task: each is written under a temporary name (`fresh`), shown by its final name (`finalOf`),
 *  and moved into place together when the task succeeded (`commit`); otherwise every temporary file is removed. */
export class Staging {
  private m = new Map<string, string>();   // temporary → final
  /** A temporary path for `final` (reserved: `taken` keeps a second output from picking the same name). */
  reserve(final: string): string { const t = tmpFor(final); this.m.set(t, final); return t; }
  taken(): Set<string> { return new Set(this.m.values()); }
  finalOf(p: string): string { return this.m.get(p) ?? p; }
  /** Moves every finished temporary file into place; returns the final paths. */
  commit(): string[] {
    const placed: string[] = [];
    for (const [t, f] of this.m) if (existsSync(t)) { placeNew(t, f); placed.push(f); }
    this.m.clear();
    return placed;
  }
  discardAll(): void { for (const t of this.m.keys()) discard(t); this.m.clear(); }
}
