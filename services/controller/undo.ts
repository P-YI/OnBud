// Undo (2026-11-17): every change OnBud makes to files is recorded so it can be reversed exactly.
//   created   new files (convert outputs): undo moves them into the record (recoverable), never deletes them
//   edit      files OnBud overwrote (an AFM edit applied, a local job applied to the project): the content before
//             is copied into the record first; undo writes it back in one step (atomic.ts)
//   command   an approved Mac action with a known opposite (dark mode, volume, mute, Wi-Fi, Bluetooth, hidden files):
//             undo runs the opposite (after the usual approval). Commands without one are said to be irreversible.
// Exactness: each record keeps the SHA-256 of every file as OnBud left it. Undo touches a file only when it is still
// exactly that; if the user (or anything else) changed it since, nothing at all is changed and the user picks:
// restore anyway (the current content is kept in the record first), take the earlier version out as a separate
// file, or leave it. Undo is recorded too, so it can be redone. Records live in ~/OnBud/runtime/undo (folders 700,
// files 600), on this Mac only; records older than 14 days are removed.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { writeAtomic } from "./atomic.ts";

const HOME = () => process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const ROOT = () => join(HOME(), "runtime", "undo");
const KEEP_DAYS = 14;
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export interface UndoFile { path: string; before?: string; afterSha?: string }   // before: backup name; none = created
export interface UndoEntry {
  id: string; at: string; request: string; kind: "created" | "edit" | "command";
  files: UndoFile[];
  inverse?: { command: string; label: string };
  undone?: { at: string; kept?: string[] };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const dirOf = (id: string) => join(ROOT(), id);
function save(e: UndoEntry): void {
  mkdirSync(dirOf(e.id), { recursive: true, mode: 0o700 });
  writeFileSync(join(dirOf(e.id), "entry.json"), JSON.stringify(e, null, 1), { mode: 0o600 });
}
function newId(): string {
  const d = new Date();
  return `${d.toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
}
function prune(): void {
  try {
    for (const id of readdirSync(ROOT())) {
      const at = statSync(join(ROOT(), id)).mtimeMs;
      if (Date.now() - at > KEEP_DAYS * 86_400_000) rmSync(join(ROOT(), id), { recursive: true, force: true });
    }
  } catch { /* nothing yet */ }
}

/** New files OnBud made (they did not exist before). */
export function recordCreated(request: string, paths: string[]): UndoEntry | undefined {
  if (!paths.length) return undefined;
  prune();
  const e: UndoEntry = { id: newId(), at: new Date().toISOString(), request: request.slice(0, 200), kind: "created",
    files: paths.map((p) => ({ path: p, afterSha: sha(p) })) };
  save(e);
  return e;
}

/** Before overwriting files: copies of their current content. Call `done()` after writing, `abandon()` if nothing
 *  was written. A file that does not exist yet is recorded as created. */
export function beginEdit(request: string, paths: string[]): { entry: UndoEntry; done: () => UndoEntry; abandon: () => void } {
  prune();
  const e: UndoEntry = { id: newId(), at: new Date().toISOString(), request: request.slice(0, 200), kind: "edit", files: [] };
  mkdirSync(join(dirOf(e.id), "before"), { recursive: true, mode: 0o700 });
  paths.forEach((p, i) => {
    if (existsSync(p)) {
      if (statSync(p).size > MAX_BACKUP_BYTES) throw new Error(`too large to back up: ${basename(p)}`);
      const b = `${i}-${basename(p)}`;
      copyFileSync(p, join(dirOf(e.id), "before", b));
      e.files.push({ path: p, before: b });
    } else e.files.push({ path: p });
  });
  save(e);
  return {
    entry: e,
    done: () => { for (const f of e.files) f.afterSha = existsSync(f.path) ? sha(f.path) : undefined; save(e); return e; },
    abandon: () => rmSync(dirOf(e.id), { recursive: true, force: true }),
  };
}

/** Writes `data` to `path` with a backup recorded first (one file, one record). */
export function writeWithUndo(request: string, path: string, data: string | Buffer): UndoEntry {
  const j = beginEdit(request, [path]);
  try { writeAtomic(path, data); } catch (e) { j.abandon(); throw e; }
  return j.done();
}

/** The opposite of an approved command, when there is a clear one. `current` reads state the opposite needs
 *  (the volume before a change). */
export async function inverseOf(command: string, current: (cmd: string) => Promise<string>): Promise<{ command: string; label: string } | undefined> {
  const c = command.trim();
  const flip = (a: string, b: string) => c.includes(a) ? c.replace(a, b) : undefined;
  let m: RegExpExecArray | null;
  if (/set dark mode to (true|false)/.test(c)) return { command: c.replace(/to (true|false)/, (_, v) => `to ${v === "true" ? "false" : "true"}`), label: /to true/.test(c) ? "light mode" : "dark mode" };
  if ((m = /networksetup -setairportpower (\S+) (on|off)/.exec(c))) return { command: c.replace(/(on|off)(\s*)$/, (_, v, s) => `${v === "on" ? "off" : "on"}${s}`), label: `Wi-Fi ${m[2] === "on" ? "off" : "on"}` };
  if ((m = /blueutil -p ([01])/.exec(c))) return { command: c.replace(/-p [01]/, `-p ${m[1] === "1" ? "0" : "1"}`), label: `Bluetooth ${m[1] === "1" ? "off" : "on"}` };
  if (/set volume (with|without) output muted/.test(c) || /output muted:(true|false)/.test(c)) {
    const f = flip("with output muted", "without output muted") ?? flip("without output muted", "with output muted");
    if (f) return { command: f, label: /without/.test(c) ? "mute" : "unmute" };
  }
  if (/set volume|output volume/.test(c)) {
    const v = Number((await current(`osascript -e 'output volume of (get volume settings)'`)).trim());
    if (Number.isFinite(v)) return { command: `osascript -e 'set volume output volume ${v}'`, label: `volume back to ${v}%` };
  }
  // Finder's hidden-files toggle (⇧⌘.) is its own opposite
  if (/keystroke "\." using \{command down, shift down\}/.test(c)) return { command: c, label: "hidden files toggled back" };
  return undefined;
}

export function recordCommand(request: string, command: string, inverse: { command: string; label: string }): UndoEntry {
  prune();
  const e: UndoEntry = { id: newId(), at: new Date().toISOString(), request: request.slice(0, 200), kind: "command", files: [], inverse };
  save(e);
  void command;
  return e;
}

export function getEntry(id: string): UndoEntry | undefined {
  try { return JSON.parse(readFileSync(join(dirOf(id), "entry.json"), "utf8")); } catch { return undefined; }
}
/** Records, newest first (not undone ones only, unless `all`). */
export function entries(all = false): UndoEntry[] {
  let ids: string[] = [];
  try { ids = readdirSync(ROOT()); } catch { return []; }
  return ids.sort().reverse().map(getEntry).filter((e): e is UndoEntry => !!e && (all || !e.undone));
}
export const latestId = () => entries(true)[0]?.id;

export interface UndoResult { ok: boolean; restored: string[]; moved: string[]; conflicts: { path: string; why: "changed" | "missing" }[]; copies: string[]; command?: string; label?: string; already?: boolean }

/** Reverses one record. mode "check" changes nothing unless every file is exactly as OnBud left it; "force"
 *  keeps the current content in the record, then restores; "copy" writes the earlier versions next to the files as
 *  "<name> (before OnBud).<ext>" and changes nothing else. */
export function undo(id: string, mode: "check" | "force" | "copy" = "check"): UndoResult {
  const e = getEntry(id);
  const r: UndoResult = { ok: false, restored: [], moved: [], conflicts: [], copies: [] };
  if (!e) return r;
  if (e.undone) return { ...r, already: true };
  if (e.kind === "command") return { ...r, ok: true, command: e.inverse?.command, label: e.inverse?.label };
  for (const f of e.files) {
    // gone: a conflict if OnBud left it there; expected if OnBud removed it (a job that deleted a file)
    if (!existsSync(f.path)) { if (f.afterSha) r.conflicts.push({ path: f.path, why: "missing" }); continue; }
    if (!f.afterSha) { r.conflicts.push({ path: f.path, why: "changed" }); continue; }   // OnBud removed it, something made it again
    if (sha(f.path) !== f.afterSha) r.conflicts.push({ path: f.path, why: "changed" });
  }
  const dir = dirOf(e.id);
  if (mode === "copy") {
    for (const f of e.files) {
      if (!f.before) continue;
      const ext = extname(f.path), out = freeName(join(dirname(f.path), `${basename(f.path, ext)} (before OnBud)${ext}`));
      copyFileSync(join(dir, "before", f.before), out);
      r.copies.push(out);
    }
    return { ...r, ok: true };
  }
  if (r.conflicts.length && mode === "check") return r;
  // keep what is there now (redo, and "restore anyway" never loses the user's later work)
  mkdirSync(join(dir, "after"), { recursive: true, mode: 0o700 });
  const kept: string[] = [];
  e.files.forEach((f, i) => {
    if (!existsSync(f.path)) { if (f.before) { writeAtomic(f.path, readFileSync(join(dir, "before", f.before))); r.restored.push(f.path); } return; }
    const k = `${i}-${basename(f.path)}`;
    if (f.before) { copyFileSync(f.path, join(dir, "after", k)); writeAtomic(f.path, readFileSync(join(dir, "before", f.before))); r.restored.push(f.path); }
    else { renameSync(f.path, join(dir, "after", k)); r.moved.push(f.path); }   // a file OnBud created: moved into the record
    kept.push(k);
  });
  e.undone = { at: new Date().toISOString(), kept };
  save(e);
  return { ...r, ok: true };
}

function freeName(p: string): string {
  if (!existsSync(p)) return p;
  const ext = extname(p), stem = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) if (!existsSync(`${stem} ${i}${ext}`)) return `${stem} ${i}${ext}`;
}

/** Where undo keeps a record's files (shown to the user so nothing is out of reach). */
export const recordDir = (id: string) => dirOf(id);

/** After the opposite of a recorded command ran (approved through undo): that record is done. */
export function markCommandUndone(command: string): void {
  const e = entries().find((x) => x.kind === "command" && x.inverse?.command === command);
  if (e) { e.undone = { at: new Date().toISOString() }; save(e); }
}
