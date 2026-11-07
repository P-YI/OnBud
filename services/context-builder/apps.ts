// The user's own apps (2026-11-01): when the agent opens something, it uses the app the user chose, not a fixed
// one. Order: an app named in the request ("iTerm으로") → ~/OnBud/config/apps.json {"terminal": "iTerm", …} →
// the macOS default (LaunchServices: the ssh: handler for the terminal, https: for the browser, a .txt file for
// the editor). "Make iTerm2 Default Term" in iTerm's menu changes the system default, so it is followed with no
// configuration. Terminals get a one-off .command file (owner-only) opened with `open -a`, which Terminal and iTerm
// both run. Ghostty does not run .command files (it opens folders and unix executables): it gets a window through
// its AppleScript dictionary (Ghostty ≥ 1.3: initial working directory + initial input), and the folder alone
// if scripting is refused (macOS asks once to let OnBud control Ghostty).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type AppKind = "terminal" | "browser" | "editor";
const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
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
  if (/ghostty/i.test(appName(chosen.app))) {
    const as = (t: string) => JSON.stringify(t);   // AppleScript string literal (same escapes for " and \\)
    const script = `tell application "Ghostty"\nset cfg to new surface configuration\nset initial working directory of cfg to ${as(cwd)}\n`
      + (command ? `set initial input of cfg to ${as(command)} & linefeed\n` : "") + `new window with configuration cfg\nactivate\nend tell`;
    if ((await run("/usr/bin/osascript", ["-e", script], 15_000)).code === 0) return true;
    return (await run("/usr/bin/open", ["-a", chosen.app, cwd])).code === 0 && !command;
  }
  mkdirSync(TMP, { recursive: true });
  for (const f of readdirSync(TMP)) if (f.startsWith("onbud-term-")) rmSync(join(TMP, f), { force: true });
  const file = join(TMP, `onbud-term-${Date.now().toString(36)}.command`);
  writeFileSync(file, `#!/bin/zsh -l\ncd ${q(cwd)} || exit 1\n${command ? `${command}\n` : ""}exec "$SHELL" -l\n`, { mode: 0o700 });
  return (await run("/usr/bin/open", ["-a", chosen.app, file])).code === 0;
}

/** Opens a file (or URL, for the browser) with the chosen app. */
export async function openWith(target: string, chosen: Chosen): Promise<boolean> {
  return (await run("/usr/bin/open", ["-a", chosen.app, target])).code === 0;
}

export const appName = (path: string) => basename(path).replace(/\.app$/, "");

// ---------------------------------------------------------------- any installed app, by name (2026-11-02)
// Works on any Mac: Spotlight lists every application bundle with its localized name ("계산기" for
// Calculator.app on a Korean system); without Spotlight, the standard folders are scanned. Helper apps inside
// other bundles, frameworks and Application Support are left out, so "Logi Options+" is the app in
// /Applications, not its background agent.
export interface InstalledApp { path: string; name: string; file: string }
let appCache: { at: number; apps: InstalledApp[] } | undefined;
const HIDDEN = /\.app\/|\/Frameworks\/|\/PrivateFrameworks\/|\/Application Support\/|\/CoreServices\/(?!Applications\/)|\/Library\/(Image Capture|Input Methods|Printers|Services|Screen Savers)\//;
const USER_FACING = /^(\/Applications\/|\/System\/Applications\/|\/System\/Library\/CoreServices\/Applications\/|\/System\/Library\/CoreServices\/Finder\.app$)/;

export async function installedApps(): Promise<InstalledApp[]> {
  if (appCache && Date.now() - appCache.at < 10 * 60_000) return appCache.apps;
  const r = await run("/usr/bin/mdfind", ["-attr", "kMDItemDisplayName", 'kMDItemContentType == "com.apple.application-bundle"'], 10_000);
  let apps: InstalledApp[] = r.out.split("\n").map((l) => /^(.+?\.app)\s+kMDItemDisplayName = (.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ path: m[1], name: (m[2] === "(null)" ? basename(m[1], ".app") : m[2]).trim(), file: basename(m[1], ".app") }));
  if (apps.length < 10) {   // Spotlight off or still indexing: the standard folders
    apps = [];
    for (const d of [...DIRS, "/System/Library/CoreServices/Applications"]) {
      let entries: string[] = []; try { entries = readdirSync(d); } catch { continue; }
      for (const e of entries) if (e.endsWith(".app")) apps.push({ path: join(d, e), name: e.replace(/\.app$/, ""), file: e.replace(/\.app$/, "") });
    }
  }
  apps = apps.filter((a) => !HIDDEN.test(a.path.slice(1)) || USER_FACING.test(a.path));
  appCache = { at: Date.now(), apps };
  return apps;
}

