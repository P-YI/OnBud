// The user's own apps (2026-11-01): when the agent opens something, it uses the app the user chose, not a fixed
// one. Order: an app named in the request ("iTerm으로") → ~/OpenAFM/config/apps.json {"terminal": "iTerm", …} →
// the macOS default (LaunchServices: the ssh: handler for the terminal, https: for the browser, a .txt file for
// the editor). "Make iTerm2 Default Term" in iTerm's menu changes the system default, so it is followed with no
// configuration. Terminals get a one-off .command file (owner-only) opened with `open -a`, which Terminal and iTerm
// both run.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type AppKind = "terminal" | "browser" | "editor";
const HOME = process.env.OPENAFM_HOME ?? join(homedir(), "OpenAFM");
const TMP = join(HOME, "runtime", "tmp");
const run = (cmd: string, args: string[], timeout = 5000) => new Promise<{ code: number; out: string }>((res) =>
  execFile(cmd, args, { timeout }, (e: any, out) => res({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(out ?? "") })));

// Names people use → app bundles to look for (first one installed wins).
const KNOWN: Record<string, string[]> = {
  iterm: ["iTerm.app", "iTerm2.app"], terminal: ["Terminal.app"], warp: ["Warp.app"], ghostty: ["Ghostty.app"], kitty: ["kitty.app"], alacritty: ["Alacritty.app"],
  "vs code": ["Visual Studio Code.app"], vscode: ["Visual Studio Code.app"], cursor: ["Cursor.app"], zed: ["Zed.app"], textedit: ["TextEdit.app"], bbedit: ["BBEdit.app"],
  chrome: ["Google Chrome.app"], safari: ["Safari.app"], arc: ["Arc.app"], firefox: ["Firefox.app"],
};
const KO: Record<string, string> = { 아이텀: "iterm", 터미널: "terminal", 크롬: "chrome", 사파리: "safari", 커서: "cursor", 비주얼: "vs code" };
const DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")];

/** The installed app for a name ("iTerm", "vs code"), or undefined. */
export function findApp(name: string): string | undefined {
  const key = KO[name] ?? name.toLowerCase();
  for (const b of KNOWN[key] ?? [`${name}.app`]) for (const d of DIRS) if (existsSync(join(d, b))) return join(d, b);
  return undefined;
}

/** An app named in the request, if one of the known apps is mentioned and installed. */
export function appInRequest(prompt: string): string | undefined {
  const p = prompt.toLowerCase();
  for (const k of [...Object.keys(KNOWN), ...Object.keys(KO)].sort((a, b) => b.length - a.length)) {
    if (k === "terminal" || k === "터미널") continue;   // the generic word, not the app
    if (new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(p)) { const a = findApp(k); if (a) return a; }
  }
  return undefined;
}

function configured(kind: AppKind): string | undefined {
  try { const v = JSON.parse(readFileSync(join(HOME, "config", "apps.json"), "utf8"))[kind]; return typeof v === "string" ? findApp(v) ?? (existsSync(v) ? v : undefined) : undefined; } catch { return undefined; }
}

async function systemDefault(kind: AppKind): Promise<string | undefined> {
  mkdirSync(TMP, { recursive: true });
  const probe = join(TMP, "default-editor-probe.txt");
  if (kind === "editor" && !existsSync(probe)) writeFileSync(probe, "");
  const url = kind === "terminal" ? `$.NSURL.URLWithString("ssh://localhost")` : kind === "browser" ? `$.NSURL.URLWithString("https://example.com")` : `$.NSURL.fileURLWithPath(${JSON.stringify(probe)})`;
  const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); const a = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(${url}); a.isNil() ? "" : a.path.js`]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
}

export interface Chosen { app: string; why: "request" | "config" | "system" }
export async function chooseApp(kind: AppKind, prompt = ""): Promise<Chosen | undefined> {
  const req = appInRequest(prompt);
  if (req) return { app: req, why: "request" };
  const cfg = configured(kind);
  if (cfg) return { app: cfg, why: "config" };
  const sys = await systemDefault(kind);
  return sys ? { app: sys, why: "system" } : undefined;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Opens a terminal window in `cwd`, optionally running `command` there (then a login shell stays open). */
export async function openTerminal(cwd: string, command: string | undefined, chosen: Chosen): Promise<boolean> {
  mkdirSync(TMP, { recursive: true });
  for (const f of readdirSync(TMP)) if (f.startsWith("openafm-term-")) rmSync(join(TMP, f), { force: true });
  const file = join(TMP, `openafm-term-${Date.now().toString(36)}.command`);
  writeFileSync(file, `#!/bin/zsh -l\ncd ${q(cwd)} || exit 1\n${command ? `${command}\n` : ""}exec "$SHELL" -l\n`, { mode: 0o700 });
  return (await run("/usr/bin/open", ["-a", chosen.app, file])).code === 0;
}

/** Opens a file (or URL, for the browser) with the chosen app. */
export async function openWith(target: string, chosen: Chosen): Promise<boolean> {
  return (await run("/usr/bin/open", ["-a", chosen.app, target])).code === 0;
}

export const appName = (path: string) => basename(path).replace(/\.app$/, "");
