// Web search for the AFM agent: free, no API keys, nothing installed.
//   searxng    self-hosted metasearch (open source, AGPL) at SEARXNG_URL / 127.0.0.1:8888 — used when running
//   duckduckgo DuckDuckGo Lite HTML endpoint — fallback when SearXNG is not running
//   arxiv      export.arxiv.org API — papers
//   wikipedia  REST search API (ko/en) — definitions, background
// Every query is shown to the user and sent only after approval (it leaves the Mac). Queries are
// redacted; page fetches are http(s) only, public hosts only (no localhost / private ranges), size-
// and time-capped, and reduced to plain text before AFM sees them.

import { redact } from "../security/gate.ts";

export interface WebResult { title: string; url: string; snippet: string; source: string }
export type WebKind = "general" | "papers" | "encyclopedia";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) OnBud/0.1 (local research assistant)";
const SEARXNG = process.env.SEARXNG_URL ?? "http://127.0.0.1:8888";

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function get(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response | undefined> {
  try { return await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" }); }
  catch { return undefined; }
}

export async function searxngAvailable(): Promise<boolean> {
  const r = await get(`${SEARXNG}/healthz`, {}, 1500);
  return !!r && r.ok;
}

async function searxng(q: string, n: number, kind: WebKind): Promise<WebResult[]> {
  const cat = kind === "papers" ? "science" : "general";
  const r = await get(`${SEARXNG}/search?format=json&categories=${cat}&q=${encodeURIComponent(q)}`);
  if (!r?.ok) return [];
  const d: any = await r.json().catch(() => ({}));
  return (d.results ?? []).slice(0, n).map((x: any) => ({ title: String(x.title ?? ""), url: String(x.url ?? ""), snippet: String(x.content ?? "").slice(0, 300), source: "searxng" }));
}

async function duckduckgo(q: string, n: number): Promise<WebResult[]> {
  const r = await get("https://lite.duckduckgo.com/lite/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `q=${encodeURIComponent(q)}&kl=wt-wt` });
  if (!r?.ok) return [];
  const html = await r.text();
  const out: WebResult[] = [];
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
  links.forEach((m, i) => {
    let url = decode(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (/^https?:\/\//.test(url) && !/duckduckgo\.com\/y\.js/.test(url)) out.push({ title: strip(m[2]), url, snippet: snippets[i] ?? "", source: "duckduckgo" });
  });
  return out.slice(0, n);
}

async function arxiv(q: string, n: number): Promise<WebResult[]> {
  // Every word must match (arXiv treats space-separated terms loosely otherwise).
  const terms = q.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((t) => t.length >= 3 && !/^(the|and|for|with|from|about|paper|papers|related|relevant|work|works|study|studies|research|survey|논문|관련|연구)$/.test(t)).slice(0, 6);
  // The first two words as a phrase ("sparse attention"), the rest as required words.
  const parts = terms.length >= 2 ? [`all:%22${encodeURIComponent(terms[0] + " " + terms[1])}%22`, ...terms.slice(2).map((t) => `all:${encodeURIComponent(t)}`)] : terms.map((t) => `all:${encodeURIComponent(t)}`);
  const sq = parts.join("+AND+");
  const r = await get(`https://export.arxiv.org/api/query?search_query=${sq}&start=0&max_results=${n}&sortBy=relevance`);
  if (!r?.ok) return [];
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1];
    const tag = (t: string) => strip(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(e)?.[1] ?? "");
    const authors = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((a) => a[1]).slice(0, 4).join(", ");
    return { title: tag("title"), url: tag("id"), snippet: `${authors}${authors ? " — " : ""}${tag("published").slice(0, 10)} — ${tag("summary").slice(0, 260)}`, source: "arxiv" };
  });
}

async function wikipedia(q: string, n: number, lang: string): Promise<WebResult[]> {
  const r = await get(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=${n}`);
  if (!r?.ok) return [];
  const d: any = await r.json().catch(() => ({}));
  return (d.pages ?? []).map((p: any) => ({ title: String(p.title), url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.key))}`, snippet: strip(String(p.excerpt ?? "")) + (p.description ? ` (${p.description})` : ""), source: "wikipedia" }));
}

