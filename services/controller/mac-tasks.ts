// Common Mac tasks (skills plan P6, 2026-11-06). Code nodes first; AFM is not needed for any of them.
//   convert       images (sips: format, size), PDFs (merge, images → PDF: tools/pdftool), documents (textutil),
//                 zip (ditto). Inputs: files the user named, through the security gate. Output: a NEW file next
//                 to the first input ("name (converted).png"); nothing is overwritten or deleted. Size cap
//                 (skills.json options.convert.maxMB, default 500). The result is checked (exists, format, pages).
//   shortcuts     list the user's shortcuts; run one by its exact name (approval: the command flow asks); install
//                 one from the vetted catalogue (skills/shortcuts/catalog: signed, then Apple's import dialog). AFM
//                 never writes shortcut actions.
//   mac_control   dark/light mode, volume, mute, screenshot to a new file (approval: the command flow asks);
//                 clipboard text when asked (shown once, secrets masked, never stored)
//   browser_tab   the front Safari/Chrome tab's title and URL, when asked (macOS asks once for Automation access)
//   personal      Calendar events and Reminders, read-only (tools/pim, EventKit; macOS asks once). Off until the
//                 user turns it on (skills.json). Shown to the user only: no memory, no hand-off, counts in logs.
// None of these run for a delegated (read-only) task: the controller refuses them before they start.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { gatePath, redact } from "../security/gate.ts";
import { option } from "../skills/settings.ts";

export interface TaskCtx { root: string; prompt: string; files: { path: string }[]; ko: boolean }
export interface TaskResult { answer: string; verified: boolean; detail: string; pendingCommand?: string; declined?: boolean }

const HOME = process.env.ONBUD_HOME ?? join(homedir(), "OnBud");
const run = (cmd: string, args: string[], timeout = 60_000) => new Promise<{ code: number; out: string; err: string }>((res) =>
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin", HOME: homedir(), LANG: "en_US.UTF-8" } },
    (e: any, out, err) => res({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(out ?? ""), err: String(err ?? "") })));
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const T = (ko: boolean, k: string, e: string) => (ko ? k : e);

// ---------------------------------------------------------------- Swift helpers, built on first use
async function helper(name: "pdftool" | "pim"): Promise<string | undefined> {
  const src = new URL(`../../tools/${name}/${name === "pdftool" ? "PDFTool" : "PIM"}.swift`, import.meta.url).pathname;
  const bin = join(HOME, "runtime", "bin", `afm-${name}`);
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return bin;
  mkdirSync(dirname(bin), { recursive: true });
  const extra = name === "pim" ? ["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", join(dirname(src), "Info.plist")] : [];
  const r = await run("/usr/bin/swiftc", ["-O", "-parse-as-library", ...extra, "-o", bin, src], 240_000);
  return r.code === 0 && existsSync(bin) ? bin : undefined;
}

// ---------------------------------------------------------------- convert
const IMG = /\.(png|jpe?g|heic|heif|tiff?|gif|bmp|webp)$/i;
const DOC = /\.(txt|rtf|rtfd|html?|docx?|odt|webarchive)$/i;
const SIPS_FMT: Record<string, string> = { png: "png", jpg: "jpeg", jpeg: "jpeg", heic: "heic", tiff: "tiff", tif: "tiff", gif: "gif", bmp: "bmp" };
const TEXTUTIL_FMT = ["txt", "html", "rtf", "rtfd", "doc", "docx", "odt", "wordml", "webarchive"];

/** A path next to `like` that does not exist yet: "name (converted).ext", "name (converted 2).ext", … */
export function freshPath(dir: string, stem: string, tag: string, ext: string): string {
  for (let i = 1; ; i++) {
    const p = join(dir, `${stem} (${tag}${i > 1 ? ` ${i}` : ""}).${ext}`);
    if (!existsSync(p)) return p;
  }
}

