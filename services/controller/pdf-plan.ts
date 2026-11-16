// PDF merge and page plans (2026-11-14): which files, in what order, and which pages of each, read from the request
// by code (en/ko). Used by the convert skill (mac-tasks.ts) with tools/pdftool `assemble`; AFM is not involved.
//   order     attached order; the order the files are named in ("b.pdf랑 a.pdf"); relations ("put a.pdf after b.pdf",
//             "b.pdf를 a.pdf 뒤에", "a.pdf 먼저", "c.pdf last"); by name / date / reverse
//   pages     per file, "only" or "except": numbers and ranges ("3쪽", "2-4페이지", "pages 1, 3 and 5"), first/last
//             ("첫 페이지", "the last 2 pages", "표지"), open ranges ("3쪽부터", "up to page 4"), odd/even
//   binding   "page 3 of b.pdf", "b.pdf의 3쪽", "b.pdf without page 3"; neighbours joined by "and/과" share a file;
//             "합친 파일에서 3쪽" / "of the merged file" is the result; with one PDF, that file. A page phrase that
//             cannot be tied to a file is asked about, never guessed.
//   insert    "insert b.pdf after page 3 of a.pdf", "b.pdf를 a.pdf 3쪽 뒤에 넣어줘", "between pages 3 and 4"
// The plan is resolved against real page counts (resolvePdfPlan): a page that does not exist is reported, not dropped.
import { basename, extname } from "node:path";

export type Ref = { n: number } | { last: number };   // last: 0 = the last page, 1 = the one before it
export interface Span { from: Ref; to: Ref }
export interface Sel { spans: Span[]; parity?: "odd" | "even"; text: string }
export interface PdfPlan {
  order: number[];                                   // indexes into the inputs
  left: number[];                                    // attached but not named, when others are named
  only: Map<number, Sel[]>; except: Map<number, Sel[]>;
  result: { only: Sel[]; except: Sel[] };            // page numbers of the merged result
  insert?: { file: number; host: number; after: Ref };
  unbound: string[];                                 // page phrases with no file (ask)
  pageWords: boolean;                                // the request talks about pages at all
}

const NUMW: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const ORD: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5,
  첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5 };
const num = (s: string | undefined) => (s === undefined ? undefined : /^\d+$/.test(s) ? Number(s) : NUMW[s.toLowerCase()] ?? ORD[s.toLowerCase()]);

interface Mention { file: number; start: number; end: number; topic: boolean }
interface Expr { start: number; end: number; sel: Sel; mode?: "only" | "except"; file?: number | "result"; anchor?: "after" | "before" }

/** Where each input is named in the request: its file name, its name without the extension, or "the second file". */
export function mentions(ask: string, inputs: string[]): Mention[] {
  const found: Mention[] = [];
  const lower = ask.toLowerCase();
  inputs.forEach((f, i) => {
    const base = basename(f).normalize("NFC").toLowerCase(), stem = basename(f, extname(f)).normalize("NFC").toLowerCase();
    const names = [base, ...(stem.length >= (/[가-힣]/.test(stem) ? 2 : 3) ? [stem] : [])];
    for (const n of names) {
      for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, at + 1)) {
        const before = lower[at - 1] ?? " ", after = lower[at + n.length] ?? " ";
        if (n === stem && (/[a-z0-9_]/.test(before) || /[a-z0-9_]/.test(after) || after === ".")) continue;
        found.push({ file: i, start: at, end: at + n.length, topic: false });
      }
    }
  });
  // "the second file", "두 번째 파일", "file 2": the attached order
  for (const m of ask.matchAll(/\b(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:file|pdf|one|document)\b|\b(?:file|pdf)\s+#?(\d)\b|(첫|두|세|네|다섯)\s?번째\s?(?:파일|pdf|문서|것|거)|(\d)\s?번\s?(?:파일|pdf|문서)/gi)) {
    const k = (num(m[1] ?? m[3]) ?? Number(m[2] ?? m[4])) - 1;
    if (k >= 0 && k < inputs.length) found.push({ file: k, start: m.index!, end: m.index! + m[0].length, topic: false });
  }
  // longest first at overlapping spots
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Mention[] = [];
  for (const m of found) if (!out.some((o) => m.start < o.end && o.start < m.end)) out.push(m);
  for (const m of out) m.topic = /^\s?(?:파일|pdf)?\s?(?:은|는)/i.test(ask.slice(m.end, m.end + 6));
  return out;
}

