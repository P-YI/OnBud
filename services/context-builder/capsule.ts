// Task capsule: the only context AFM sees. Sections are packed in priority order under a token budget
// (measured context 8192; default envelope 5500 input tokens leaves room for schema and output).
// Exact paths, line numbers and commands are kept verbatim; observations are truncated, never paraphrased.
// When evidence must be dropped or cut, its critical identifiers (paths, path:line, `code`, error names)
// are kept in a KEY FACTS line, so compaction loses detail but not the pointers needed to re-read it.

export interface Capsule {
  goal: string;
  acceptance?: string;
  constraints?: string[];
  evidence: { label: string; body: string }[];   // tool observations, snippets, diffs (newest last)
  openQuestions?: string[];
}

// Conservative: AFM tokenisation of code averages well under 3 chars/token, so this over-estimates.
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);

const FACT = /(?:[\w.\[\]-]+\/)*[\w.\[\]-]+\.[A-Za-z]{1,5}(?::\d+)?|`[^`\n]{2,60}`|\b[A-Z][A-Za-z]+(?:Error|Exception)\b|\b\d+\| /g;

/** Critical identifiers in a text: file paths (with :line), `code spans`, exception names. */
export function keyFacts(text: string, max = 25): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FACT)) {
    const v = m[0].trim();
    if (/^\d+\|$/.test(v) || v.length < 3 || /^\d+(\.\d+)+$/.test(v)) continue;
    out.add(v);
    if (out.size >= max) break;
  }
  return [...out];
}

export function renderCapsule(c: Capsule, budgetTokens = 5500): { text: string; tokens: number; dropped: number; keptFacts: string[] } {
  const head = [`GOAL: ${c.goal}`];
  if (c.acceptance) head.push(`DONE WHEN: ${c.acceptance}`);
  if (c.constraints?.length) head.push(`CONSTRAINTS:\n${c.constraints.map((x) => `- ${x}`).join("\n")}`);
  const tail = c.openQuestions?.length ? [`OPEN QUESTIONS:\n${c.openQuestions.map((x) => `- ${x}`).join("\n")}`] : [];

  const factsBudget = 120;   // tokens reserved for KEY FACTS if anything gets cut
  let used = estimateTokens(head.join("\n\n") + tail.join("\n\n")) + factsBudget;
  const kept: string[] = [];
  const lost: string[] = [];
  let dropped = 0;
  // Newest evidence matters most for the next step: walk backwards, keep while it fits.
  for (let i = c.evidence.length - 1; i >= 0; i--) {
    const e = c.evidence[i];
    let block = `[${e.label}]\n${e.body}`;
    const room = budgetTokens - used;
    if (estimateTokens(block) > room) {
      if (room < 80) {
        dropped += i + 1;
        for (let j = 0; j <= i; j++) lost.push(`${c.evidence[j].label}\n${c.evidence[j].body}`);
        break;
      }
      const cut = room * 3 - 40;
      lost.push(block.slice(cut));
      block = block.slice(0, cut) + "\n… (truncated)";
    }
    kept.unshift(block);
    used += estimateTokens(block);
  }
  const keptText = kept.join("\n\n");
  const facts = lost.length ? keyFacts(lost.join("\n")).filter((f) => !keptText.includes(f)) : [];
  const factsLine = facts.length ? [`KEY FACTS FROM TRIMMED EVIDENCE (re-read these if needed): ${facts.join(", ")}`] : [];
  const text = [...head, ...(kept.length ? [`EVIDENCE:\n${keptText}`] : []), ...factsLine, ...tail].join("\n\n");
  return { text, tokens: estimateTokens(text), dropped, keptFacts: facts };
}

/** Fidelity of a capsule against the full evidence: share of critical identifiers still present. */
export function capsuleFidelity(c: Capsule, rendered: string): { total: number; kept: number; ratio: number; missing: string[] } {
  const all = keyFacts(c.evidence.map((e) => `${e.label}\n${e.body}`).join("\n"), 500);
  const missing = all.filter((f) => !rendered.includes(f));
  return { total: all.length, kept: all.length - missing.length, ratio: all.length ? (all.length - missing.length) / all.length : 1, missing };
}
