// Reply-language contract (skills plan P1, 2026-11-06): the reply is in the language of the request's own words.
// Paths, quotes, code and file names carry no language ("Find the PDF in ~/Desktop/연구 자료" is English);
// a request too short to tell falls back to "any Hangul → Korean" (the controller's earlier rule).
// fitLanguage() translates a reply that came out in the other language, with code, paths, links, numbers and
// Latin-script names masked; if any masked part is lost, the original is kept (a wrong name is worse than the
// other language).
import type { AFMProvider } from "../afm-adapter/provider.ts";

// The languages Apple's on-device model supports (and so can be answered in and translated to).
export type Lang = "ko" | "en" | "ja" | "zh" | "es" | "fr" | "de" | "pt" | "it";
export const LANG_NAME: Record<Lang, string> = { ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian" };
// Function words that tell the Latin-script languages apart (a few per language, frequent and distinctive).
const STOP: Record<"en" | "es" | "fr" | "de" | "pt" | "it", RegExp> = {
  // words or marks one language uses and the others do not (shared ones like "en", "que", "la" are left out)
  en: /\b(the|and|is|are|am|of|to|what|which|how|my|this|that|with|for|do|does|did|you|your|it|in|or|should|can|have|be|on|at|from|me|there|will|was)\b/g,
  es: /\b(el|los|las|del|qué|cómo|cuál|está|están|una|por|para|y|con|hay|dos|frases)\b|[¿¡ñ]/g,
  fr: /\b(le|les|des|est|sont|et|une|dans|pour|avec|qui|ce|cette|ces|du|au|aux|où|très|deux|il y a|plusieurs|tels|telles|comme|aussi|mais|leur|leurs|pas|plus|sous|chaque)\b|\b[ldjcmnst]['’]\w|[êûœ]/g,
  de: /\b(der|die|das|und|ist|sind|nicht|ein|eine|mit|für|auf|wie|was|welche|welcher|wo|gibt|ich|im|den|dem|zwei|bitte)\b|[äöüß]/g,
  pt: /\b(os|as|do|da|dos|das|não|é|está|estão|são|em|no|na|com|uma|um|como|qual|quais|você|duas)\b|[ãõç]/g,
  it: /\b(il|lo|gli|della|nella|nel|del|dei|che|è|non|una|un|per|come|quale|quali|cosa|dove|sono|ci|la|le|di|questo|questa|due)\b|[ìò]/g,
};

// Text that says nothing about the language: code, paths, URLs, quoted names, markdown links, file names.
function prose(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/(file|https?):\/\/\S+/g, " ")
    .replace(/[\w.~@+%-]*\/[\w.~@+%\/-]*/g, " ")   // a path or URL, whole (ASCII only: "フォルダーにはafm-adapter/" keeps its Japanese)
    .replace(/"[^"\n]{0,120}"|“[^”\n]{0,120}”|'[^'\n]{0,80}'/g, " ")
    .replace(/\*\*[^*\n]{0,120}\*\*/g, " ")
    .replace(/\S+\.(pdf|docx?|pptx?|xlsx|csv|md|txt|tex|py|ts|js|json|ya?ml)\b/gi, " ")
    // identifiers: folder/ names, kebab-case, snake_case, dotted.names, CamelCase (afm-adapter/, codeRoute)
    .replace(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)+\/?|[A-Za-z0-9]+\/|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, " ")
    .replace(/—\s*AFM controller[^\n]*/g, " ");
}

/** The text's language, or undefined when it has too few letters to tell. Scripts first (Hangul, kana, Han; a
 *  Hangul syllable or CJK character counts as 2.5 letters), then function words among the Latin-script ones. */
