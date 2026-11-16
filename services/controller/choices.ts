// Choices (2026-11-16): when a skill cannot decide for the user (two files with the same name, a page phrase that fits
// several PDFs, several LaTeX documents, similar shortcut names), it returns the options instead of guessing. The
// agent server keeps them (pending kind "choice", 30 minutes) and lists them under the answer; the launcher shows
// them as buttons. The reply picks one by number ("2", "2번", "두 번째") or by its label, and the request runs again
// as that option's `prompt` (the original request made exact), or that option's `answer` is shown as is.
// The options are made by code from what is really there (files, pages, names); AFM never invents them.

export interface Choice {
  label: string;      // the button text and what a typed reply is matched against
  prompt?: string;    // the request run when it is picked (in the same folder)
  answer?: string;    // or a ready answer shown when it is picked
}

const ORD_KO: Record<string, number> = { 첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8 };
const ORD_EN: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5 };
const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[`'"“”‘’]/g, "").replace(/\s+/g, " ").trim();

/** The option a reply picks, or undefined when it picks none (then the reply is a new request). */
export function matchChoice(reply: string, choices: Choice[]): Choice | undefined {
  const r = norm(reply).replace(/[.!?]+$/, "");
  if (!r) return undefined;
  const n = /^(?:#|no\.?\s*)?(\d{1,2})\s*(?:번|번째|번 거|번으로|번이요|번요)?(?:\s*(?:으로|로)?\s*(?:해\s?줘|할게|해|요|please))?$/.exec(r)?.[1]
    ?? (() => { const k = /^(첫|두|세|네|다섯|여섯|일곱|여덟)\s?번째(?:\s?(?:거|것|파일|항목|걸로|으로|로))?/.exec(r)?.[1]; return k ? String(ORD_KO[k]) : undefined; })()
    ?? (() => { const k = /^(?:the\s+)?(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th)(?:\s+(?:one|option|file|choice))?$/.exec(r)?.[1]; return k ? String(ORD_EN[k]) : undefined; })();
  if (n) return choices[Number(n) - 1];
  const exact = choices.filter((c) => norm(c.label) === r);
  if (exact.length === 1) return exact[0];
  if (r.length >= 2) {
    const part = choices.filter((c) => norm(c.label).includes(r) || (r.length >= norm(c.label).length && r.includes(norm(c.label))));
    if (part.length === 1) return part[0];
  }
  return undefined;
}

/** The options as text under the answer, for clients without buttons. */
export function choicesText(choices: Choice[], ko: boolean): string {
  return "\n\n" + choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n")
    + (ko ? "\n\n_번호나 이름으로 답해 주세요 (예: `1`). 다른 요청을 보내면 이 선택은 취소돼요._" : "\n\n_Reply with a number or a name (e.g. `1`). Sending another request cancels this._");
}
