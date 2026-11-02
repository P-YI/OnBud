// Maps an OpenCode tool call (tool name + args) onto the command/path gate.

import { gateCommand, gatePath, type GateResult } from "./gate.ts";

const WRITE_TOOLS = new Set(["edit", "write", "multiedit"]);
const READ_TOOLS = new Set(["read", "list", "glob", "grep"]);
const PATCH_TOOLS = new Set(["patch", "apply_patch"]);

export function patchPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1].trim());
  for (const m of text.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) if (m[1] !== "/dev/null") out.push(m[1]);
  return out;
}

function merge(results: GateResult[]): GateResult {
  const order = { allow: 0, ask: 1, deny: 2 } as const;
  return results.reduce<GateResult>(
    (acc, r) => ({ verdict: order[r.verdict] > order[acc.verdict] ? r.verdict : acc.verdict, reasons: [...acc.reasons, ...r.reasons] }),
    { verdict: "allow", reasons: [] },
  );
}

export function evaluateTool(tool: string, args: any, root: string): GateResult {
  if (tool === "bash") return gateCommand(String(args?.command ?? ""), root);
  const p = args?.filePath ?? args?.path ?? args?.file_path;
  if (WRITE_TOOLS.has(tool)) return p ? gatePath(String(p), root, "write") : { verdict: "deny", reasons: ["missing_path"] };
  if (READ_TOOLS.has(tool)) return p ? gatePath(String(p), root, "read") : { verdict: "allow", reasons: [] };
  if (PATCH_TOOLS.has(tool)) {
    const paths = patchPaths(String(args?.patchText ?? args?.patch ?? args?.input ?? ""));
    if (!paths.length) return { verdict: "deny", reasons: ["unparsed_patch"] };
    return merge(paths.map((x) => gatePath(x, root, "write")));
  }
  return { verdict: "allow", reasons: [] };
}
