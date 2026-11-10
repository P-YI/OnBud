// Quick answers (2026-11-09): everyday questions the on-device model gets wrong but code gets right.
// Measured before (Spotlight-like, root ~/Desktop): "17% of 2,340" → 341.2, "3시간 45분은 몇 분" → 265, "오늘 무슨
// 요일" → a guessed weekday, "지금 몇 시야" → escalation, unrelated Desktop documents read for each.
//   clock   now, today's date and weekday, N days from today, days until a date (this Mac's clock and time zone)
//   calc    arithmetic (+ − × ÷ ^ %, parentheses), "X% of Y" / "Y의 X%", percent change
//   units   length, mass, temperature, volume, area, speed, data, time ("5 km는 몇 마일", "100°F in C", "3시간 45분은 몇 분")
// All by code; no model call. Anything else → undefined (the usual routing goes on).

import { execFileSync } from "node:child_process";

export type Quick = { kind: "clock" | "calc" | "units" | "shortcut" | "network"; answer: string; detail: string };

// ------------------------------------------------------------------- macOS keyboard shortcuts (Apple's own list)
// The on-device model answered "앱 강제 종료 단축키" with ⌘Z; these are fixed facts, so a table answers them.
const SHORTCUTS: [RegExp, string, string, string][] = [
  [/(강제\s?종료|force\s?quit)/i, "⌥⌘⎋ (Option-Command-Esc)", "앱 강제 종료 창이 열려요. 앞에 있는 앱만이면 ⌥⇧⌘⎋를 길게 누르세요.", "Opens Force Quit Applications; hold ⌥⇧⌘⎋ to force quit the front app."],
  [/(스크린\s?샷|화면\s?(캡처|캡쳐)|screenshot|screen ?capture).{0,20}(창|window)|(창|window).{0,20}(스크린\s?샷|캡처|캡쳐|screenshot)/i, "⇧⌘4 → Space", "창 위에서 클릭하면 그 창만 저장돼요 (그림자 빼려면 ⌥ 누른 채 클릭).", "Click a window to capture just it (hold ⌥ while clicking to drop the shadow)."],
  [/(스크린\s?샷|화면\s?(캡처|캡쳐)|screenshot|screen ?capture).{0,20}(영역|부분|선택|area|portion|selection)/i, "⇧⌘4", "드래그해서 영역을 선택해요.", "Drag to select an area."],
  [/(화면\s?녹화|screen ?record)/i, "⇧⌘5", "캡처·녹화 도구 막대가 열려요.", "Opens the screenshot and recording toolbar."],
  [/(스크린\s?샷|화면\s?(캡처|캡쳐)|screenshot|screen ?capture)/i, "⇧⌘3 (전체) · ⇧⌘4 (영역) · ⇧⌘5 (도구)", "", ""],
  [/(잠금|화면\s?잠|lock (the )?screen)/i, "⌃⌘Q", "화면을 바로 잠가요.", "Locks the screen right away."],
  [/(spotlight|스포트라이트)/i, "⌘Space", "", ""],
  [/(이모지|이모티콘|emoji)/i, "fn/🌐 E 또는 ⌃⌘Space", "", ""],
  [/(앱\s?전환|app switch|switch (between )?apps)/i, "⌘Tab", "", ""],
  [/(같은 앱.{0,6}창\s?전환|창\s?전환|switch windows)/i, "⌘` (백틱)", "", ""],
  [/(숨김\s?파일|hidden files)/i, "⇧⌘. (Finder)", "Finder에서 숨김 파일을 보이거나 숨겨요.", "Shows or hides hidden files in Finder."],
  [/(휴지통\s?비우|empty (the )?trash)/i, "⇧⌘⌫ (Finder)", "", ""],
  [/(바로\s?삭제|영구\s?삭제|delete immediately)/i, "⌥⌘⌫ (Finder)", "휴지통을 거치지 않고 지워요.", "Deletes without the Trash."],
  [/(새\s?폴더|new folder)/i, "⇧⌘N (Finder)", "", ""],
  [/(경로\s?복사|copy (the )?path)/i, "⌥⌘C (Finder)", "", ""],
  [/(이동|잘라|cut).{0,10}(파일|file)|(파일|file).{0,10}(잘라|이동|move)/i, "⌘C → ⌥⌘V (Finder)", "복사한 뒤 ⌥⌘V로 붙이면 이동돼요.", "Copy, then ⌥⌘V moves the file."],
  [/(정보\s?가져오기|get info)/i, "⌘I", "", ""],
  [/(미션\s?컨트롤|mission control)/i, "⌃↑", "", ""],
  [/(데스크탑\s?보기|바탕\s?화면\s?보기|show desktop)/i, "fn F11 또는 ⌘F3", "", ""],
  [/(전체\s?화면|full ?screen)/i, "⌃⌘F 또는 fn F", "", ""],
  [/(창\s?닫|close (the )?window)/i, "⌘W", "", ""],
  [/(앱\s?종료|quit (the )?app)/i, "⌘Q", "", ""],
  [/(최소화|minimi[sz]e)/i, "⌘M", "", ""],
  [/(실행\s?취소|undo)/i, "⌘Z", "다시 실행은 ⇧⌘Z.", "Redo is ⇧⌘Z."],
  [/(서식\s?없이\s?붙여|paste (without|and match) (formatting|style))/i, "⌥⇧⌘V", "", ""],
  [/(받아쓰기|dictation)/i, "fn 두 번 (또는 🎤 키)", "", ""],
  [/(시스템\s?설정|system settings)/i, "⌘, (설정 앱 안에서) · Spotlight에서 \"시스템 설정\"", "", ""],
];
function shortcutAnswer(p: string, ko: boolean): Quick | undefined {
  if (!/(단축키|단축\s?키|키보드\s?(단축|조합)|shortcut|hotkey|key ?(combo|binding))/i.test(p)
    && !/(how (do|can|to) (i )?|어떻게|방법|하는\s?법).{0,40}(스크린\s?샷|화면\s?(캡처|캡쳐|녹화)|screenshot|screen ?(capture|record)|강제\s?종료|force\s?quit|화면\s?잠|lock (the )?screen)|(스크린\s?샷|화면\s?(캡처|캡쳐|녹화)|screenshot|강제\s?종료|force\s?quit|화면\s?잠금).{0,20}(어떻게|방법|하는\s?법)/i.test(p)) return undefined;
  for (const [re, keys, k, e] of SHORTCUTS) if (re.test(p)) {
    const note = ko ? k : e;
    return { kind: "shortcut", detail: keys, answer: `**${keys}**${note ? `\n\n${note}` : ""}` };
  }
  return undefined;
}

