// Local actions beyond the fixed skills (2026-11-13): "say this", "keep my Mac awake for an hour", "pause the music",
// "remind me to call mom at 5pm", "set a timer for 10 minutes", "start an email to alex@…".
//   1. recipes  vetted command templates; AFM picks one and fills its slots, code checks every slot and builds
//               the command (AFM never writes the command for these)
//   2. planned  anything else: AFM writes one macOS command; code compiles it (bash -n, osacompile for AppleScript),
//               feeds a compile error back once, classifies it with the command gate; it is shown as AFM-written
//               and runs only after approval (read-only commands run at once)
// Why both: alone, AFM wrote a correct command for 5 of 20 such requests; 10 did not compile, and 5 compiled but did
// something else ("caffeinate -t 1h", "remind me at 5pm" → set the system date). Recipes take the common requests out
// of the model's hands; the planned path keeps the long tail possible, behind compile checks, the gate and approval.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AFMProvider } from "../afm-adapter/provider.ts";
import { classifyCommand, execCommand } from "../context-builder/terminal.ts";
import { findApp } from "../context-builder/apps.ts";

/** The user's shortcut names (the shortcuts CLI; no app control permission needed). */
export function userShortcuts(): string[] {
  try { return execFileSync("/usr/bin/shortcuts", ["list"], { timeout: 10_000, encoding: "utf8" }).split("\n").map((x) => x.trim()).filter(Boolean); } catch { return []; }
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const asStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;   // AppleScript string literal
const osa = (...lines: string[]) => `osascript ${lines.map((l) => `-e ${q(l)}`).join(" ")}`;

export interface Slots { text?: string; url?: string; number?: number; app?: string; email?: string; subject?: string; body?: string; title?: string; when?: string; folder?: string; kind?: string }
interface Recipe { id: string; desc: string; immediate: boolean; build: (s: Slots, now: Date) => string | undefined; done: [string, string] }

/** "5pm", "17:30", "오후 5시", "in 20 minutes", "tomorrow 9am" → a Date, or undefined. */
export function parseWhen(w: string | undefined, now = new Date()): Date | undefined {
  if (!w) return undefined;
  const s = w.toLowerCase().trim();
  const rel = /in\s+(\d+)\s*(min|minute|minutes|hour|hours|h)\b|(\d+)\s*(분|시간)\s*(후|뒤)/.exec(s);
  if (rel) { const n = Number(rel[1] ?? rel[3]); const hours = /h|hour|시간/.test(rel[2] ?? rel[4]); return new Date(now.getTime() + n * (hours ? 3_600_000 : 60_000)); }
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s) ?? null;
  const ko = /(오전|오후)?\s*(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분|반)?/.exec(s);
  let h: number, min = 0;
  if (ko) { h = Number(ko[2]); min = ko[3] ? Number(ko[3]) : /반/.test(s) ? 30 : 0; if (ko[1] === "오후" && h < 12) h += 12; if (ko[1] === "오전" && h === 12) h = 0; }
  else if (m) { h = Number(m[1]); min = m[2] ? Number(m[2]) : 0; if (m[3] === "pm" && h < 12) h += 12; if (m[3] === "am" && h === 12) h = 0; if (!m[3] && !m[2] && h < 8) h += 12; }
  else return undefined;
  if (h > 23 || min > 59) return undefined;
  const d = new Date(now); d.setHours(h, min, 0, 0);
  if (/(tomorrow|내일)/.test(s) || d <= now) d.setDate(d.getDate() + 1);
  return d;
}
const asDate = (d: Date) => `date ${asStr(d.toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(" at ", " "))}`;
const minutes = (s: Slots) => (typeof s.number === "number" && s.number > 0 && s.number <= 24 * 60 ? Math.round(s.number) : undefined);
const clean = (t: string | undefined, max = 300) => (t ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export const RECIPES: Recipe[] = [
  { id: "say", desc: "speak text aloud (text)", immediate: true, build: (s) => clean(s.text) ? `say -- ${q(clean(s.text))}` : undefined, done: ["소리 내어 읽었어요.", "Spoke it aloud."] },
  { id: "say_clipboard", desc: "read the clipboard aloud", immediate: true, build: () => "pbpaste | say", done: ["클립보드를 읽었어요.", "Read the clipboard aloud."] },
  { id: "copy_text", desc: "copy text to the clipboard (text)", immediate: true, build: (s) => clean(s.text, 2000) ? `printf %s ${q(clean(s.text, 2000))} | pbcopy` : undefined, done: ["클립보드에 복사했어요.", "Copied to the clipboard."] },
  { id: "open_url", desc: "open a web address, optionally in an app (url, app)", immediate: true,
    build: (s) => { let u = clean(s.url, 500); if (u && !/^https?:\/\//i.test(u) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(u)) u = `https://${u}`; const app = s.app && /^[\w .-]{2,30}$/.test(s.app) ? findApp(s.app.trim()) ?? findApp(s.app.trim().replace(/^google\s+/i, "")) : undefined; return /^https?:\/\/[^\s'"]+$/i.test(u) ? `open ${app ? `-a ${q(app)} ` : ""}${q(u)}` : undefined; },
    done: ["열었어요.", "Opened it."] },
  { id: "keep_awake", desc: "keep the Mac awake for a number of minutes (number)", immediate: true,
    build: (s) => { const m = minutes(s); return m ? `nohup caffeinate -d -t ${m * 60} >/dev/null 2>&1 &` : undefined; }, done: ["잠자기를 막아 뒀어요 (caffeinate).", "The Mac stays awake (caffeinate)."] },
  { id: "timer", desc: "a timer that notifies after a number of minutes (number, text)", immediate: true,
    build: (s) => { const m = minutes(s); const t = clean(s.text, 80).replace(/['"\\`$]/g, "") || "Timer"; return m ? `nohup sh -c ${q(`sleep ${m * 60}; ${osa(`display notification ${asStr(t)} with title "OnBud" sound name "Glass"`)}`)} >/dev/null 2>&1 &` : undefined; },
    done: ["타이머를 맞췄어요. 시간이 되면 알림이 와요.", "Timer set; a notification comes when it ends."] },
  { id: "notify", desc: "show a notification now (text)", immediate: true, build: (s) => clean(s.text, 200) ? osa(`display notification ${asStr(clean(s.text, 200))} with title "OnBud"`) : undefined, done: ["알림을 띄웠어요.", "Notification shown."] },
  { id: "music_playpause", desc: "play or pause Music", immediate: true, build: () => osa('tell application "Music" to playpause'), done: ["음악을 재생/일시정지했어요.", "Toggled play/pause in Music."] },
  { id: "music_pause", desc: "pause Music", immediate: true, build: () => osa('tell application "Music" to pause'), done: ["음악을 멈췄어요.", "Paused Music."] },
  { id: "music_next", desc: "next track in Music", immediate: true, build: () => osa('tell application "Music" to next track'), done: ["다음 곡으로 넘겼어요.", "Skipped to the next track."] },
  { id: "music_previous", desc: "previous track in Music", immediate: true, build: () => osa('tell application "Music" to previous track'), done: ["이전 곡으로 돌아갔어요.", "Back to the previous track."] },
  { id: "music_now", desc: "which song is playing in Music", immediate: true,
    build: () => osa('if application "Music" is running then', 'tell application "Music"', 'if player state is playing then return (name of current track) & " — " & (artist of current track)', 'return "nothing playing"', 'end tell', 'end if', 'return "Music is not running"'), done: ["", ""] },
  { id: "email_draft", desc: "start an email draft, not sent (email, subject, body)", immediate: true,
    build: (s) => { const to = clean(s.email, 200); if (to && !/^[^\s@'"]+@[^\s@'"]+\.[a-z]{2,}$/i.test(to)) return undefined; const qs = [s.subject && `subject=${encodeURIComponent(clean(s.subject, 200))}`, s.body && `body=${encodeURIComponent(clean(s.body, 2000))}`].filter(Boolean).join("&"); return `open ${q(`mailto:${to}${qs ? `?${qs}` : ""}`)}`; },
    done: ["메일 초안을 열었어요. 보내기는 직접 눌러 주세요.", "Opened a draft; sending is up to you."] },
  { id: "open_last_download", desc: "open the most recently downloaded file", immediate: true, build: () => `cd "$HOME/Downloads" && open -- "$(ls -t | head -1)"`, done: ["가장 최근에 받은 파일을 열었어요.", "Opened the newest download."] },
  { id: "find_files", desc: "list files of a kind that were changed recently (e.g. PDFs I edited this week)", immediate: true,
    build: (s) => { const UTI: Record<string, string> = { pdf: "com.adobe.pdf", image: "public.image", document: "public.content", presentation: "public.presentation", spreadsheet: "public.spreadsheet" }; const d = Math.min(365, Math.max(1, Math.round(s.number ?? 7))); const k = UTI[(s.kind ?? "").toLowerCase()]; return `mdfind -onlyin "$HOME" ${q(`${k ? `kMDItemContentTypeTree == "${k}" && ` : ""}kMDItemContentModificationDate >= $time.today(-${d})`)} | grep -v '/\\.' | head -30`; },
    done: ["", ""] },
  { id: "count_files", desc: "count the files in a folder under home (folder)", immediate: true,
    build: (s) => { const f = clean(s.folder, 200).replace(/^~\/?/, "").replace(/^\/Users\/[^/]+\/?/, ""); return f && !/(^|\/)\.|\.\.|['"`$\\]/.test(f) ? `find "$HOME/${f}" -maxdepth 1 -type f | wc -l` : undefined; }, done: ["", ""] },
  { id: "focus_on", desc: "turn on Do Not Disturb or a Focus", immediate: true,
    build: () => { const sc = userShortcuts().find((n) => /(do not disturb|방해\s?금지|focus|집중)/i.test(n)); return sc ? `shortcuts run ${q(sc)}` : `open 'x-apple.systempreferences:com.apple.Focus-Settings.extension' && open ${q("shortcuts://gallery/search?query=Focus")}`; },
    done: ["집중 모드를 켰어요 (단축어). 단축어가 없으면 집중 모드 설정과 단축어 갤러리를 열어요.", "Focus is on (via your shortcut). Without one, the Focus settings and the Shortcuts Gallery open instead."] },
  { id: "uptime", desc: "how long the Mac has been running since it started", immediate: true, build: () => "uptime", done: ["", ""] },
  { id: "frontmost_app", desc: "which app is in front right now", immediate: true, build: () => osa('tell application "System Events" to get name of first application process whose frontmost is true'), done: ["", ""] },
  { id: "top_memory", desc: "which apps use the most memory", immediate: true, build: () => `ps -axo rss=,comm= | sort -rn | head -8 | awk '{printf "%6.0f MB  %s\\n", $1/1024, $2}'`, done: ["", ""] },
  { id: "folder_size", desc: "how big a folder under home is (folder)", immediate: true,
    build: (s) => { const f = clean(s.folder, 200).replace(/^~\/?/, "").replace(/^\/Users\/[^/]+\/?/, ""); return f && !/(^|\/)\.|\.\.|['"`$\\]/.test(f) ? `du -sh "$HOME/${f}"` : undefined; }, done: ["", ""] },
  { id: "battery", desc: "battery percentage and charging state", immediate: true, build: () => "pmset -g batt", done: ["", ""] },
  { id: "serial_number", desc: "this Mac's model and serial number", immediate: true, build: () => `system_profiler SPHardwareDataType | grep -E "Model Name|Serial Number"`, done: ["", ""] },
  { id: "open_apps", desc: "list the apps that are open", immediate: true, build: () => osa('tell application "System Events" to get name of every application process whose background only is false'), done: ["", ""] },
  { id: "wifi_name", desc: "the name of the Wi-Fi network this Mac is on", immediate: true, build: () => `ipconfig getsummary "$(networksetup -listallhardwareports | awk '/Wi-Fi|AirPort/{getline; print $2; exit}')" | awk -F' : ' '/ SSID :/{print $2; exit}'`, done: ["", ""] },
  { id: "note_new", desc: "create a note in Notes (title, body)", immediate: false,
    build: (s) => clean(s.title, 120) ? osa(`tell application "Notes" to make new note with properties {name:${asStr(clean(s.title, 120))}, body:${asStr(clean(s.body ?? s.title, 2000))}}`) : undefined, done: ["메모를 만들었어요.", "Created the note."] },
  { id: "reminder_new", desc: "create a reminder in Reminders, optionally at a time (text, when)", immediate: false,
    build: (s, now) => { const t = clean(s.text, 200); if (!t) return undefined; const d = parseWhen(s.when, now); return osa(`tell application "Reminders" to make new reminder with properties {name:${asStr(t)}${d ? `, remind me date:${asDate(d)}` : ""}}`); },
    done: ["미리 알림을 만들었어요.", "Created the reminder."] },
  { id: "new_folder", desc: "create a folder inside home (folder, as a path under home like Desktop/Reports)", immediate: false,
    build: (s) => { const f = clean(s.folder, 200).replace(/^~\/?/, "").replace(/^\/Users\/[^/]+\/?/, ""); return f && !/(^|\/)\.|\.\.|['"`$\\]/.test(f) ? `mkdir -p "$HOME/${f}"` : undefined; }, done: ["폴더를 만들었어요.", "Created the folder."] },
  { id: "eject_disks", desc: "eject all external disks", immediate: false, build: () => osa('tell application "Finder" to eject (every disk whose ejectable is true)'), done: ["외장 디스크를 꺼냈어요.", "Ejected the external disks."] },
  { id: "display_sleep", desc: "put the display to sleep now", immediate: false, build: () => "pmset displaysleepnow", done: ["화면을 껐어요.", "The display is asleep."] },
];


/** The slots each recipe needs (filled in a second, recipe-specific AFM call). */
const SLOT_SPEC: Record<string, Record<string, string>> = {
  say: { text: "the exact text to speak" },
  copy_text: { text: "the exact text to copy" },
  open_url: { url: "the web address as written", app: "the browser app if one is named, else empty" },
  keep_awake: { number: "how long, in minutes (1 hour = 60)" },
  timer: { number: "the timer length in minutes (1 hour = 60)", text: "a short label, or Timer" },
  notify: { text: "the notification text" },
  email_draft: { email: "the recipient's email address as written, or empty", subject: "subject if given, else empty", body: "body if given, else empty" },
  find_files: { kind: "pdf, image, document, presentation, spreadsheet or any", number: "how many days back (this week = 7, today = 1, this month = 30)" },
  note_new: { title: "the note's title", body: "the note's text, or empty" },
  reminder_new: { text: "what to be reminded of", when: "the time as written (e.g. 5pm, 17:30, in 20 minutes), or empty" },
  new_folder: { folder: "the folder path under the home folder, e.g. Desktop/Reports" },
  count_files: { folder: "the folder under the home folder, e.g. Downloads" },
  folder_size: { folder: "the folder under the home folder, e.g. Downloads" },
};
/** AFM picks a recipe (one enum), then fills that recipe's slots (a schema with only those fields, all required);
 *  code checks the values and builds the command. One call for both dropped slots (timer length, email). */
export async function pickRecipe(afm: AFMProvider, prompt: string, timeoutMs: number, now = new Date()): Promise<{ recipe: Recipe; slots: Slots; command: string } | undefined> {
  const r = await afm.generate({
    system: `Pick the one recipe that does exactly what the user asks, or "none" if no recipe does it (a question about a count, size or setting is "none" unless a recipe answers exactly that).\nRecipes:\n${RECIPES.map((x) => `- ${x.id}: ${x.desc}`).join("\n")}`,
    user: prompt, maxTokens: 40, timeoutMs,
    schema: { type: "object", properties: { recipe: { type: "string", enum: [...RECIPES.map((x) => x.id), "none"] } }, required: ["recipe"], additionalProperties: false } as any,
  });
  const recipe = r.ok ? RECIPES.find((x) => x.id === (r.json as any).recipe) : undefined;
  return recipe ? fillRecipe(afm, recipe, prompt, timeoutMs, now) : undefined;
}

/** Slots for one recipe, checked, and its command. */
export async function fillRecipe(afm: AFMProvider, recipe: Recipe, prompt: string, timeoutMs: number, now = new Date()): Promise<{ recipe: Recipe; slots: Slots; command: string } | undefined> {
  if (!recipe) return undefined;
  // code checks on near picks: "skip" is the next track; size is not a count; copying a value the request does not
  // spell out ("copy my IP") is a command, not copy_text of the words "my IP address"
  const low0 = prompt.toLowerCase();
  if (recipe.id === "music_playpause" && /(skip|next|다음)/.test(low0)) recipe = RECIPES.find((x) => x.id === "music_next")!;
  if (recipe.id === "music_playpause" && /(previous|back|이전)/.test(low0)) recipe = RECIPES.find((x) => x.id === "music_previous")!;
  if (recipe.id === "count_files" && /(how big|size|용량|크기|얼마나 커)/.test(low0)) recipe = RECIPES.find((x) => x.id === "folder_size")!;
  if (recipe.id === "folder_size" && /(how many|count|개수|몇 개)/.test(low0)) recipe = RECIPES.find((x) => x.id === "count_files")!;
  if (recipe.id === "copy_text" && !/["“'‘:]/.test(prompt)) return undefined;
  if (recipe.id === "frontmost_app" && /(apps? (i have )?open|open apps|running apps|all apps|list)/.test(low0)) recipe = RECIPES.find((x) => x.id === "open_apps")!;
  const spec = SLOT_SPEC[recipe.id] ?? {};
  let j: Slots = {};
  if (Object.keys(spec).length) {
    const props: Record<string, any> = {};
    for (const [k, d] of Object.entries(spec)) props[k] = { type: k === "number" ? "number" : "string", description: d };
    const f = await afm.generate({ system: `Fill the fields for "${recipe.id}" (${recipe.desc}) from the user's request. Take values from the request only; never invent an address, link or text.`, user: prompt, maxTokens: 300, timeoutMs,
      schema: { type: "object", properties: props, required: Object.keys(spec), additionalProperties: false } as any });
    if (!f.ok) return undefined;
    j = f.json as Slots;
  }
  // values that must appear in the request (an address or link the user did not write is dropped)
  const low = prompt.toLowerCase();
  if (j.email && !low.includes(j.email.toLowerCase())) j.email = "";
  if (j.url && !low.includes(j.url.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""))) j.url = "";
  // a length in hours written by the user wins over the model's arithmetic ("for an hour", "2 hours")
  const hrs = /(\d+(?:\.\d+)?|an?|one)\s*(hours?|hrs?|시간)/i.exec(prompt), mins = /(\d+)\s*(minutes?|mins?|분)/i.exec(prompt);
  // a clock time ("an alarm for 7:30am", "wake me at 6") is turned into minutes by code, never by the model
  const clock = /\b(?:at|for|until)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b|(오전|오후)\s*\d{1,2}\s*시(\s*\d{1,2}\s*분|\s*반)?/i.exec(prompt);
  const at = clock && (recipe.id === "timer" || recipe.id === "keep_awake") && (/(am|pm|:)/i.test(clock[1] ?? "") || clock[2]) ? parseWhen(clock[1] ?? clock[0], now) : undefined;
  if (at) j.number = Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000));
  else if ((recipe.id === "timer" || recipe.id === "keep_awake") && (hrs || mins)) j.number = (hrs ? (Number(hrs[1]) || 1) * 60 : 0) + (mins ? Number(mins[1]) : 0);
  let command = recipe.build(j, now);
  if (command && recipe.id === "find_files" && /(how many|count|몇 개|개수)/i.test(prompt)) command = command.replace(/\| head -30$/, "| wc -l");
  return command ? { recipe, slots: j, command } : undefined;
}

// --------------------------------------------------------------------------------------------- planned commands
const PLAN_SYSTEM = `Write ONE macOS command (zsh) that does the user's request, using only tools built into macOS: osascript (AppleScript),
open, say, pbcopy, pbpaste, caffeinate (-t takes seconds), shortcuts, mdfind, ls, du, df, find, screencapture, afplay, pmset -g,
networksetup, defaults read, date, sw_vers, system_profiler. AppleScript: osascript -e '...' with one statement per -e.
No sudo. No downloads. Never delete or overwrite files. Do not change system settings that need an admin password.
kind "none" when one safe command cannot do it. explain: one short sentence saying exactly what the command does.
Examples:
- "how big is my Downloads folder" → du -sh "$HOME/Downloads"
- "open the Pictures folder in Finder" → open "$HOME/Pictures"
- "what is the frontmost app" → osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'
- "how long has my Mac been on" → uptime`;

export function compileCheck(command: string): string | undefined {
  try { execFileSync("/bin/bash", ["-n", "-c", command], { stdio: "pipe" }); } catch (e: any) { return `shell syntax: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`; }
  // a nested `sh -c '…'` (the timer): check the inner command, unquoted
  const nested = /\bsh -c '((?:[^']|'\\'')*)'/.exec(command);
  if (nested) return compileCheck(nested[1].replace(/'\\''/g, "'"));
  if (/\bosascript\b/.test(command)) {
    const parts = [...command.matchAll(/-e\s+'((?:[^']|'\\'')*)'/g)].map((m) => m[1].replace(/'\\''/g, "'"));
    if (!parts.length) return undefined;
    try { execFileSync("/usr/bin/osacompile", ["-o", "/dev/null", ...parts.flatMap((x) => ["-e", x])], { stdio: "pipe" }); }
    catch (e: any) { return `AppleScript: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`; }
  }
  return undefined;
}

export async function planCommand(afm: AFMProvider, prompt: string, timeoutMs: number): Promise<{ command: string; explain: string; tries: number; error?: string } | undefined> {
  const schema = { type: "object", properties: { kind: { type: "string", enum: ["command", "none"] }, command: { type: "string" }, explain: { type: "string" } }, required: ["kind", "command", "explain"], additionalProperties: false } as any;
  let feedback = "";
  for (let i = 0; i < 2; i++) {
    const r = await afm.generate({ system: PLAN_SYSTEM, user: feedback ? `${prompt}\n\nYour previous command failed to compile (${feedback}). Fix it or answer none.` : prompt, schema, maxTokens: 300, timeoutMs });
    const j = r.ok ? (r.json as { kind: string; command: string; explain: string }) : undefined;
    if (!j || j.kind === "none" || !j.command.trim()) return undefined;
    const cmd = j.command.trim().replace(/^```\w*\n?|```$/g, "").trim();
    const err = compileCheck(cmd);
    if (!err) return { command: cmd, explain: j.explain, tries: i + 1 };
    feedback = err;
  }
  return { command: "", explain: "", tries: 2, error: feedback };
}

export interface LocalActionResult { answer: string; verified: boolean; detail: string; pendingCommand?: string }

/** Recipes first, then a planned command. undefined: neither applies (the caller answers as usual). */
export async function localAction(afm: AFMProvider, prompt: string, ko: boolean, timeoutMs: number, run = (c: string) => execCommand(c, homedir(), { timeoutMs: 20_000 }),
  opts: { recipe?: string; plannedOnly?: boolean } = {}): Promise<LocalActionResult | undefined> {
  const K = (k: string, e: string) => (ko ? k : e);
  const dry = process.env.ONBUD_DRY_ACTIONS === "1";
  const rec = opts.plannedOnly ? undefined : opts.recipe ? await fillRecipe(afm, RECIPES.find((x) => x.id === opts.recipe)!, prompt, timeoutMs) : await pickRecipe(afm, prompt, timeoutMs);
  if (rec) {
    const cls = classifyCommand(rec.command, homedir());
    if (cls.mode === "blocked") return { verified: false, detail: `recipe ${rec.recipe.id} blocked`, answer: K(`보안 게이트가 이 동작을 막았어요 (${cls.reasons.join(", ")}).`, `The security gate blocked this (${cls.reasons.join(", ")}).`) };
    if (!rec.recipe.immediate) return { verified: true, detail: `recipe ${rec.recipe.id} (approval)`, pendingCommand: rec.command,
      answer: K(`이렇게 할게요 (검증된 동작 \`${rec.recipe.id}\`):\n\n\`\`\`sh\n${rec.command}\n\`\`\`\n\n실행할까요? (\`예\` / \`아니요\`)`, `I'll do this (vetted action \`${rec.recipe.id}\`):\n\n\`\`\`sh\n${rec.command}\n\`\`\`\n\nRun it? (\`yes\` / \`no\`)`) };
    if (dry) return { verified: true, detail: `recipe ${rec.recipe.id} (dry)`, answer: `[dry] ${rec.command}` };
    const r = await run(rec.command);
    const out = r.output.trim();
    const ok = r.exitCode === 0;
    let msg = rec.recipe.done[ko ? 0 : 1];
    if (rec.recipe.id === "wifi_name" && /(redacted|not associated)/i.test(out))
      return { verified: true, detail: "recipe wifi_name hidden", answer: K("macOS가 위치 접근 권한이 없는 명령줄 도구에는 Wi-Fi 이름을 숨겨요(`<redacted>`). 메뉴 막대의 Wi-Fi 아이콘이나 **시스템 설정 › Wi-Fi**에서 확인해 주세요.", "macOS hides the Wi-Fi name from command-line tools without Location access (`<redacted>`). Check the Wi-Fi icon in the menu bar or **System Settings › Wi-Fi**.") };
    return { verified: ok, detail: `recipe ${rec.recipe.id} ${ok ? "ok" : `exit ${r.exitCode}`}`,
      answer: ok ? (msg && !out ? msg : out ? "```\n" + out.slice(0, 2500) + "\n```" + (msg ? `\n\n${msg}` : "") : msg) : K(`실행하지 못했어요 (종료 코드 ${r.exitCode}).`, `It did not work (exit ${r.exitCode}).`) + (out ? "\n\n```\n" + out.slice(0, 800) + "\n```" : "") };
  }
  const plan = await planCommand(afm, prompt, timeoutMs);
  if (!plan) return undefined;
  if (!plan.command) return { verified: false, detail: `planned: no valid command (${plan.error})`, answer: K(`이 작업을 할 명령을 만들어 봤지만 검사를 통과하지 못했어요 (${plan.error}). 직접 하시거나 다르게 말씀해 주세요.`, `I tried to write a command for this, but it failed the check (${plan.error}). Please do it yourself or rephrase.`) };
  const cls = classifyCommand(plan.command, homedir());
  if (cls.mode === "blocked") return { verified: false, detail: `planned blocked: ${cls.reasons.join(",")}`, answer: K(`만든 명령을 보안 게이트가 막았어요 (${cls.reasons.join(", ")}).\n\n\`\`\`sh\n${plan.command}\n\`\`\``, `The security gate blocked the command (${cls.reasons.join(", ")}).\n\n\`\`\`sh\n${plan.command}\n\`\`\``) };
  if (cls.mode === "auto") {
    if (dry) return { verified: true, detail: "planned auto (dry)", answer: `[dry] ${plan.command}` };
    const r = await run(plan.command);
    return { verified: r.exitCode === 0, detail: `planned auto exit ${r.exitCode}`, answer: "```sh\n" + plan.command + "\n```\n```\n" + (r.output.trim().slice(0, 2500) || "(no output)") + "\n```\n\n_" + K("AFM이 만든 읽기 전용 명령이라 바로 실행했어요.", "A read-only command written by the on-device model, run at once.") + "_" };
  }
  return { verified: false, detail: `planned approval (${plan.tries} tries)`, pendingCommand: plan.command,
    answer: K(`이 명령으로 할 수 있을 것 같아요: ${plan.explain}\n\n\`\`\`sh\n${plan.command}\n\`\`\`\n\n⚠ 로컬 AFM이 만든 명령이에요. 문법 검사와 보안 게이트는 통과했지만 동작은 검증되지 않았어요. 실행할까요? (\`예\` / \`아니요\`)`,
      `This command should do it: ${plan.explain}\n\n\`\`\`sh\n${plan.command}\n\`\`\`\n\n⚠ Written by the on-device model: it passed the syntax check and the security gate, but what it does is not verified. Run it? (\`yes\` / \`no\`)`) };
}