export function languageOf(t: string): Lang | undefined {
  const p = prose(t);
  const hangul = (p.match(/[가-힣]/g) ?? []).length * 2.5;
  const kana = (p.match(/[\u3040-\u30ff]/g) ?? []).length * 2.5;
  const han = (p.match(/[\u4e00-\u9fff]/g) ?? []).length * 2.5;
  const latin = (p.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  const total = hangul + kana + han + latin;
  if (total < 8) return undefined;
  if (hangul / total >= 0.4) return "ko";
  if ((kana + han) / total >= 0.4) return kana > 0 ? "ja" : "zh";
  const lower = p.toLowerCase();
  // the English pronoun "I" counts only as a capital (Italian "i" is lowercase)
  let best: Lang = "en", score = (lower.match(STOP.en) ?? []).length + (p.match(/\bI\b/g) ?? []).length;
  for (const l of ["es", "fr", "de", "pt", "it"] as const) {
    const n = (lower.match(STOP[l]) ?? []).length;
    if (n > score) { best = l; score = n; }
  }
  return best;
}

/** The language to reply in. */
export function requestLanguage(prompt: string): Lang {
  return languageOf(prompt) ?? (/[가-힣]/.test(prompt) ? "ko" : /[\u3040-\u30ff]/.test(prompt) ? "ja" : /[\u4e00-\u9fff]/.test(prompt) ? "zh" : "en");
}

/** on (default since the P1 eval, 2026-11-06: reply-language family green, no regression): the contract applies.
 *  shadow: mismatches are logged, nothing changes. off: the earlier rule only. */
export function contractMode(): "off" | "shadow" | "on" {
  const m = process.env.ONBUD_LANG_CONTRACT;
  return m === "off" || m === "shadow" ? m : "on";
}

// Parts a translation must keep exactly: code blocks, inline code, links, URLs, paths, numbers with units,
// Latin-script names (capitalised words and acronyms) when translating into Korean.
// markdown table rows are kept whole (a translated table loses its column structure: seen in framework-eval J2)
const KEEP = /^\|.*\|[ \t]*$|```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)|(?:file|https?):\/\/\S+|[\w.~@+%-]*\/[\w.~@+%\/-]*|\S+\.(?:pdf|docx?|pptx?|xlsx|csv|md|txt|tex|py|ts|js|json|ya?ml)\b|\d[\d,.:/%-]*/gm;
// capitalised words, CamelCase and acronyms (Jordan, OnBud, GitHub, PDFs) and hyphenated names (Lee-Moreno)
const NAMES = /\b[A-Z][A-Za-z0-9]*(?:[-'’][A-Za-z0-9]+)*\b/g;
const SENTENCE_START = /^(The|This|That|These|Those|It|In|On|At|For|And|But|If|When|There|Yes|No|A|An)$/;

export function mask(t: string, to: Lang): { masked: string; parts: string[]; names: Set<number> } {
  const parts: string[] = [];
  const names = new Set<number>();   // indexes of name parts (the others are code, paths, numbers, table rows)
  let masked = t.replace(KEEP, (m) => { parts.push(m); return `⟦${parts.length - 1}⟧`; });
  if (to === "ko" || to === "ja" || to === "zh") masked = masked.replace(NAMES, (m) => { if (SENTENCE_START.test(m) || m.length < 2) return m; parts.push(m); names.add(parts.length - 1); return `⟦${parts.length - 1}⟧`; });
  return { masked, parts, names };
}
/** The text with every ⟦n⟧ put back, or undefined if a masked part is really lost. A token may be missing when the
 *  model wrote that part out itself; a repeated token is put back each time. Code, paths, numbers and table rows
 *  must all survive; of names, a fifth may go when there are five or more (AFM drops the odd "Macs" in a long
 *  summary), none when there are fewer (a lost name in a short answer is the answer: "Jordan Lee-Moreno"). */
export function unmask(t: string, parts: string[], names: Set<number> = new Set()): string | undefined {
  if ([...t.matchAll(/⟦(\d+)⟧/g)].some((m) => Number(m[1]) >= parts.length)) return undefined;
  const out = t.replace(/⟦(\d+)⟧/g, (_m, n) => parts[Number(n)] ?? "");
  const lost = parts.map((p, i) => i).filter((i) => !t.includes(`⟦${i}⟧`) && !out.includes(parts[i]));
  if (lost.some((i) => !names.has(i))) return undefined;
  if (lost.length && (names.size < 5 || lost.length > Math.floor(names.size / 5))) return undefined;
  return out;
}

/** The reply in `want`, or undefined when it already is, cannot be told, is too long, or the translation lost a
 *  masked part. The footer line ("— AFM controller · …") is kept as it is. */
export async function fitLanguage(afm: AFMProvider, answer: string, want: Lang, timeoutMs = 30_000): Promise<{ text?: string; why: string }> {
  const got = languageOf(answer);
  if (!got || got === want) return { why: got ? "same" : "undetermined" };
  const foot = /\n+—\s*AFM controller[^\n]*$/.exec(answer);
  const body = foot ? answer.slice(0, foot.index) : answer;
  if (body.length > 2500) return { why: "too_long" };
  const { masked, parts, names } = mask(body, want);
  const r = await afm.generate({
    system: `Translate the text into natural ${LANG_NAME[want]}. Tokens like ⟦3⟧ stand for code, paths, numbers or names: keep each one exactly once, attached to the same words. Keep markdown (lists, bold, tables) as it is.`,
    user: masked,
    schema: { type: "object", properties: { text: { type: "string", description: "The translation, with every ⟦n⟧ token kept" } }, required: ["text"], additionalProperties: false },
    maxTokens: 1200, timeoutMs,
  });
  if (!r.ok) return { why: `failed:${r.failure}` };
  const out = unmask(String((r.json as any).text ?? ""), parts, names);
  if (!out) return { why: "lost_parts" };
  // a reply that is mostly names and paths may have too few words left to tell: accept it unless it is still
  // recognisably the other language
  const after = languageOf(out);
  if (after && after !== want) return { why: "still_other_language" };
  return { text: out + (foot ? foot[0] : ""), why: "translated" };
}