// --------------------------------------------------------------------------- this Mac's local network address
function networkAnswer(p: string, ko: boolean): Quick | undefined {
  if (!/(\bip\b|아이피)\s?(주소|address)?/i.test(p) || !/(내|나의|이\s?맥|my|this mac|what('s| is)|알려|뭐야|확인|show)/i.test(p)) return undefined;
  const ip = (dev: string) => { try { return execFileSync("/usr/sbin/ipconfig", ["getifaddr", dev], { timeout: 2000, encoding: "utf8" }).trim(); } catch { return ""; } };
  const local = ip("en0") || ip("en1");
  if (!local) return { kind: "network", detail: "no_ip", answer: ko ? "지금 연결된 네트워크가 없어요 (en0/en1에 IP 없음)." : "No network connection right now (no IP on en0/en1)." };
  return { kind: "network", detail: "local_ip", answer: ko
    ? `이 Mac의 내부 IP: **${local}**\n\n_공유기 안에서 쓰는 주소예요. 인터넷에서 보이는 공인 IP는 웹 조회가 필요해서 여기서는 확인하지 않아요._`
    : `This Mac's local IP: **${local}**\n\n_The address inside your network; the public IP needs a web lookup, which is not done here._` };
}


// ------------------------------------------------------------- safe arithmetic (recursive descent, no eval)
export function evaluate(expr: string): number | undefined {
  const s = expr.replace(/\s+/g, "").replace(/[×xX]/g, "*").replace(/[÷]/g, "/").replace(/[−–]/g, "-").replace(/\*\*/g, "^");
  if (!s || /[^0-9.+\-*/^%()]/.test(s)) return undefined;
  let i = 0;
  const peek = () => s[i];
  const num = (): number | undefined => {
    if (peek() === "(") { i++; const v = add(); if (peek() !== ")") return undefined; i++; return v; }
    if (peek() === "-") { i++; const v = pow(); return v === undefined ? undefined : -v; }
    if (peek() === "+") { i++; return pow(); }
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    let v = Number(m[0]);
    if (peek() === "%") { i++; v /= 100; }
    return v;
  };
  const pow = (): number | undefined => {
    const b = num(); if (b === undefined) return undefined;
    if (peek() === "^") { i++; const e = pow(); return e === undefined ? undefined : b ** e; }
    return b;
  };
  const mul = (): number | undefined => {
    let v = pow(); if (v === undefined) return undefined;
    while (peek() === "*" || peek() === "/") {
      const op = s[i++]; const r = pow(); if (r === undefined) return undefined;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const add = (): number | undefined => {
    let v = mul(); if (v === undefined) return undefined;
    while (peek() === "+" || peek() === "-") {
      const op = s[i++]; const r = mul(); if (r === undefined) return undefined;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = add();
  return v !== undefined && i === s.length && Number.isFinite(v) ? v : undefined;
}

export function fmt(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toLocaleString("en-US");
  const r = Number(n.toPrecision(10));
  return Math.abs(r) >= 1e15 || (Math.abs(r) < 1e-6 && r !== 0) ? r.toExponential(6) : r.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
const N = String.raw`(-?\d[\d,]*(?:\.\d+)?|-?\.\d+)`;
const toNum = (s: string) => Number(s.replace(/,/g, ""));

// ------------------------------------------------------------------- units (to a base unit per dimension)
type Unit = { dim: string; f: number; ko: string; en: string };
const U: [RegExp, Unit][] = [
  [/^(km|킬로미터|킬로|kilometers?|kilometres?)$/i, { dim: "len", f: 1000, ko: "km", en: "km" }],
  [/^(m|미터|meters?|metres?)$/i, { dim: "len", f: 1, ko: "m", en: "m" }],
  [/^(cm|센티미터|센티|centimeters?|centimetres?)$/i, { dim: "len", f: 0.01, ko: "cm", en: "cm" }],
  [/^(mm|밀리미터|millimeters?|millimetres?)$/i, { dim: "len", f: 0.001, ko: "mm", en: "mm" }],
  [/^(mi|마일|miles?)$/i, { dim: "len", f: 1609.344, ko: "마일", en: "mi" }],
  [/^(ft|피트|feet|foot)$/i, { dim: "len", f: 0.3048, ko: "피트", en: "ft" }],
  [/^(in|인치|inch(es)?|")$/i, { dim: "len", f: 0.0254, ko: "인치", en: "in" }],
  [/^(yd|야드|yards?)$/i, { dim: "len", f: 0.9144, ko: "야드", en: "yd" }],
  [/^(kg|킬로그램|kilograms?|kilos?)$/i, { dim: "mass", f: 1, ko: "kg", en: "kg" }],
  [/^(g|그램|grams?)$/i, { dim: "mass", f: 0.001, ko: "g", en: "g" }],
  [/^(lbs?|파운드|pounds?)$/i, { dim: "mass", f: 0.45359237, ko: "파운드", en: "lb" }],
  [/^(oz|온스|ounces?)$/i, { dim: "mass", f: 0.028349523125, ko: "온스", en: "oz" }],
  [/^(근)$/i, { dim: "mass", f: 0.6, ko: "근", en: "geun" }],
  [/^(l|리터|liters?|litres?)$/i, { dim: "vol", f: 1, ko: "L", en: "L" }],
  [/^(ml|밀리리터|milliliters?|millilitres?)$/i, { dim: "vol", f: 0.001, ko: "mL", en: "mL" }],
  [/^(gal|갤런|gallons?)$/i, { dim: "vol", f: 3.785411784, ko: "갤런", en: "gal" }],
  [/^(cups?|컵)$/i, { dim: "vol", f: 0.2365882365, ko: "컵", en: "cup" }],
  [/^(평)$/i, { dim: "area", f: 400 / 121, ko: "평", en: "pyeong" }],
  [/^(㎡|m2|m²|제곱미터|square meters?)$/i, { dim: "area", f: 1, ko: "㎡", en: "m²" }],
  [/^(acres?|에이커)$/i, { dim: "area", f: 4046.8564224, ko: "에이커", en: "acre" }],
  [/^(km\/h|kph|시속\s?km)$/i, { dim: "speed", f: 1 / 3.6, ko: "km/h", en: "km/h" }],
  [/^(mph)$/i, { dim: "speed", f: 0.44704, ko: "mph", en: "mph" }],
  [/^(m\/s)$/i, { dim: "speed", f: 1, ko: "m/s", en: "m/s" }],
  [/^(tb|테라바이트|terabytes?)$/i, { dim: "data", f: 1e12, ko: "TB", en: "TB" }],
  [/^(gb|기가바이트|기가|gigabytes?)$/i, { dim: "data", f: 1e9, ko: "GB", en: "GB" }],
  [/^(mb|메가바이트|메가|megabytes?)$/i, { dim: "data", f: 1e6, ko: "MB", en: "MB" }],
  [/^(kb|킬로바이트|kilobytes?)$/i, { dim: "data", f: 1e3, ko: "KB", en: "KB" }],
  [/^(일|days?)$/i, { dim: "time", f: 86400, ko: "일", en: "days" }],
  [/^(시간|hours?|hrs?|h)$/i, { dim: "time", f: 3600, ko: "시간", en: "hours" }],
  [/^(분|minutes?|mins?)$/i, { dim: "time", f: 60, ko: "분", en: "minutes" }],
  [/^(초|seconds?|secs?|s)$/i, { dim: "time", f: 1, ko: "초", en: "seconds" }],
  [/^(주|weeks?)$/i, { dim: "time", f: 604800, ko: "주", en: "weeks" }],
];
const unit = (w: string): Unit | undefined => U.find(([re]) => re.test(w.trim()))?.[1];
const TEMP: Record<string, "C" | "F" | "K"> = { c: "C", "°c": "C", "℃": "C", 섭씨: "C", celsius: "C", f: "F", "°f": "F", "℉": "F", 화씨: "F", fahrenheit: "F", k: "K", kelvin: "K", 켈빈: "K" };
const tempOf = (w: string) => TEMP[w.trim().toLowerCase().replace(/도$/, "")];
function convTemp(v: number, a: "C" | "F" | "K", b: "C" | "F" | "K"): number {
  const c = a === "C" ? v : a === "F" ? (v - 32) * 5 / 9 : v - 273.15;
  return b === "C" ? c : b === "F" ? c * 9 / 5 + 32 : c + 273.15;
}

const UNIT_WORD = String.raw`([a-zA-Z°℃℉²/"]{1,12}|[가-힣]{1,6})`;
function unitsAnswer(p: string, ko: boolean): Quick | undefined {
  // temperature: "화씨 100도는 섭씨로", "100°F in C", "섭씨 30도 화씨로", "100 F to C"
  let m = new RegExp(String.raw`(화씨|섭씨|켈빈)\s?${N}\s?도?.{0,12}?(화씨|섭씨|켈빈)`).exec(p)
    ?? new RegExp(String.raw`${N}\s?(°\s?[cfCF]|℃|℉|도\s?(?=화씨|섭씨)|celsius|fahrenheit|kelvin|[cfkCFK])\b.{0,14}?\b(?:in|to|into|as|=)?\s*(°?\s?[cfkCFK]|celsius|fahrenheit|kelvin|섭씨|화씨|켈빈)\b`, "i").exec(p);
  if (m) {
    const [a, v, b] = /^(화씨|섭씨|켈빈)$/.test(m[1]) ? [tempOf(m[1]), toNum(m[2]), tempOf(m[3])] : [tempOf(m[2].replace(/\s/g, "")), toNum(m[1]), tempOf(m[3].replace(/\s/g, ""))];
    if (a && b && a !== b) {
      const r = convTemp(v, a, b), sym = (t: string) => t === "K" ? "K" : `°${t}`;
      return { kind: "units", detail: `temp ${a}->${b}`, answer: `${fmt(v)}${sym(a)} = **${fmt(Number(r.toFixed(2)))}${sym(b)}**` };
    }
  }
  // compound time: "3시간 45분은 몇 분", "2 hours 30 minutes in minutes"
  m = /(\d+)\s?(시간|hours?|hrs?)\s?(\d+)\s?(분|minutes?|mins?)(?:\s?(\d+)\s?(초|seconds?))?.{0,12}?(몇\s?)?(초|분|시간|seconds?|minutes?|hours?)/i.exec(p);
  if (m) {
    const secs = Number(m[1]) * 3600 + Number(m[3]) * 60 + Number(m[5] ?? 0), to = unit(m[8])!;
    return { kind: "units", detail: "time", answer: ko ? `${m[0].split(/[은는이가]|\s?(몇|in|to)\b/)[0].trim()} = **${fmt(secs / to.f)}${to.ko}**` : `= **${fmt(secs / to.f)} ${to.en}**` };
  }
  // "5 km는 몇 마일", "5 km is how many miles", "10 lbs to kg", "30평은 몇 제곱미터"
  m = new RegExp(String.raw`${N}\s?${UNIT_WORD}\s?(?:은|는|이|가|을|를|is|are|=|in|to|into|as|equals)?\s?(?:how many|몇|in|to|into|as)?\s?${UNIT_WORD}`, "i").exec(p);
  if (m) {
    const strip = (w: string) => w.replace(/(으로|로|이야|야|인가|일까|정도|은|는|이|가|을|를)$/, "");
    const a = unit(strip(m[2])), b = unit(strip(m[3]));
    if (a && b && a.dim === b.dim && a !== b) {
      const v = toNum(m[1]), r = v * a.f / b.f;
      return { kind: "units", detail: `${a.en}->${b.en}`, answer: `${fmt(v)} ${ko ? a.ko : a.en} = **${fmt(Number(r.toPrecision(8)))} ${ko ? b.ko : b.en}**` };
    }
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------- calc
function calcAnswer(p: string): Quick | undefined {
  const q = p.replace(/,(?=\d{3}\b)/g, "");
  // "17% of 2340", "2340의 17%", "2340에서 17%"
  let m = /(\d+(?:\.\d+)?)\s?%\s?(?:of|의)\s?(\d+(?:\.\d+)?)/i.exec(q) ?? /(\d+(?:\.\d+)?)\s?(?:원|달러|불|엔|유로)?\s?(?:의|에서)\s?(\d+(?:\.\d+)?)\s?%/.exec(q);
  if (m) {
    const [pct, base] = /%\s?(?:of|의)/i.test(m[0]) ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
    if (/(할인|off|discount|빼|minus)/i.test(q)) return { kind: "calc", detail: "discount", answer: `${fmt(base)} − ${fmt(pct)}% = **${fmt(base * (1 - pct / 100))}** (${fmt(base * pct / 100)} off)` };
    return { kind: "calc", detail: "percent_of", answer: `${fmt(pct)}% × ${fmt(base)} = **${fmt(base * pct / 100)}**` };
  }
  // percent change: "from 80 to 100 percent change", "80에서 100으로 몇 퍼센트"
  m = /(?:from\s)?(\d+(?:\.\d+)?)\s?(?:에서|to|→|->)\s?(\d+(?:\.\d+)?)\s?(?:으로|로)?.{0,20}(퍼센트|%|percent|증가율|감소율|변화율)/i.exec(q);
  if (m) { const a = Number(m[1]), b = Number(m[2]); if (a) return { kind: "calc", detail: "change", answer: `${fmt(a)} → ${fmt(b)}: **${b >= a ? "+" : ""}${fmt(Number(((b - a) / a * 100).toFixed(4)))}%**` }; }
  // a bare expression in the question ("What's 2^20?", "123*45 계산해줘", "(3+4)×5는?")
  const exprs = q.match(/[\d.(][\d.\s+\-*/×x÷^%()]*[\d)%]/g) ?? [];
  for (const e of exprs.sort((a, b) => b.length - a.length)) {
    if (!/[+\-*/×x÷^]/.test(e.replace(/^-/, "")) || /^\d+(\.\d+)?%?$/.test(e.trim())) continue;
    if (/\d{4}-\d{1,2}-\d{1,2}/.test(e) || /^\d{2,4}-\d{3,4}-\d{4}$/.test(e.trim())) continue;   // dates, phone numbers
    const v = evaluate(e);
    if (v !== undefined) return { kind: "calc", detail: "expr", answer: `${e.trim().replace(/\*/g, "×")} = **${fmt(v)}**` };
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ clock
const DAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
function dateStr(d: Date, ko: boolean, withTime = false): string {
  return ko
    ? `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY_KO[d.getDay()]}요일)${withTime ? ` ${d.getHours() < 12 ? "오전" : "오후"} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")}` : ""}`
    : d.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) });
}
function clockAnswer(p: string, ko: boolean, now: Date): Quick | undefined {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const note = ko ? `\n\n_이 Mac의 시계 기준 (${tz})._` : `\n\n_From this Mac's clock (${tz})._`;
  // N days/weeks from today: "100일 후", "30 days from now", "3주 뒤"
  let m = /(\d+)\s?(일|주|days?|weeks?)\s?(후|뒤|from (now|today)|later)/i.exec(p) ?? /in\s(\d+)\s(days?|weeks?)/i.exec(p);
  if (m && /(며칠|날짜|무슨|요일|언제|what|which|date|day)/i.test(p)) {
    const n = Number(m[1]) * (/주|week/i.test(m[2]) ? 7 : 1), d = new Date(now); d.setDate(d.getDate() + n);
    return { kind: "clock", detail: `+${n}d`, answer: (ko ? `오늘부터 ${n}일 뒤: **${dateStr(d, ko)}**` : `${n} days from today: **${dateStr(d, ko)}**`) + note };
  }
  // days until a date: "크리스마스까지 며칠", "12월 25일까지 며칠 남았어", "how many days until March 3"
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let target: Date | undefined;
  if (/(크리스마스|christmas)/i.test(p)) target = new Date(now.getFullYear(), 11, 25);
  else if (/(새해|신정|new year)/i.test(p)) target = new Date(now.getFullYear() + 1, 0, 1);
  else if ((m = /(\d{1,2})\s?월\s?(\d{1,2})\s?일/.exec(p))) target = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  else if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s(\d{1,2})\b/i.exec(p))) target = new Date(now.getFullYear(), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]));
  if (target && /(까지|남았|남은|until|till|left|how many days|며칠|D-?day|디데이)/i.test(p)) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (target < today) target.setFullYear(target.getFullYear() + 1);
    const n = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    return { kind: "clock", detail: `until ${n}d`, answer: (ko ? `**${n}일** 남았어요 (${dateStr(target, ko)}, D-${n}).` : `**${n} days** to go (${dateStr(target, ko)}).`) + note };
  }
  const askTime = /(몇\s?시|지금\s?시간|현재\s?시간|시간\s?(알려|좀|몇)|what time is it|current time|time now|the time\b)/i.test(p) && !/(시간대|타임\s?존|time\s?zone|에서는|in (new york|london|tokyo|paris|seoul))/i.test(p);
  const askDate = /(오늘|today|지금|현재|now).{0,10}(며칠|몇\s?일|날짜|무슨\s?요일|무슨\s?날|요일|date|day)|(며칠이야|몇\s?월\s?며칠|what('s| is) (the )?date|what day is (it|today)|today'?s date|date today)/i.test(p) && !/(내일|어제|모레|tomorrow|yesterday)/i.test(p);
  const rel = /(내일|tomorrow)/i.test(p) ? 1 : /(어제|yesterday)/i.test(p) ? -1 : /(모레)/.test(p) ? 2 : 0;
  if (rel && /(며칠|날짜|요일|date|day)/i.test(p)) { const d = new Date(now); d.setDate(d.getDate() + rel); return { kind: "clock", detail: `rel ${rel}`, answer: `**${dateStr(d, ko)}**` + note }; }
  if (askTime || askDate) return { kind: "clock", detail: askTime ? "time" : "date", answer: `**${dateStr(now, ko, askTime)}**` + note };
  return undefined;
}

/** Long or document-bound requests are not quick questions ("이 PDF의 17%…", pasted text). */
export function quickAnswer(prompt: string, ko: boolean, now = new Date()): Quick | undefined {
  const p = prompt.trim();
  const sc = p.length <= 120 && !/\n/.test(p) ? shortcutAnswer(p, ko) : undefined;   // "숨김 파일 보는 단축키": a file word is fine here
  if (sc) return sc;
  if (p.length > 120 || /\n/.test(p) || /(파일|문서|폴더|pdf|docx?|xlsx|csv|이\s?표|시트|sheet|file|document|folder|코드|code|함수|function|커밋|commit)/i.test(p)) return undefined;
  if (/(방법|사용법|어떻게|how (do|to|can|should) i)/i.test(p) && !/(how many|how much|몇|단축키|shortcut)/i.test(p)) return undefined;
  return networkAnswer(p, ko) ?? clockAnswer(p, ko, now) ?? unitsAnswer(p, ko) ?? calcAnswer(p);
}