// Korean ways of writing common app names (the localized display names already cover Apple's own apps).
const ALIAS: Record<string, string> = { 크롬: "chrome", 사파리: "safari", 파인더: "finder", 아이텀: "iterm", 슬랙: "slack", 노션: "notion", 줌: "zoom", 디스코드: "discord", 스포티파이: "spotify",
  엑셀: "excel", 워드: "word", 파워포인트: "powerpoint", 카톡: "kakaotalk", 카카오톡: "kakaotalk", 비주얼스튜디오코드: "visual studio code", 브이에스코드: "visual studio code", 커서: "cursor",
  깃허브데스크톱: "github desktop", 도커: "docker", 피그마: "figma", 옵시디언: "obsidian", 텔레그램: "telegram", 왓츠앱: "whatsapp", 라인: "line", 웨일: "whale", 파이어폭스: "firefox", 엣지: "edge", vscode: "visual studio code", vs코드: "visual studio code", 브이에스코드: "visual studio code" };
const squash = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const words = (s: string) => s.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** 0–100: how well an app's name or file name fits the asked name. */
export function appScore(query: string, app: InstalledApp): number {
  const q0 = squash(query.replace(/\s+/g, ""));
  const q = ALIAS[q0] ? ALIAS[q0] : query;
  const qs = squash(q), qw = words(q);
  let best = 0;
  for (const n of [app.name, app.file]) {
    const ns = squash(n), nw = words(n);
    if (!ns || !qs) continue;
    if (ns === qs) { best = Math.max(best, 100); continue; }
    // Every asked word starts one of the name's words ("logi option" → "Logi Options+"). Names with fewer extra
    // words rank higher, and whole-word matches higher than prefixes ("chrome" → "Google Chrome", not
    // "Chrome Remote Desktop").
    if (qw.length && qw.every((w) => nw.some((x) => x.startsWith(w) || (w.length >= 4 && x.includes(w)))))
      best = Math.max(best, 88 - 5 * Math.max(0, nw.length - qw.length) + (qw.every((w) => nw.includes(w)) ? 4 : 0));
    if (ns.startsWith(qs) && qs.length >= 3) best = Math.max(best, 80 - Math.min(10, ns.length - qs.length));
    else if (qs.length >= 4 && ns.includes(qs)) best = Math.max(best, 70);
  }
  return best + (USER_FACING.test(app.path) ? 1 : 0);
}

/** The best installed app for a name, or the close candidates when it is ambiguous. */
export async function findInstalledApp(query: string): Promise<{ app?: InstalledApp; candidates: InstalledApp[] }> {
  const scored = (await installedApps()).map((a) => ({ a, s: appScore(query, a) })).filter((x) => x.s >= 70).sort((x, y) => y.s - x.s);
  const seen = new Set<string>();
  const uniq = scored.filter((x) => { const k = squash(x.a.name); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!uniq.length) return { candidates: [] };
  if (uniq.length > 1 && uniq[0].s < 100 && uniq[0].s - uniq[1].s < 5) return { candidates: uniq.slice(0, 5).map((x) => x.a) };
  return { app: uniq[0].a, candidates: uniq.slice(1, 4).map((x) => x.a) };
}

export async function launchApp(app: InstalledApp): Promise<boolean> {
  return (await run("/usr/bin/open", ["-a", app.path])).code === 0;
}

// ---------------------------------------------------------------- VS Code + GitHub Copilot (2026-11-03)
// Copilot's unlimited parts on a Student/Free plan are inline suggestions, next edit suggestions and chat with the
// included models (Auto): all inside the editor. So the agent hands work to the editor through VS Code's own CLI
// (`code chat`, `code -g file:line`): the user then works in Copilot as usual. Nothing calls Copilot's servers
// from here, and no request is made on the user's behalf.
export function vscodeCli(): string | undefined {
  const app = findApp("vs code");
  const cli = app ? join(app, "Contents", "Resources", "app", "bin", "code") : undefined;
  return cli && existsSync(cli) ? cli : undefined;
}

/** Opens VS Code's Copilot chat in `folder` with the prompt (and files attached), in ask, edit or agent mode. */
export async function copilotChat(prompt: string, folder: string | undefined, files: string[] = [], mode: "ask" | "edit" | "agent" = "agent"): Promise<boolean> {
  const cli = vscodeCli();
  if (!cli) return false;
  if (folder) await run(cli, [folder], 15_000);   // the project window first, so the chat runs in it
  const args = ["chat", "-m", mode, "-r", ...files.slice(0, 8).flatMap((f) => ["-a", f]), prompt];
  return (await run(cli, args, 15_000)).code === 0;
}

/** Opens a file at a line in VS Code or Cursor (their CLIs take -g file:line), else with `open -a`. */
export async function openAt(file: string, line: number | undefined, chosen: Chosen): Promise<boolean> {
  const cli = join(chosen.app, "Contents", "Resources", "app", "bin", /cursor/i.test(chosen.app) ? "cursor" : "code");
  if (line && /(Visual Studio Code|Cursor)\.app$/.test(chosen.app) && existsSync(cli)) return (await run(cli, ["-g", `${file}:${line}`], 15_000)).code === 0;
  return openWith(file, chosen);
}
