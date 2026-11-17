// The undo skill (2026-11-17): "되돌려줘", "undo", the launcher's Undo button ("undo <record>"). Reverses the newest
// OnBud change, or the record named, through undo.ts: exact restore when the files are as OnBud left them, options
// (choices.ts) when they changed since, the opposite command (after approval) for a Mac action.
import { homedir } from "node:os";
import type { Choice } from "./choices.ts";
import { entries, getEntry, recordDir, undo, type UndoEntry } from "./undo.ts";

export const UNDO_REQUEST = /(되돌려|되돌리기|되돌릴래|원래대로\s?(돌려|해|되돌)|실행\s?취소|\bundo\b|\brevert (that|it|this|the last|last|the change|what you did)\b|\broll ?back\b|\bput it back\b)/i;
const NOT_UNDO = /(\bgit\b|커밋|\bcommits?\b|브랜치|\bbranch|\bpush|\bmerge\b|\brebase\b|어떻게|방법|how (do|to|can)|\bctrl\b|⌘|cmd\s?\+?\s?z|단축키|shortcut)/i;
export const undoIntent = (p: string) => UNDO_REQUEST.test(p) && !NOT_UNDO.test(p) && p.length <= 160;

const T = (ko: boolean, k: string, e: string) => (ko ? k : e);
const tilde = (p: string) => { const h = homedir(); return p.startsWith(h + "/") ? "~/" + p.slice(h.length + 1) : p; };

export function undoSkill(prompt: string, ko: boolean): { answer: string; verified: boolean; detail: string; pendingCommand?: string; choices?: Choice[] } {
  const id = /\b(\d{14}-[a-z0-9]{4})\b/.exec(prompt)?.[1];
  const mode = /\bforce\b/.test(prompt) ? "force" : /\bcopy\b/.test(prompt) ? "copy" : "check";
  const e: UndoEntry | undefined = id ? getEntry(id) : entries()[0];
  // the button and the options send "undo <record>": answer in the language of the change being undone
  if (id && e && /^undo\b/i.test(prompt.trim())) ko = /[가-힣]/.test(e.request);
  if (!e) return { verified: true, detail: "nothing", answer: id ? T(ko, `기록 \`${id}\`을(를) 찾지 못했어요 (기록은 14일 동안 보관돼요).`, `No record \`${id}\` (records are kept for 14 days).`)
    : T(ko, "되돌릴 OnBud 변경이 없어요 (최근 14일). OnBud이 만든 파일, 적용한 편집, 바꾼 설정만 되돌릴 수 있어요.", "There is no OnBud change to undo (last 14 days). Undo covers files OnBud made, edits it applied and settings it changed.") };
  if (e.undone) return { verified: true, detail: "already", answer: T(ko, "이 변경은 이미 되돌렸어요.", "That change was already undone.") };
  const what = `"${e.request.slice(0, 60)}${e.request.length > 60 ? "…" : ""}"`;
  if (e.kind === "command") {
    if (!e.inverse) return { verified: false, detail: "no_inverse", answer: T(ko, "이 동작은 되돌리는 방법이 기록돼 있지 않아요.", "This action has no recorded opposite.") };
    return { verified: true, detail: "command", pendingCommand: e.inverse.command,
      answer: T(ko, `${what} 동작을 되돌릴까요? (${e.inverse.label})`, `Undo ${what}? (${e.inverse.label})`) };
  }
  const r = undo(e.id, mode);
  if (r.already) return { verified: true, detail: "already", answer: T(ko, "이 변경은 이미 되돌렸어요.", "That change was already undone.") };
  if (mode === "copy") return { verified: true, detail: `copy ${r.copies.length}`, answer: T(ko, "이전 버전을 별도 파일로 꺼냈어요 (지금 파일은 그대로예요):", "Took the earlier versions out as separate files (the current files are unchanged):") + "\n\n" + r.copies.map((p) => `- \`${tilde(p)}\``).join("\n") };
  if (!r.ok) {
    const lines = r.conflicts.map((x) => `- \`${tilde(x.path)}\` — ${x.why === "changed" ? T(ko, "OnBud이 바꾼 뒤 다시 수정됐어요", "changed again after OnBud's change") : T(ko, "파일이 없어졌어요", "the file is gone")}`);
    const choices: Choice[] = [
      { label: T(ko, "그래도 되돌리기 (지금 내용은 기록에 보관)", "Undo anyway (the current content is kept in the record)"), prompt: `undo ${e.id} force` },
      ...(e.kind === "edit" ? [{ label: T(ko, "이전 버전을 별도 파일로 꺼내기", "Take the earlier version out as a separate file"), prompt: `undo ${e.id} copy` }] : []),
      { label: T(ko, "그대로 두기", "Leave it as it is"), answer: T(ko, "그대로 뒀어요. 아무것도 바꾸지 않았어요.", "Left as it is; nothing was changed.") },
    ];
    return { verified: false, detail: `conflict ${r.conflicts.length}`, choices,
      answer: T(ko, `${what} 변경을 바로 되돌리지 않았어요. 그 뒤에 바뀐 파일이 있어서, 되돌리면 그 수정이 사라져요. 아무것도 바꾸지 않았어요.`, `I did not undo ${what} yet: files changed after it, and undoing would drop those changes. Nothing was changed.`) + "\n\n" + lines.join("\n") };
  }
  const L = [
    ...r.restored.map((p) => `- ${T(ko, "원래 내용으로 복원", "restored")}: \`${tilde(p)}\``),
    ...r.moved.map((p) => `- ${T(ko, "OnBud이 만든 파일 치움", "removed (made by OnBud)")}: \`${tilde(p)}\``),
  ];
  return { verified: true, detail: `undone ${r.restored.length}+${r.moved.length}`,
    answer: T(ko, `${what} 변경을 되돌렸어요:`, `Undid ${what}:`) + "\n\n" + L.join("\n")
      + "\n\n" + T(ko, `_치운 파일과 되돌리기 직전 내용은 \`${tilde(recordDir(e.id))}\`에 보관돼 있어요 (14일)._`, `_Removed files and the content before the undo are kept in \`${tilde(recordDir(e.id))}\` (14 days)._`) };
}
