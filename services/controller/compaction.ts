import { readdirSync } from "node:fs";

// OpenCode 2.x session compaction, answered without a model.
// When a session grows past the model's declared limit, OpenCode sends the conversation plus a
// "summarize into this template" request (## Objective, ## Requirements, … ## Important Context) and
// rejects the reply unless at least one line is exactly one of those headings. AFM cannot summarise a
// long conversation inside its 8k window, and the controller would treat the request as a question, so
// the server builds the checkpoint deterministically from the turns instead: instant, no model call,
// nothing leaves the Mac.

export const TEMPLATE_HEADINGS = ["## Objective", "## Requirements", "## Decisions", "## Work State", "## Next Move", "## Relevant Files", "## Important Context"];

export function isCompactionRequest(text: string): boolean {
  return /You MUST summarize the conversation above into a structured summary|Update the existing checkpoint in the conversation above|did not fill in the required summary template/.test(text)
    || (/<template>/.test(text) && /## Objective/.test(text) && /## Important Context/.test(text));
}

export interface Turn { role: "user" | "assistant"; text: string }

// File names: inside **bold** or `code` (may contain spaces), or bare tokens without spaces.
const EXT = "pdf|docx?|pptx?|xlsx?|hwpx?|md|txt|csv|py|ts|js|json|ya?ml|ipynb|key|pages|numbers|tex";
const FILE_REF = new RegExp(`\\*\\*([^*\\n]+?\\.(?:${EXT}))\\*\\*|\`([^\`\\n]+?\\.(?:${EXT}))\`|(?:^|[\\s('"])((?:[\\w.~-]+\\/)*[\\w][\\w.\\[\\]-]*\\.(?:${EXT}))(?=$|[\\s'"),:;—])`, "gi");
const one = (s: string, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n) + (s.replace(/\s+/g, " ").trim().length > n ? "…" : "");
const stripMeta = (s: string) => s.replace(/\n*— (AFM controller|codex-handoff)[^\n]*$/m, "").replace(/<details>[\s\S]*?<\/details>/g, "").trim();

/** Bullets kept from an earlier checkpoint's section, so repeated compactions do not lose facts. */
function previousSection(text: string, heading: string): string[] {
  const m = new RegExp(`${heading.replace(/[#]/g, "\\#")}\\n([\\s\\S]*?)(?=\\n## |\\n</|$)`).exec(text);
  return m ? m[1].split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ") && !/\(none\)|\(없음\)/.test(l)).slice(0, 8) : [];
}

export function buildCheckpoint(turns: Turn[], opts: { root?: string; previous?: string; ko?: boolean } = {}): string {
  const ko = opts.ko ?? turns.some((t) => t.role === "user" && /[가-힣]/.test(t.text));
  const none = "(none)";
  const users = turns.filter((t) => t.role === "user" && !isCompactionRequest(t.text) && t.text.trim());
  const last = users.at(-1);
  // A user turn is answered if an assistant turn follows it.
  const answered = users.filter((u) => { const i = turns.indexOf(u); return turns.slice(i + 1).some((t) => t.role === "assistant" && t.text.trim()); });
  const open = users.filter((u) => !answered.includes(u));
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant" && t.text.trim());
  const pending = lastAssistant && /(\(`예` \/ `아니요`\)|\(`yes` \/ `no`\)|번호로 답해|reply with a number)/.test(lastAssistant.text);
  const files = new Set<string>();
  for (const t of turns) for (const m of t.text.matchAll(FILE_REF)) { const f = (m[1] ?? m[2] ?? m[3]).trim(); if (f.length > 4) files.add(f); }
  // Names with spaces written plainly: take the real file names of the working folder that appear verbatim.
  if (opts.root) {
    let names: string[] = [];
    try { names = readdirSync(opts.root).filter((n) => !n.startsWith(".")); } catch { /* folder not readable */ }
    const all = turns.map((t) => t.text.normalize("NFC")).join("\n");
    for (const n of names) if (n.length > 4 && all.includes(n.normalize("NFC"))) files.add(n.normalize("NFC"));
    for (const f of [...files]) if ([...files].some((g) => g !== f && g.endsWith(f) && /[\s'_-]$/.test(g.slice(0, g.length - f.length)))) files.delete(f);   // drop "Thesis.pptx" when "Master's Thesis.pptx" is listed
  }
  const prev = opts.previous ?? "";

  const lines: string[] = [];
  lines.push("## Objective", `- ${last ? one(last.text, 200) : none}`);
  if (users.length > 1 && users[0] !== last) lines.push(`- ${ko ? "처음 요청" : "Started with"}: ${one(users[0].text, 140)}`);
  lines.push("## Requirements", ...(previousSection(prev, "## Requirements").length ? previousSection(prev, "## Requirements") : [`- ${ko ? "한국어로 답하기" : "Answer in the user's language"}`]));
  if (opts.root) lines.push(`- ${ko ? "작업 폴더" : "Working folder"}: \`${opts.root}\``);
  lines.push("## Decisions", ...(previousSection(prev, "## Decisions").length ? previousSection(prev, "## Decisions") : [`- ${none}`]));
  lines.push("## Work State", "### Completed", ...(answered.length ? answered.slice(-6).map((u) => `- ${one(u.text, 140)}`) : [`- ${none}`]));
  lines.push("### Active", ...(open.length ? open.map((u) => `- ${one(u.text, 140)}`) : pending ? [`- ${ko ? "사용자 확인 대기" : "Waiting for the user's confirmation"}: ${one(stripMeta(lastAssistant!.text).split("\n").filter(Boolean).at(-1) ?? "", 140)}`] : [`- ${none}`]));
  lines.push("### Blocked", `- ${none}`);
  lines.push("## Next Move", open.length ? `1. ${ko ? "답하기" : "Answer"}: ${one(open.at(-1)!.text, 140)}` : `1. ${ko ? "다음 사용자 요청에 답하기" : "Answer the next user request"}`);
  lines.push("## Relevant Files", ...(files.size ? [...files].slice(0, 15).map((f) => `- \`${f}\`: ${ko ? "대화에서 언급됨" : "mentioned in the conversation"}`) : [`- ${none}`]));
  const facts = [
    ...previousSection(prev, "## Important Context"),
    ...turns.filter((t) => t.role === "assistant" && t.text.trim()).slice(-3).map((t) => `- ${ko ? "이전 답" : "Earlier answer"}: ${one(stripMeta(t.text), 400)}`),
  ];
  lines.push("## Important Context", ...(facts.length ? [...new Set(facts)].slice(-8) : [`- ${none}`]));
  return lines.join("\n");
}