const RANGE = String.raw`\d{1,4}(?:\s*(?:-|–|—|~|to|through|thru)\s*\d{1,4})?`;
const LIST = String.raw`${RANGE}(?:\s*(?:,|and|&|or|및|과|와|,\s*and)\s*${RANGE})*`;
function spansOf(list: string): Span[] {
  return list.split(/\s*(?:,|and|&|or|및|과|와)\s*/).filter(Boolean).map((r) => {
    const [a, b] = r.split(/\s*(?:-|–|—|~|to|through|thru)\s*/).map(Number);
    return { from: { n: Math.min(a, b ?? a) }, to: { n: Math.max(a, b ?? a) } };
  });
}

/** Page phrases, left to right, without overlaps (the more specific patterns first). */
export function pageExprs(ask: string): Expr[] {
  const out: Expr[] = [];
  const add = (start: number, end: number, spans: Span[], parity?: "odd" | "even") => {
    if (out.some((o) => start < o.end && o.start < end)) return;
    out.push({ start, end, sel: { spans, parity, text: ask.slice(start, end).trim() } });
  };
  const each = (re: RegExp, f: (m: RegExpMatchArray) => Span[] | undefined, parity?: (m: RegExpMatchArray) => "odd" | "even") => {
    for (const m of ask.matchAll(re)) { const s = f(m); if (s) add(m.index!, m.index! + m[0].length, s, parity?.(m)); }
  };
  const U = String.raw`(?:쪽|페이지|p\b|pages?\b)`;
  // open and closed "from … to …"
  each(new RegExp(String.raw`(\d{1,4})\s*${U}?\s*부터\s*(?:(\d{1,4})\s*${U}?\s*까지|(?:끝|마지막|맨\s?뒤)\s?(?:쪽|페이지|장)?\s?까지)?`, "gi"),
    (m) => [{ from: { n: Number(m[1]) }, to: m[2] ? { n: Number(m[2]) } : { last: 0 } }]);
  each(new RegExp(String.raw`(?:처음|첫\s?(?:쪽|페이지|장))?\s*(?:부터\s*)?(\d{1,4})\s*${U}\s*까지`, "gi"), (m) => [{ from: { n: 1 }, to: { n: Number(m[1]) } }]);
  each(/\bfrom\s+page\s+(\d{1,4})(?:\s+(?:to|through|until)\s+(?:page\s+)?(\d{1,4})|\s+(?:on(?:wards?)?|to the end|until the end))?/gi,
    (m) => [{ from: { n: Number(m[1]) }, to: m[2] ? { n: Number(m[2]) } : { last: 0 } }]);
  each(/\bpages?\s+(\d{1,4})\s*(?:and\s+(?:after|beyond|on|later)|onwards?|\+|to the end|through the end)/gi, (m) => [{ from: { n: Number(m[1]) }, to: { last: 0 } }]);
  each(/\b(?:up\s+to|through|until)\s+page\s+(\d{1,4})\b/gi, (m) => [{ from: { n: 1 }, to: { n: Number(m[1]) } }]);
  // first / last
  each(/\b(?:the\s+)?(first|last|final|opening)\s+(?:(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten)\s+)?pages?\b/gi, (m) => {
    const k = num(m[2]) ?? 1;
    return /first|opening/i.test(m[1]) ? [{ from: { n: 1 }, to: { n: k } }] : [{ from: { last: k - 1 }, to: { last: 0 } }];
  });
  each(/\b(?:the\s+)?(?:cover|title)(?:\s+page)?\b/gi, () => [{ from: { n: 1 }, to: { n: 1 } }]);
  each(/(첫|처음|맨\s?앞|앞|마지막|맨\s?뒤|맨\s?끝|끝|뒤|뒷)\s?(\d{1,3}|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)?\s?(?:번째\s?)?(쪽|페이지|장)/g, (m) => {
    const head = /^(첫|처음|맨\s?앞|앞)$/.test(m[1]);
    if (/^(앞|뒤|뒷)$/.test(m[1]) && !m[2]) return undefined;   // "3쪽 뒤에" is a place, not "the last page"
    const k = num(m[2]) ?? 1;
    return head ? [{ from: { n: 1 }, to: { n: k } }] : [{ from: { last: k - 1 }, to: { last: 0 } }];
  });
  each(/표지/g, () => [{ from: { n: 1 }, to: { n: 1 } }]);
  // ordinal pages: "the 3rd page", "third page", "세 번째 페이지", "3번째 쪽"
  each(/\b(?:the\s+)?(second|third|fourth|fifth|2nd|3rd|4th|5th|\d{1,3}(?:st|nd|rd|th))\s+page\b/gi, (m) => { const k = num(m[1]) ?? parseInt(m[1]); return [{ from: { n: k }, to: { n: k } }]; });
  each(/(\d{1,3}|두|세|네|다섯)\s?번째\s?(?:쪽|페이지|장)/g, (m) => { const k = num(m[1])!; return [{ from: { n: k }, to: { n: k } }]; });
  // odd / even
  each(/\b(odd|even)(?:[- ]numbered)?\s+pages?\b|(홀수|짝수)\s?(?:번째\s?)?(?:쪽|페이지)/gi, () => [], (m) => (/odd|홀수/i.test(m[0]) ? "odd" : "even"));
  // numbers: "pages 2-4 and 7", "p. 3", "2~4쪽", "1, 3, 5페이지", "3p"
  each(new RegExp(String.raw`\b(?:pages?|pp?\.)\s*(${LIST})`, "gi"), (m) => spansOf(m[1]));
  each(new RegExp(String.raw`(?<![\d.])(${LIST})\s*(?:쪽|페이지|p\b)`, "gi"), (m) => spansOf(m[1]));
  return out.sort((a, b) => a.start - b.start);
}