/** What the request asks for, from its words (en/ko): a target format, a size, merging, zipping. */
export function convertPlan(prompt: string, inputs: string[]): { op: "merge_pdf" | "images_pdf" | "image" | "shrink" | "doc" | "zip"; fmt?: string; px?: number; pct?: number } | undefined {
  // format names people use: "a Word file" → docx, "plain text" → txt, "web page" → html
  const p = prompt.toLowerCase().replace(/\b(ms\s)?word\b|워드/g, " docx ").replace(/plain text|text file|텍스트/g, " txt ").replace(/web ?page|웹\s?페이지/g, " html ");
  const fmt = /\b(png|jpe?g|heic|tiff?|gif|bmp|pdf|txt|html|rtf|docx?|odt)\b/.exec(p.replace(/\.[a-z0-9]+\b/g, " "))?.[1];
  const px = Number(/(\d{2,5})\s?(px|픽셀|pixels?)/.exec(p)?.[1] ?? 0) || undefined;
  const pct = Number(/(\d{1,3})\s?%/.exec(p)?.[1] ?? 0) || undefined;
  if (/(zip|압축)/.test(p)) return { op: "zip" };
  const pdfs = inputs.filter((f) => /\.pdf$/i.test(f)), imgs = inputs.filter((f) => IMG.test(f));
  if (pdfs.length >= 2 && /(merge|combine|join|합쳐|합치|병합|하나로)/.test(p)) return { op: "merge_pdf" };
  if (imgs.length && fmt === "pdf") return { op: "images_pdf" };
  if (imgs.length && (fmt && SIPS_FMT[fmt] || px || pct)) return { op: "image", fmt: fmt && SIPS_FMT[fmt] ? fmt : undefined, px, pct };
  // "make it smaller" with no format or size named: the file size, chosen per image in convert()
  if (imgs.length && /(용량|파일\s?크기|가볍게|작게|줄여|줄이|compress|smaller|reduce\b.{0,20}\bsize|shrink|optimi[sz]e)/.test(p)) return { op: "shrink" };
  if (inputs.some((f) => DOC.test(f)) && fmt && TEXTUTIL_FMT.includes(fmt === "doc" ? "doc" : fmt)) return { op: "doc", fmt };
  return undefined;
}

