// Document questions in three general steps (2026-11-01), instead of one rule per phrasing:
//   1. frame   AFM fills a small schema: what kind of thing is asked for (a fixed list of answer types) and the
//              words to look for, with English equivalents ("어느 학회 논문이야?" → venue; conference, accepted, …).
//   2. lines   code searches the whole document for those words and puts the best lines in front of the model,
//              so the answer does not depend on where the fact sits or on the request's wording.
//   3. check   code checks the answer against the asked-for type (an amount needs a number; a venue, person or date
//              must not just repeat the document's title) and asks once more with the reason if it fails.
// Nothing here is specific to one question: the list of answer types is the only fixed part.
import type { AFMProvider } from "../afm-adapter/provider.ts";

export const ANSWER_TYPES = ["person", "organization", "venue_or_place", "date_or_time", "amount_or_number", "count", "title_or_name", "reason", "method_or_steps", "summary", "yes_no", "other"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
export interface Frame { restated: string; asked_for: AnswerType; search_words: string[] }

const DESCRIBE: Record<AnswerType, string> = {
  person: "a person (who)", organization: "an organization or company", venue_or_place: "a venue or place (where: conference, journal, city, room)",
  date_or_time: "a date or time (when)", amount_or_number: "an amount or number", count: "a count (how many)", title_or_name: "a title or name",
  reason: "a reason (why)", method_or_steps: "a method or steps (how)", summary: "a summary", yes_no: "yes or no, with the reason", other: "the requested fact",
};
export const describeType = (t: AnswerType) => DESCRIBE[t];

export async function frameQuestion(afm: AFMProvider, prompt: string, timeoutMs: number): Promise<Frame | undefined> {
  // Field order matters (guided generation fills fields in order): restating the question in plain English and
  // listing the words near the answer come before the answer type, so the type is chosen after thinking about
  // what the answer looks like (a venue question was typed as a title when the type came first). The examples in the
  // instructions are deliberately unrelated to the benchmark's questions.
  const r = await afm.generate({
    system: "Analyse a question about a document. restated: the question rewritten as one plain English question that names the kind of fact wanted (for example \"이 계약 언제까지야?\" → \"Until what date is this contract valid?\"). search_words: 3 to 8 words or short phrases likely to appear in the document next to the answer, in the document's likely language and in English (for example 기한 → deadline, until, expires, valid through). asked_for: the kind of thing the answer must be. Do not include file names.",
    user: prompt, maxTokens: 200, timeoutMs,
    schema: { type: "object", properties: {
      restated: { type: "string" },
      search_words: { type: "array", items: { type: "string" }, maxItems: 8 },
      asked_for: { type: "string", enum: [...ANSWER_TYPES] },
    }, required: ["restated", "search_words", "asked_for"], additionalProperties: false },
  });
  if (!r.ok) return undefined;
  const j = r.json as Frame;
  return { restated: String(j.restated ?? "").trim(), asked_for: ANSWER_TYPES.includes(j.asked_for) ? j.asked_for : "other",
    search_words: (j.search_words ?? []).map((w) => String(w).trim()).filter((w) => w.length >= 2).slice(0, 8) };
}

const norm = (s: string) => s.normalize("NFC").toLowerCase();
/** Lines of the whole text that contain the search words (more distinct words = better), each with the line
 *  after it, best first then put back in document order; at most `maxChars`. */
export function relevantLines(text: string, words: string[], maxChars = 1500): string {
  const ws = [...new Set(words.map(norm).filter((w) => w.length >= 2))];
  if (!ws.length) return "";
  const lines = text.split("\n").map((l) => l.trim());
  const scored = lines.map((l, i) => ({ i, s: ws.filter((w) => norm(l).includes(w)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  const pick = new Set<number>();
  let n = 0;
  for (const x of scored) {
    for (const i of [x.i, x.i + 1]) if (lines[i] && !pick.has(i)) { pick.add(i); n += lines[i].length + 1; }
    if (n >= maxChars) break;
  }
  return [...pick].sort((a, b) => a - b).map((i) => lines[i]).join("\n").slice(0, maxChars);
}

/** Why an answer does not fit the asked-for type, or undefined when it fits (or the type is not checked).
 *  `title` is the document's first line; an answer that only repeats it answers a different question. */
export function typeMismatch(asked: AnswerType, answer: string, title?: string): string | undefined {
  const a = answer.trim();
  if (!a) return "empty answer";
  if (asked === "amount_or_number" || asked === "count") {
    if (!/\d|(하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네)\s?(개|명|건|장|번|가지)|\b(one|two|three|four|five|six|seven|eight|nine|ten|none|no)\b/i.test(a)) return `the question asks for ${DESCRIBE[asked]}, but the answer has no number`;
  }
  if (asked === "date_or_time" && !/\d|(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday|오늘|내일|어제|월요일|화요일|수요일|목요일|금요일|토요일|일요일)/i.test(a))
    return `the question asks for ${DESCRIBE[asked]}, but the answer has no date`;
  if (title && !["title_or_name", "summary", "other"].includes(asked)) {
    const t = norm(title).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const rest = norm(a).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(t).join(" ").replace(/\s+/g, " ").trim();
    // Only the title, or the title plus a few connecting words: it names the document instead of answering.
    if (t.length >= 12 && norm(a).replace(/[^\p{L}\p{N}]+/gu, " ").includes(t) && rest.split(" ").filter((w) => w.length > 1).length <= 2)
      return `the question asks for ${DESCRIBE[asked]}, but the answer only repeats the document's title`;
  }
  return undefined;
}

// Words that name the document or ask for its name, not the fact looked up.
const GENERIC = /^(paper|papers|document|documents|file|files|title|titles|name|names|this|the|a|an|of|about|article|report|논문|문서|파일|제목|이름|자료|내용)$/i;
const toks = (s: string) => new Set(norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !GENERIC.test(w)));

/** A line of the document that holds a specific word of the question but that the answer does not use at all
 *  (no word of 3+ characters in common). Independent of the answer type, which AFM can misjudge: "어느 학회 논문"
 *  was typed as a title question, yet "conference" was among its search words and on the line with the answer. */
export function ignoredLine(searchWords: string[], lines: string, answer: string): { word: string; line: string } | undefined {
  const ans = toks(answer);
  for (const w of searchWords.map(norm).filter((x) => x.length >= 3 && !GENERIC.test(x))) {
    const line = lines.split("\n").find((l) => norm(l).includes(w));
    if (!line) continue;
    const shared = [...toks(line)].filter((t) => t !== w && ans.has(t));
    if (!shared.length) return { word: w, line: line.slice(0, 200) };
  }
  return undefined;
}

const EN_STOP = /^(what|which|who|whom|whose|where|when|why|how|many|much|does|did|have|has|this|that|these|those|there|their|with|from|into|about|tell|show|give|please|file|files|from|were|was|are|is|the|and|for|you|your|mine|any|all|some|been|being|will|would|could|should|can|pdf|docx|xlsx|pptx|txt)$/i;
/** Content words of an English translation of the question, without question words, generic document words
 *  and the file's own name ("Which conference paper is paper.pdf?" → conference). */
export function translationWords(english: string, fileNames: string[] = []): string[] {
  const own = new Set(fileNames.flatMap((f) => norm(f).split(/[^\p{L}\p{N}]+/u)));
  return [...new Set((english.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []).map(norm))].filter((w) => !EN_STOP.test(w) && !GENERIC.test(w) && !own.has(w)).slice(0, 5);
}