const EXCEPT_EN = /\b(without|except(?:\s+for)?|excluding|exclude|skip(?:ping)?|drop(?:ping)?|remov(?:e|ing)|delet(?:e|ing)|minus|leave out|leaving out|omit(?:ting)?|but not|other than|apart from|cut(?:ting)?|take out|taking out|get rid of|strip(?:ping)?)\b/gi;
const ONLY_EN = /\b(only|just|keep(?:ing)?(?:\s+only)?|extract(?:ing)?)\b/gi;
const EXCEPT_KO = /(빼|뺀|뺄|제외|삭제|지우|지워|없애|없이|말고|생략|제거|떼|버려|버리)/;
const SENT = /[.!?\n]|\bthen\b/i;

/** The whole plan from the request. `inputs` are the files in their attached order. */
export function pdfPlan(prompt: string, inputs: string[]): PdfPlan {
  const ask = prompt.split(/\n\n(Files|Text \()/)[0].normalize("NFC");
  const ms = mentions(ask, inputs);
  const xs = pageExprs(ask).filter((x) => !ms.some((m) => x.start < m.end && m.start < x.end));
  // the text with each file mention replaced by §, for gap tests
  const masked = (a: number, b: number) => {
    let s = "";
    for (let i = a; i < b; ) { const m = ms.find((q) => q.start === i); if (m) { s += "§"; i = m.end; } else s += ask[i++]; }
    return s;
  };
  const CONNECT = /^[\s,]*(?:(?:of|from|in)\s+(?:the\s+)?§(?:'s)?\s*)?(?:(?:과|와|이랑|랑|하고|및|그리고|and|&|or|,|plus|as well as)\s*)+(?:(?:the\s+)?§\s*(?:의|에서|은|는|'s|파일의|파일에서)?\s*)?(?:pages?\s*)?$/i;
  const connected = (a: Expr, b: Expr) => CONNECT.test(masked(a.end, b.start));

  // insertion places: "after page 3", "3쪽 뒤에", "between pages 3 and 4"
  for (const x of xs) {
    const pre = ask.slice(Math.max(0, x.start - 14), x.start), post = ask.slice(x.end, x.end + 8);
    if (/\bbetween\s+$/i.test(pre) || /^\s*(?:사이)/.test(ask.slice(x.end, x.end + 4))) { x.anchor = "after"; x.sel.spans = [{ from: x.sel.spans[0].from, to: x.sel.spans[0].from }]; }
    else if (/\b(after|following|behind)\s+(?:the\s+)?$/i.test(pre) || /^\s?(?:의\s?)?(?:뒤|다음|뒷부분)(?:에|으로|로|쪽)?/.test(post)) x.anchor = "after";
    else if (/\b(before|ahead of|in front of)\s+(?:the\s+)?$/i.test(pre) || /^\s?(?:의\s?)?앞(?:에|으로|로|쪽)/.test(post)) x.anchor = "before";
  }
  // "3쪽과 4쪽 사이": the second number belongs to the first
  for (let i = 1; i < xs.length; i++) if (xs[i - 1].anchor && /^\s?사이/.test(ask.slice(xs[i].end, xs[i].end + 4)) && connected(xs[i - 1], xs[i])) { xs[i - 1].anchor = "after"; xs.splice(i--, 1); }
  for (const x of xs) if (/^\s?사이/.test(ask.slice(x.end, x.end + 4)) && !x.anchor) x.anchor = "after";

  // modes: "only" right next to the phrase; English words before it; Korean words after it, up to the next phrase
  xs.forEach((x, i) => {
    if (x.anchor) return;
    if (/^\s?(?:까지)?\s?(?:만|only\b)/i.test(ask.slice(x.end, x.end + 8))) { x.mode = "only"; return; }
    const from = Math.max(i ? xs[i - 1].end : 0, ...[...ask.slice(0, x.start).matchAll(new RegExp(SENT, "gi"))].map((m) => m.index! + m[0].length));
    const back = ask.slice(from, x.start);
    const e = [...back.matchAll(EXCEPT_EN)].pop(), o = [...back.matchAll(ONLY_EN)].pop();
    if (e || o) { x.mode = (e?.index ?? -1) > (o?.index ?? -1) ? "except" : "only"; return; }
    if (/^\s*(?:removed|excluded|dropped|deleted|cut|left out|omitted|taken out)\b/i.test(ask.slice(x.end))) { x.mode = "except"; return; }
    let to = i + 1 < xs.length ? xs[i + 1].start : ask.length;
    const stop = ask.slice(x.end, to).search(SENT); if (stop >= 0) to = x.end + stop;
    const own = ms.filter((m) => m.end <= x.start).pop();
    if (own?.topic) { const c = ask.slice(x.end, to).indexOf(","); if (c >= 0) to = x.end + c; }
    if (EXCEPT_KO.test(ask.slice(x.end, to))) x.mode = "except";
  });
  // a phrase with no mode word takes its neighbour's when they are joined by "and"/"과" ("2쪽과 b.pdf의 3쪽을 빼고")
  for (let pass = 0; pass < 2; pass++) xs.forEach((x, i) => {
    if (x.mode || x.anchor) return;
    const nb = [xs[i + 1], xs[i - 1]].find((y) => y?.mode && (y === xs[i + 1] ? connected(x, y) : connected(y, x)));
    if (nb) x.mode = nb.mode;
  });

  // files: "page 3 of b.pdf", "the merged file", the file right before the phrase
  const RESULT_AFTER = /^\s*(?:of|from|in)\s+(?:the\s+)?(?:merged|combined|final|resulting|new)\s+(?:file|pdf|document|result|one|version)\b/i;
  const RESULT_BEFORE = /(합친|합쳐진|합쳐서|병합(?:한|된)|합한|결과|merged|combined|after (?:merging|combining)|once (?:merged|combined))\s?(?:뒤에?|후에?|다음에?)?\s?(?:파일|pdf|문서|본|file|pdf|document)?\s?(?:의|에서|은|는|'s|,)?\s*$/i;
  const NEAR = /^\s*(?:'s|의|에서|에서는|은|는|:|\(|-|—)?\s*(?:파일|pdf|문서)?\s*(?:의|에서|은|는)?\s*(?:(?:without|except|excluding|minus|but|skip(?:ping)?|drop(?:ping)?|only|just|keep|using|with|remov(?:e|ing)|delet(?:e|ing)|pages?)\s+(?:the\s+)?)*$/i;
  for (const x of xs) {
    const after = masked(x.end, Math.min(ask.length, x.end + 60));
    const ofm = /^\s*(?:of|from|in)\s+(?:the\s+)?§/i.exec(after);
    if (ofm) { const at = ms.find((m) => m.start >= x.end); if (at) { x.file = at.file; continue; } }
    if (RESULT_AFTER.test(ask.slice(x.end))) { x.file = "result"; continue; }
    const prev = ms.filter((m) => m.end <= x.start).pop();
    const lead = ask.slice(Math.max(prev?.end ?? 0, x.start - 30), x.start);
    if (RESULT_BEFORE.test(lead)) { x.file = "result"; continue; }
    if (prev && NEAR.test(ask.slice(prev.end, x.start))) x.file = prev.file;
  }
  for (let pass = 0; pass < 2; pass++) xs.forEach((x, i) => {
    if (x.file !== undefined) return;
    const nb = [xs[i - 1], xs[i + 1]].find((y) => y?.file !== undefined && (y === xs[i + 1] ? connected(x, y) : connected(y, x)));
    if (nb) x.file = nb.file;
  });
  const pdfIdx = inputs.map((f, i) => (/\.pdf$/i.test(f) ? i : -1)).filter((i) => i >= 0);
  if (pdfIdx.length === 1) for (const x of xs) if (x.file === undefined) x.file = pdfIdx[0];

  // order
  const idx = inputs.map((_, i) => i);
  let order = idx;
  const pm = (p: string) => p.replace(/§/g, "");
  const firstAt = new Map<number, number>(); for (const m of ms) if (!firstAt.has(m.file)) firstAt.set(m.file, m.start);
  if (/(이름\s?순|알파벳\s?순|가나다\s?순|파일\s?명\s?순|alphabetical|by (?:file\s?)?name|name order)/i.test(ask)) order = [...idx].sort((a, b) => basename(inputs[a]).localeCompare(basename(inputs[b]), undefined, { numeric: true }));
  else if (firstAt.size >= 2) {
    // the list of files ("a.pdf, b.pdf and c.pdf", "a랑 b랑 c") sets the order; "Put b.pdf after c.pdf and merge
    // a.pdf, b.pdf, c.pdf" names b first only to move it. Then files named elsewhere, then the rest as attached.
    const runs: number[][] = [];
    ms.forEach((m, i) => {
      const joined = i > 0 && /^\s*(?:파일)?\s*(?:,|과|와|이랑|랑|하고|및|그리고|and|&|plus|then|,\s*and|,\s*then|->|→|다음에?|then)\s*(?:the\s+)?$/i.test(ask.slice(ms[i - 1].end, m.start));
      if (joined) runs[runs.length - 1].push(m.file); else runs.push([m.file]);
    });
    const list = runs.map((r) => [...new Set(r)]).reduce((a, b) => (b.length > a.length ? b : a), [] as number[]);
    const rank = (k: number) => (list.includes(k) ? list.indexOf(k) : list.length + (firstAt.get(k) ?? 1e9));
    order = [...idx].sort((a, b) => rank(a) - rank(b) || a - b);
  }
  // two or more files named: only those (the others attached stay out, and the answer says so)
  const left = firstAt.size >= 2 ? order.filter((k) => !firstAt.has(k)) : [];
  order = order.filter((k) => !left.includes(k));
  if (/(역순|거꾸로|반대\s?순서|reverse(?:d)? order|in reverse|backwards)/i.test(pm(ask))) order = [...order].reverse();
  // relations between named files, on the text with mentions as §k§
  let rel = ""; for (let i = 0; i < ask.length; ) { const m = ms.find((q) => q.start === i); if (m) { rel += `§${m.file}§`; i = m.end; } else rel += ask[i++]; }
  const move = (x: number, where: "after" | "before" | "first" | "last", y?: number) => {
    if (x === y) return;
    const o = order.filter((k) => k !== x);
    const at = where === "first" ? 0 : where === "last" ? o.length : o.indexOf(y!) + (where === "after" ? 1 : 0);
    if (at < 0) return;
    o.splice(at, 0, x); order = o;
  };
  const F = String.raw`§(\d+)§`;
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s*(?:파일)?\s*(?:을|를|은|는|이|가)?\s*${F}\s*(?:파일)?\s*(?:의\s?)?(?:뒤|다음|뒤쪽|끝)(?:에|으로|로)`, "g"))) move(+m[1], "after", +m[2]);
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s*(?:파일)?\s*(?:을|를|은|는|이|가)\s*${F}\s*(?:파일)?\s*(?:의\s?)?앞(?:에|으로|로)`, "g"))) move(+m[1], "before", +m[2]);
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s*(?:파일)?\s*(?:을|를)\s*${F}\s*(?:파일)?\s*(?:에|에다|에다가)\s*(?:붙|이어|덧붙|추가|합쳐)`, "g"))) move(+m[1], "after", +m[2]);
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s+(?:after|behind|following|at the end of|to the end of)\s+(?:the\s+)?${F}`, "gi"))) move(+m[1], "after", +m[2]);
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s+(?:before|ahead of|in front of)\s+(?:the\s+)?${F}`, "gi"))) move(+m[1], "before", +m[2]);
  for (const m of rel.matchAll(new RegExp(String.raw`\b(?:append|attach|add)\s+${F}\s+(?:to|onto)\s+(?:the\s+end\s+of\s+)?${F}`, "gi"))) move(+m[1], "after", +m[2]);
  for (const m of rel.matchAll(new RegExp(String.raw`(?:${F}\s+(?:goes\s+|comes\s+|come\s+|go\s+|is\s+|be\s+)?(?:first|at the (?:start|front|beginning|top))\b|\b(?:start|begin)\s+with\s+${F})`, "gi"))) move(+(m[1] ?? m[2]), "first");
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s+(?:goes\s+|comes\s+|come\s+|go\s+|is\s+|be\s+)?(?:last|at the (?:end|back|bottom))\b`, "gi"))) move(+m[1], "last");
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s*(?:파일)?\s*(?:을|를|이|가|은|는)?\s*(?:먼저|맨\s?앞|맨\s?처음|첫\s?번째로|제일\s?앞)`, "g"))) move(+m[1], "first");
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s*(?:파일)?\s*(?:을|를|이|가|은|는)\s*앞(?:에|으로|로)\s?(?:두|놓|오|가|배치|넣|붙)`, "g"))) move(+m[1], "first");
  // "a.pdf 앞에 b.pdf를 넣어" → b before a
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s*(?:파일)?\s*(?:의\s?)?앞(?:에|으로|로|쪽에)\s*${F}\s*(?:파일)?\s*(?:을|를)`, "g"))) move(+m[2], "before", +m[1]);
  for (const m of rel.matchAll(new RegExp(String.raw`${F}\s*(?:파일)?\s*(?:을|를|이|가|은|는)?\s*(?:맨\s?뒤|맨\s?끝|마지막|제일\s?뒤|끝)(?:에|으로|로)`, "g"))) move(+m[1], "last");

  // insertion: the anchored phrase's file is the host; the other named file goes in
  let insert: PdfPlan["insert"];
  const anchor = xs.find((x) => x.anchor && typeof x.file === "number");
  if (anchor) {
    const host = anchor.file as number, ref = anchor.sel.spans[0].from;
    const objKo = new RegExp(String.raw`§(\d+)§\s*(?:파일)?\s*(?:을|를)`).exec(rel);
    const objEn = new RegExp(String.raw`\b(?:insert|put|place|add|slip|stick|merge)\s+(?:the\s+)?${F}`, "i").exec(rel);
    const cands = order.filter((k) => k !== host);
    const pick = [objKo && +objKo[1], objEn && +objEn[1]].find((k) => typeof k === "number" && k !== host) as number | undefined;
    const file = pick ?? (cands.length === 1 ? cands[0] : undefined);
    if (file !== undefined) {
      const after: Ref = anchor.anchor === "before" ? ("n" in ref ? { n: ref.n - 1 } : { last: ref.last + 1 }) : ref;
      insert = { file, host, after };
    }
  }

  const only = new Map<number, Sel[]>(), except = new Map<number, Sel[]>(), result = { only: [] as Sel[], except: [] as Sel[] };
  const unbound: string[] = [];
  for (const x of xs) {
    if (x.anchor) { if (!insert) unbound.push(x.sel.text); continue; }
    const mode = x.mode ?? "only";
    if (x.file === "result") result[mode].push(x.sel);
    else if (typeof x.file === "number") { const m = mode === "only" ? only : except; m.set(x.file, [...(m.get(x.file) ?? []), x.sel]); }
    else unbound.push(x.sel.text);
  }
  return { order, left, only, except, result, insert, unbound, pageWords: xs.length > 0 };
}

const at = (r: Ref, count: number) => ("n" in r ? r.n : count - r.last);
function pagesOf(sels: Sel[], count: number, bad: string[], name: string): number[] {
  const out: number[] = [];
  for (const s of sels) {
    if (s.parity) { for (let p = s.parity === "odd" ? 1 : 2; p <= count; p += 2) out.push(p); continue; }
    for (const sp of s.spans) {
      const a = at(sp.from, count), b = at(sp.to, count);
      if (a < 1 || b > count || a > b) { bad.push(`${name}: ${s.text} (${count})`); continue; }
      for (let p = a; p <= b; p++) out.push(p);
    }
  }
  return [...new Set(out)];
}

export interface Segment { file: number; pages: number[] }
/** The plan against real page counts: segments in order, or what is wrong (pages that do not exist, nothing left). */
export function resolvePdfPlan(plan: PdfPlan, inputs: string[], counts: number[]): { segments: Segment[] } | { error: "out_of_range" | "empty"; bad: string[] } {
  const bad: string[] = [];
  const pages = new Map<number, number[]>();
  for (const f of plan.order) {
    const name = basename(inputs[f]), n = counts[f];
    const only = plan.only.get(f), except = plan.except.get(f);
    let ps = only?.length ? pagesOf(only, n, bad, name) : Array.from({ length: n }, (_, i) => i + 1);
    if (except?.length) { const ex = new Set(pagesOf(except, n, bad, name)); ps = ps.filter((p) => !ex.has(p)); }
    pages.set(f, ps);
  }
  if (plan.insert) { const n = counts[plan.insert.host], a = at(plan.insert.after, n); if (a < 0 || a > n) bad.push(`${basename(inputs[plan.insert.host])}: ${a} (${n})`); }
  if (bad.length) return { error: "out_of_range", bad };
  let segs: Segment[] = [];
  for (const f of plan.order) {
    if (plan.insert && f === plan.insert.file) continue;
    const ps = pages.get(f)!;
    if (plan.insert && f === plan.insert.host) {
      const a = at(plan.insert.after, counts[f]);
      const cut = ps.findIndex((p) => p > a), head = cut < 0 ? ps : ps.slice(0, cut), tail = cut < 0 ? [] : ps.slice(cut);
      segs.push({ file: f, pages: head }, { file: plan.insert.file, pages: pages.get(plan.insert.file)! }, { file: f, pages: tail });
    } else segs.push({ file: f, pages: ps });
  }
  // pages of the merged result
  if (plan.result.only.length || plan.result.except.length) {
    const flat = segs.flatMap((s) => s.pages.map((p) => ({ file: s.file, p })));
    const keep = plan.result.only.length ? new Set(pagesOf(plan.result.only, flat.length, bad, "merged")) : undefined;
    const drop = new Set(pagesOf(plan.result.except, flat.length, bad, "merged"));
    if (bad.length) return { error: "out_of_range", bad };
    const kept = flat.filter((_, i) => (!keep || keep.has(i + 1)) && !drop.has(i + 1));
    segs = [];
    for (const k of kept) { const last = segs[segs.length - 1]; if (last && last.file === k.file) last.pages.push(k.p); else segs.push({ file: k.file, pages: [k.p] }); }
  }
  segs = segs.filter((s) => s.pages.length);
  if (!segs.length) return { error: "empty", bad: [] };
  return { segments: segs };
}

/** "1–3, 5" */
export function pageRanges(ps: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ps.length; ) {
    let j = i; while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++;
    out.push(j > i ? `${ps[i]}–${ps[j]}` : `${ps[i]}`); i = j + 1;
  }
  return out.join(", ");
}