export async function convert(c: TaskCtx): Promise<TaskResult> {
  const abs = c.files.map((f) => resolve(c.root || homedir(), f.path)).filter((p) => existsSync(p));
  if (!abs.length) return { answer: T(c.ko, "어떤 파일을 변환할까요? 파일 이름을 알려 주세요.", "Which file should I convert? Name the file."), verified: false, detail: "no_input" };
  for (const p of abs) {
    const g = gatePath(p, dirname(p), "read");
    if (g.verdict === "deny") return { answer: T(c.ko, `\`${basename(p)}\`는 보안 정책상 다룰 수 없어요.`, `\`${basename(p)}\` is blocked by the security gate.`), verified: false, detail: "gate_denied" };
  }
  const maxMB = option("convert", "maxMB", 500);
  const total = abs.reduce((n, p) => n + statSync(p).size, 0) / 1024 / 1024;
  if (total > maxMB) return { answer: T(c.ko, `파일이 너무 커요 (${total.toFixed(0)} MB, 한도 ${maxMB} MB).`, `Too large (${total.toFixed(0)} MB, limit ${maxMB} MB).`), verified: false, detail: "too_large" };
  const plan = convertPlan(c.prompt, abs);
  if (!plan) return { answer: "", verified: false, detail: "no_plan", declined: true };
  const dir = dirname(abs[0]), stem = basename(abs[0], extname(abs[0]));
  const outs: string[] = [];
  let check = "";
  if (plan.op === "merge_pdf" || plan.op === "images_pdf") {
    const bin = await helper("pdftool");
    if (!bin) return { answer: T(c.ko, "PDF 도구를 만들지 못했어요 (Xcode Command Line Tools 필요: `xcode-select --install`).", "Could not build the PDF tool (needs the Command Line Tools: `xcode-select --install`)."), verified: false, detail: "no_pdftool" };
    const out = freshPath(dir, stem, plan.op === "merge_pdf" ? "merged" : "converted", "pdf");
    const r = await run(bin, [plan.op === "merge_pdf" ? "merge" : "images", out, ...abs]);
    if (r.code !== 0) return { answer: T(c.ko, `변환 실패: ${r.err.trim()}`, `Conversion failed: ${r.err.trim()}`), verified: false, detail: "failed" };
    const want = plan.op === "merge_pdf" ? (await Promise.all(abs.map(async (p) => Number((await run(bin, ["pages", p])).out.trim()) || 0))).reduce((a, b) => a + b, 0) : abs.length;
    const got = Number((await run(bin, ["pages", out])).out.trim());
    check = `${got}/${want} pages`;
    if (got !== want) return { answer: T(c.ko, `만든 PDF의 쪽수가 맞지 않아요 (${check}).`, `The new PDF has the wrong page count (${check}).`), verified: false, detail: "check_failed" };
    outs.push(out);
  } else if (plan.op === "image") {
    for (const p of abs.filter((f) => IMG.test(f))) {
      const ext = plan.fmt ? (plan.fmt === "jpeg" ? "jpg" : plan.fmt) : extname(p).slice(1);
      const out = freshPath(dirname(p), basename(p, extname(p)), "converted", ext);
      const args = [...(plan.fmt ? ["-s", "format", SIPS_FMT[plan.fmt]] : [])];
      // "800 px wide" sets the width, "600 px tall" the height, a bare "800 px" the longer side
      if (plan.px) args.push(...(/(wide|width|너비|가로)/i.test(c.prompt) ? ["--resampleWidth"] : /(tall|height|높이|세로)/i.test(c.prompt) ? ["--resampleHeight"] : ["-Z"]), String(plan.px));
      if (plan.pct) { const w = Number(/pixelWidth: (\d+)/.exec((await run("/usr/bin/sips", ["-g", "pixelWidth", p])).out)?.[1] ?? 0); if (w) args.push("--resampleWidth", String(Math.max(1, Math.round(w * plan.pct / 100)))); }
      const r = await run("/usr/bin/sips", [...args, p, "--out", out]);
      if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, `변환 실패: ${basename(p)}`, `Conversion failed: ${basename(p)}`), verified: false, detail: "failed" };
      outs.push(out);
    }
    const g = (await run("/usr/bin/sips", ["-g", "format", "-g", "pixelWidth", outs[0]])).out;
    check = `${/format: (\w+)/.exec(g)?.[1] ?? "?"}, ${/pixelWidth: (\d+)/.exec(g)?.[1] ?? "?"} px`;
  } else if (plan.op === "shrink") {
    // JPEG/HEIC: re-encoded at quality 70. Opaque PNG and other formats: JPEG at quality 80. Transparent images:
    // kept as PNG (JPEG would lose the transparency), 75% of the size. A result that is not smaller is not kept.
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;
    const notes: string[] = [];
    for (const p of abs.filter((f) => IMG.test(f))) {
      const info = (await run("/usr/bin/sips", ["-g", "format", "-g", "hasAlpha", "-g", "pixelWidth", "-g", "pixelHeight", p])).out;
      const format = /format: (\w+)/.exec(info)?.[1] ?? "", alpha = /hasAlpha: yes/.test(info);
      const side = Math.max(Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 0), Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 0));
      let ext: string, args: string[], how: string;
      if (format === "jpeg" || format === "heic") { ext = extname(p).slice(1); args = ["-s", "formatOptions", "70"]; how = T(c.ko, "품질 70으로 다시 저장", "re-saved at quality 70"); }
      else if (!alpha) { ext = "jpg"; args = ["-s", "format", "jpeg", "-s", "formatOptions", "80"]; how = T(c.ko, "JPEG(품질 80)로 저장", "saved as JPEG, quality 80"); }
      else { ext = "png"; args = side > 64 ? ["-Z", String(Math.round(side * 0.75))] : []; how = T(c.ko, "투명 배경이라 PNG 그대로, 크기 75%", "PNG kept for transparency, 75% size"); }
      const out = freshPath(dirname(p), basename(p, extname(p)), "compressed", ext);
      const r = await run("/usr/bin/sips", [...args, p, "--out", out]);
      if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, `변환 실패: ${basename(p)}`, `Conversion failed: ${basename(p)}`), verified: false, detail: "failed" };
      const before = statSync(p).size, after = statSync(out).size;
      if (after >= before) { unlinkSync(out); notes.push(T(c.ko, `\`${basename(p)}\`: 더 작게 만들지 못했어요 (${mb(before)}).`, `\`${basename(p)}\`: could not make it smaller (${mb(before)}).`)); continue; }
      outs.push(out); notes.push(`\`${basename(out)}\`: ${mb(before)} → ${mb(after)} (${how})`);
    }
    if (!outs.length) return { answer: notes.join("\n"), verified: false, detail: "not_smaller" };
    check = notes.join("; ");
  } else if (plan.op === "doc") {
    for (const p of abs.filter((f) => DOC.test(f))) {
      const out = freshPath(dirname(p), basename(p, extname(p)), "converted", plan.fmt!);
      const r = await run("/usr/bin/textutil", ["-convert", plan.fmt!, "-output", out, p]);
      if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, `변환 실패: ${basename(p)}`, `Conversion failed: ${basename(p)}`), verified: false, detail: "failed" };
      outs.push(out);
    }
    check = `${outs.length} document(s)`;
  } else {
    const out = freshPath(dir, stem, "archive", "zip");
    const r = await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", abs[0], out]);
    if (r.code !== 0 || !existsSync(out)) return { answer: T(c.ko, "압축 실패", "Zip failed"), verified: false, detail: "failed" };
    outs.push(out); check = "zip";
  }
  const home = homedir();
  const short = (p: string) => (p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p);
  return { answer: T(c.ko, "새 파일을 만들었어요 (원본은 그대로예요):", "Created (the originals are unchanged):") + "\n\n" + outs.map((o) => `- \`${short(o)}\``).join("\n") + `\n\n_${T(c.ko, "확인", "Check")}: ${check}_`,
    verified: true, detail: `${plan.op}: ${outs.length} file(s), ${check}` };
}