/** Search with the best available backend for the kind of question. */
export async function webSearch(query: string, opts: { kind?: WebKind; n?: number; lang?: string } = {}): Promise<{ results: WebResult[]; backend: string }> {
  const q = redact(query).text.slice(0, 200);
  const n = opts.n ?? 5;
  if (opts.kind === "papers") {
    // arXiv's own search is literal; a web search restricted to arxiv.org catches what it misses.
    const [a, d] = await Promise.all([arxiv(q, n), duckduckgo(`${q} site:arxiv.org`, n)]);
    const seen = new Set<string>();
    const id = (u: string) => /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/.exec(u)?.[1] ?? u;   // also ar5iv.labs.arxiv.org/html/…
    const merged = [...a, ...d].filter((r) => { const k = id(r.url); if (seen.has(k)) return false; seen.add(k); return true; });
    if (merged.length) return { results: merged.slice(0, n), backend: d.length ? "arxiv+duckduckgo" : "arxiv" };
  }
  if (opts.kind === "encyclopedia") {
    const w = await wikipedia(q, n, opts.lang ?? (/[가-힣]/.test(q) ? "ko" : "en"));
    if (w.length) return { results: w, backend: "wikipedia" };
  }
  if (await searxngAvailable()) {
    const s = await searxng(q, n, opts.kind ?? "general");
    if (s.length) return { results: s, backend: "searxng" };
  }
  const d = await duckduckgo(q, n);
  if (d.length) return { results: d, backend: "duckduckgo" };
  const w = await wikipedia(q, n, /[가-힣]/.test(q) ? "ko" : "en");
  return { results: w, backend: w.length ? "wikipedia" : "none" };
}

/** Only public http(s) hosts: no loopback, link-local, private ranges or bare hostnames (SSRF guard). */
export function publicUrl(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
  const h = url.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".local") || h.endsWith(".localhost") || h === "localhost") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[") || /^\d+$/.test(h)) return false;
  return true;
}

/** Fetch a page as plain text (title + main text), capped. */
export async function fetchPage(u: string, maxChars = 4000): Promise<{ url: string; title: string; text: string; error?: string }> {
  if (!publicUrl(u)) return { url: u, title: "", text: "", error: "blocked_url" };
  const r = await get(u, { headers: { Accept: "text/html,application/xhtml+xml,text/plain" } }, 12_000);
  if (!r?.ok) return { url: u, title: "", text: "", error: `http_${r?.status ?? "fail"}` };
  if (r.url && !publicUrl(r.url)) return { url: u, title: "", text: "", error: "blocked_redirect" };
  const type = r.headers.get("content-type") ?? "";
  if (!/text\/|xhtml|xml/.test(type)) return { url: u, title: "", text: "", error: `unsupported_${type.split(";")[0]}` };
  const reader = r.body?.getReader();
  let html = "";
  if (reader) {
    const dec = new TextDecoder();
    while (html.length < 1_500_000) { const { done, value } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); }
    reader.cancel().catch(() => {});
  }
  const title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const main = /<(article|main)[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? html;
  const text = decode(main.replace(/<(script|style|nav|header|footer|aside|noscript|svg|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h\d|li|tr|br|section)>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { url: r.url || u, title, text: redact(text).text.slice(0, maxChars) };
}

// Explicit web intent only: "latest"/"news"/"online" alone also appear in git and file questions
// ("show the latest commit", "news.py", "is this repo online?").
const WEB_EXPLICIT = /(웹에서|웹 ?검색|인터넷(에서|으로)?\s?(검색|찾|확인|알아)|온라인(에서|으로)\s?(검색|찾|확인|알아)|구글(에서|링)?|검색해\s?(줘|봐|서)|search (the )?(web|internet|online)|web search|on the web|google (it|for)|look (it )?up online)/i;
const WEB_FRESH = /((최신|요즘|최근)\s?(뉴스|동향|소식|릴리스)|(latest|recent) (news|release notes?|announcements?))(?!\.\w)/i;
const LOCAL_CONTEXT = /(커밋|브랜치|파일|폴더|commit|branch|diff|file|folder|repo|\.\w{1,5}\b)/i;
export function isWebRequest(prompt: string): boolean {
  return WEB_EXPLICIT.test(prompt) || (WEB_FRESH.test(prompt) && !LOCAL_CONTEXT.test(prompt));
}

export function kindFor(prompt: string): WebKind {
  if (/(논문|arxiv|paper|preprint|연구 동향|관련 연구|related work)/i.test(prompt)) return "papers";
  if (/(위키|wikipedia|정의|뜻이|무엇인가|what is|who is|who was)/i.test(prompt)) return "encyclopedia";
  return "general";
}