// ---------------------------------------------------------------- shortcuts
export interface CatalogEntry { id: string; name: string; description: string; file: string; lane: "contained" | "wide" | "irreversible" }
export function catalog(dir = new URL("../../skills/shortcuts/catalog/", import.meta.url).pathname): CatalogEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => ({ ...JSON.parse(readFileSync(join(dir, n), "utf8")), file: join(dir, JSON.parse(readFileSync(join(dir, n), "utf8")).file) }));
}

export async function shortcutsSkill(c: TaskCtx): Promise<TaskResult> {
  const list = (await run("/usr/bin/shortcuts", ["list"], 20_000)).out.split("\n").map((s) => s.trim()).filter(Boolean);
  const p = c.prompt;
  if (/(만들어|생성|작성|\b(create|make|write|build)\b)/i.test(p) && !/(설치|install)/i.test(p))
    return { answer: T(c.ko, "새 단축어는 단축어 앱에서 만들어 주세요. OnBud은 단축어 동작을 직접 작성하지 않아요 (형식이 공개돼 있지 않고, 단축어는 보내기·삭제까지 할 수 있어서요). 검증된 단축어 목록에 있는 것은 설치를 도와드릴 수 있어요.",
      "Please create new shortcuts in the Shortcuts app: OnBud does not write shortcut actions (the format is undocumented, and a shortcut can send or delete). It can install shortcuts from its vetted catalogue."), verified: true, detail: "create_refused" };
  if (/(설치|install)/i.test(p)) {
    const cat = catalog();
    const hit = cat.find((e) => p.toLowerCase().includes(e.name.toLowerCase()) || p.toLowerCase().includes(e.id));
    if (!hit) return { answer: T(c.ko, cat.length ? `검증된 단축어: ${cat.map((e) => e.name).join(", ")}` : "아직 검증된 단축어 템플릿이 없어요.", cat.length ? `Vetted shortcuts: ${cat.map((e) => e.name).join(", ")}` : "No vetted shortcut templates yet."), verified: true, detail: "catalog" };
    if (hit.lane === "irreversible") return { answer: T(c.ko, "이 단축어는 보내기·삭제를 할 수 있어 자동 설치하지 않아요.", "This shortcut can send or delete, so it is not installed automatically."), verified: true, detail: "closed_lane" };
    const out = join(HOME, "runtime", "tmp", `${hit.id}.shortcut`);
    return { answer: T(c.ko, `**${hit.name}** — ${hit.description}\n서명한 뒤 단축어 앱의 가져오기 창을 열어요. 거기서 추가를 눌러 주세요.`, `**${hit.name}** — ${hit.description}\nIt is signed, then the Shortcuts import dialog opens; confirm there.`),
      verified: true, detail: "install", pendingCommand: `mkdir -p ${q(dirname(out))} && shortcuts sign -m people-who-know-me -i ${q(hit.file)} -o ${q(out)} && open ${q(out)}` };
  }
  const named = /["“'‘]([^"”'’]{2,80})["”'’]/.exec(p)?.[1] ?? list.filter((n) => p.toLowerCase().includes(n.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  if (/(실행|돌려|\b(run|start)\b)/i.test(p)) {
    const exact = named && list.find((n) => n.toLowerCase() === named.toLowerCase());
    if (!exact) return { answer: T(c.ko, `"${named ?? ""}" 단축어를 찾지 못했어요. 있는 단축어: ${list.slice(0, 15).join(", ")}`, `No shortcut named "${named ?? ""}". You have: ${list.slice(0, 15).join(", ")}`), verified: true, detail: "not_found" };
    return { answer: T(c.ko, `단축어 **${exact}**를 실행할까요?`, `Run the shortcut **${exact}**?`), verified: true, detail: "run", pendingCommand: `shortcuts run ${q(exact)}` };
  }
  return { answer: (list.length ? T(c.ko, `단축어 ${list.length}개:`, `${list.length} shortcuts:`) + "\n\n" + list.slice(0, 60).map((n) => `- ${n}`).join("\n") : T(c.ko, "단축어가 없어요.", "You have no shortcuts.")), verified: true, detail: `list ${list.length}` };
}

// ---------------------------------------------------------------- mac_control
export async function macControl(c: TaskCtx): Promise<TaskResult> {
  const p = c.prompt.toLowerCase();
  const ask = (cmd: string, k: string, e: string, detail: string): TaskResult => ({ answer: T(c.ko, k, e), verified: true, detail, pendingCommand: cmd });
  if (/(다크\s?모드|dark mode)/.test(p) && !/(끄|해제|off|disable)/.test(p)) return ask(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'`, "다크 모드로 바꿀까요?", "Switch to Dark Mode?", "dark_on");
  if (/(라이트\s?모드|light mode)/.test(p) || /(다크\s?모드|dark mode).*(끄|해제|off|disable)/.test(p)) return ask(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to false'`, "라이트 모드로 바꿀까요?", "Switch to Light Mode?", "dark_off");
  if (/(음소거 해제|unmute)/.test(p)) return ask(`osascript -e 'set volume without output muted'`, "음소거를 해제할까요?", "Unmute?", "unmute");
  if (/(음소거|mute)/.test(p)) return ask(`osascript -e 'set volume with output muted'`, "음소거할까요?", "Mute?", "mute");
  const vol = /(볼륨|음량|volume)\D{0,12}(\d{1,3})/.exec(p);
  if (vol) { const n = Math.min(100, Number(vol[2])); return ask(`osascript -e 'set volume output volume ${n}'`, `음량을 ${n}%로 바꿀까요?`, `Set the volume to ${n}%?`, `volume ${n}`); }
  if (/(스크린\s?샷|화면\s?캡처|screenshot|screen ?capture)/.test(p)) {
    const out = freshPath(join(homedir(), "Desktop"), `Screenshot ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`, "OnBud", "png");
    return ask(`screencapture -x ${q(out)}`, `화면을 \`${basename(out)}\`로 저장할까요? (데스크탑)`, `Save the screen as \`${basename(out)}\` on the Desktop?`, "screenshot");
  }
  if (/(클립보드|clipboard)/.test(p)) {
    const r = await run("/usr/bin/pbpaste", []);
    const text = redact(r.out).text.slice(0, 2000);
    return { answer: text.trim() ? T(c.ko, "클립보드 내용 (저장하지 않아요):", "Clipboard (not stored):") + "\n\n```\n" + text + "\n```" : T(c.ko, "클립보드에 텍스트가 없어요.", "The clipboard has no text."), verified: true, detail: `clipboard ${text.length} chars` };
  }
  return { answer: "", verified: false, detail: "no_action", declined: true };
}

// ---------------------------------------------------------------- browser_tab
export async function browserTab(c: TaskCtx): Promise<TaskResult> {
  const apps = /chrome|크롬/i.test(c.prompt) ? ["Google Chrome"] : /safari|사파리/i.test(c.prompt) ? ["Safari"] : ["Safari", "Google Chrome"];
  for (const app of apps) {
    const script = app === "Safari"
      ? `if application "Safari" is running then tell application "Safari" to return (URL of front document) & linefeed & (name of front document)`
      : `if application "Google Chrome" is running then tell application "Google Chrome" to return (URL of active tab of front window) & linefeed & (title of active tab of front window)`;
    const r = await run("/usr/bin/osascript", ["-e", script], 10_000);
    const [url, title] = r.out.trim().split("\n");
    if (r.code === 0 && url) return { answer: `**${title ?? ""}**\n${url}\n\n_${T(c.ko, `${app}의 현재 탭. 페이지 내용이 필요하면 웹 검색 승인 후 읽어요.`, `${app}'s current tab. To read the page, approve a web step.`)}_`, verified: true, detail: app };
    if (/not allowed|-1743/.test(r.err)) return { answer: T(c.ko, `${app} 제어 권한이 없어요. 시스템 설정 > 개인정보 보호 및 보안 > 자동화에서 허용해 주세요.`, `No permission to read ${app}. Allow it in System Settings > Privacy & Security > Automation.`), verified: false, detail: "no_permission" };
  }
  return { answer: T(c.ko, "열려 있는 Safari나 Chrome 창이 없어요.", "No Safari or Chrome window is open."), verified: true, detail: "none_open" };
}

// ---------------------------------------------------------------- personal
export interface PimSource { events(days: number): Promise<any[] | { error: string }>; reminders(): Promise<any[] | { error: string }> }
export const pimSource: PimSource = {
  async events(days) { const b = await helper("pim"); if (!b) return { error: "no helper" }; const r = await run(b, ["events", String(days)], 30_000); try { return JSON.parse(r.out); } catch { return { error: r.err.trim() || "failed" }; } },
  async reminders() { const b = await helper("pim"); if (!b) return { error: "no helper" }; const r = await run(b, ["reminders"], 30_000); try { return JSON.parse(r.out); } catch { return { error: r.err.trim() || "failed" }; } },
};

export async function personal(c: TaskCtx, src: PimSource = pimSource): Promise<TaskResult> {
  const p = c.prompt.toLowerCase();
  const rem = /(미리\s?알림|리마인더|reminders?|할 일|to-?dos?)/.test(p);
  const days = /(이번\s?주|this week|일주일|week)/.test(p) ? 7 : /(내일|tomorrow)/.test(p) ? 2 : 1;
  const res = rem ? await src.reminders() : await src.events(days);
  if (!Array.isArray(res)) {
    const denied = /denied/.test(res.error);
    return { answer: denied ? T(c.ko, "캘린더/미리 알림 접근이 허용되지 않았어요. 시스템 설정 > 개인정보 보호 및 보안에서 허용해 주세요.", "Access to Calendar/Reminders was not allowed. Allow it in System Settings > Privacy & Security.") : T(c.ko, `읽지 못했어요: ${res.error}`, `Could not read them: ${res.error}`), verified: false, detail: denied ? "denied" : "failed" };
  }
  const fmt = (iso: string) => (iso ? new Date(iso).toLocaleString(c.ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const rows = rem ? res.map((r: any) => `- ${r.title}${r.due ? ` — ${fmt(r.due)}` : ""} _(${r.list})_`) : res.map((e: any) => `- ${e.allDay ? T(c.ko, "종일", "all day") : fmt(e.start)} **${e.title}**${e.location ? ` · ${e.location}` : ""} _(${e.calendar})_`);
  const head = rem ? T(c.ko, `미리 알림 ${res.length}개`, `${res.length} reminders`) : T(c.ko, `${days === 1 ? "오늘" : days === 2 ? "내일까지" : "이번 주"} 일정 ${res.length}개`, `${res.length} events ${days === 1 ? "today" : days === 2 ? "through tomorrow" : "this week"}`);
  // only the count leaves this function in the detail (telemetry): never titles
  return { answer: `${head}${T(c.ko, " (이 Mac에서만 읽고, 저장하지 않아요)", " (read on this Mac, not stored)")}:\n\n${rows.join("\n") || "-"}`, verified: true, detail: `${rem ? "reminders" : "events"} ${res.length}` };
}
