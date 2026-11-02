// Deterministic policy gate at the tool-execution boundary. Independent of every model:
// AFM, Laya/Decima, GPT and Claude recommendations never override a "deny" here.
// Errors inside the gate must be treated as "deny" by callers (fail closed).

import { realpathSync, existsSync } from "node:fs";
import { dirname, resolve, sep, basename } from "node:path";

export type Verdict = "allow" | "ask" | "deny";

export interface GateResult {
  verdict: Verdict;
  reasons: string[];   // stable reason codes, safe to log (no raw arguments)
}

const rank: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };
const worst = (a: Verdict, b: Verdict): Verdict => (rank[a] >= rank[b] ? a : b);

// ---------------------------------------------------------------- shell parsing

/** Split a shell line into simple-command segments on ; && || | & and newlines,
 *  honouring quotes. Command substitutions $(...) and `...` are extracted as extra segments. */
export function splitSegments(line: string): { segments: string[]; pipedInto: boolean[] } {
  const segments: string[] = [];
  const pipedInto: boolean[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let nextPiped = false;
  const push = (piped: boolean) => {
    if (cur.trim()) { segments.push(cur.trim()); pipedInto.push(nextPiped); }
    cur = ""; nextPiped = piped;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) { cur += c + line[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += c + line[++i]; continue; }
    if (c === "$" && line[i + 1] === "(") {
      let depth = 1, j = i + 2;
      for (; j < line.length && depth > 0; j++) { if (line[j] === "(") depth++; else if (line[j] === ")") depth--; }
      const inner = splitSegments(line.slice(i + 2, j - 1));
      segments.push(...inner.segments); pipedInto.push(...inner.pipedInto);
      cur += "SUBST"; i = j - 1; continue;
    }
    if (c === "`") {
      const j = line.indexOf("`", i + 1);
      const end = j === -1 ? line.length : j;
      const inner = splitSegments(line.slice(i + 1, end));
      segments.push(...inner.segments); pipedInto.push(...inner.pipedInto);
      cur += "SUBST"; i = end; continue;
    }
    if (c === "\n" || c === ";") { push(false); continue; }
    if (c === "&" && line[i + 1] === "&") { push(false); i++; continue; }
    if (c === "|" && line[i + 1] === "|") { push(false); i++; continue; }
    if (c === "|") { push(true); continue; }
    if (c === "&") { push(false); continue; }
    cur += c;
  }
  push(false);
  return { segments, pipedInto };
}

/** Minimal POSIX-ish word splitting with quote removal. */
export function argv(segment: string): string[] {
  const out: string[] = [];
  let cur = "", has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < segment.length) { cur += segment[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

// Drop leading env assignments and transparent wrappers so `FOO=1 sudo env nice rm -rf x` is seen as rm.
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "command", "builtin", "exec", "xargs", "timeout"]);
function unwrap(args: string[]): { args: string[]; elevated: boolean } {
  let elevated = false;
  let a = [...args];
  for (;;) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
    if (!a.length) break;
    const head = basename(a[0]);
    if (!WRAPPERS.has(head)) break;
    if (head === "sudo" || head === "doas") elevated = true;
    a.shift();
    if (head === "timeout" && a.length) a.shift();             // duration
    while (a.length && a[0].startsWith("-")) a.shift();         // wrapper flags
  }
  if (a.length) a[0] = basename(a[0]);
  return { args: a, elevated };
}

/** Collect short and long flags: "-rf" -> r,f ; "--force" -> force */
function flags(args: string[]): Set<string> {
  const s = new Set<string>();
  for (const x of args.slice(1)) {
    if (x === "--") break;
    if (x.startsWith("--")) s.add(x.slice(2).split("=")[0]);
    else if (x.startsWith("-") && x.length > 1) for (const ch of x.slice(1)) s.add(ch);
  }
  return s;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "bun", "deno", "osascript"]);
const SAFE_READONLY = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "find", "echo", "which", "file", "stat", "du", "df", "tree", "diff", "sort", "uniq", "date", "whoami", "uname", "true", "false", "test", "["]);

function checkSegment(segment: string, pipedInto: boolean, root: string, depth: number): GateResult {
  const reasons: string[] = [];
  let verdict: Verdict = "allow";
  const add = (v: Verdict, r: string) => { verdict = worst(verdict, v); reasons.push(r); };

  const raw = argv(segment);
  const { args, elevated } = unwrap(raw);
  if (elevated) add("deny", "privilege_escalation");
  if (!args.length) {
    if (raw.some((x) => basename(x) === "env")) add("ask", "env_dump");   // bare `env` prints every variable
    return { verdict, reasons };
  }
  const [cmd, ...rest] = args;
  const f = flags(args);

  // Re-check nested shell code: bash -c "...", eval "..."
  if ((SHELLS.has(cmd) && f.has("c")) || cmd === "eval") {
    const code = cmd === "eval" ? rest.join(" ") : rest[rest.indexOf("-c") + 1] ?? rest.find((x) => !x.startsWith("-")) ?? "";
    if (depth > 3) add("deny", "nesting_too_deep");
    else { const inner = gateCommand(code, root, depth + 1); verdict = worst(verdict, inner.verdict); reasons.push(...inner.reasons.map((r) => `nested:${r}`)); }
    add("ask", "nested_shell");
  }
  if (pipedInto && (SHELLS.has(cmd) || INTERPRETERS.has(cmd))) add("deny", "pipe_to_interpreter");
  if (cmd === "base64" && (f.has("d") || f.has("decode"))) add("ask", "encoded_payload");

  switch (cmd) {
    case "rm": {
      const recursive = f.has("r") || f.has("R") || f.has("recursive");
      const targets = rest.filter((x) => !x.startsWith("-"));
      if (recursive) add("deny", "recursive_delete");
      else add("ask", "delete");
      if (targets.some((t) => outsideRoot(t, root))) add("deny", "delete_outside_root");
      break;
    }
    case "rmdir": case "unlink": case "shred": add("ask", "delete"); break;
    case "mv": case "cp": case "ln": case "rsync":
      if (f.has("delete")) add("deny", "rsync_delete");
      if (rest.filter((x) => !x.startsWith("-")).some((t) => outsideRoot(t, root))) add("deny", "write_outside_root");
      else add("ask", `file_${cmd}`);
      break;
    case "find":
      // find uses single-dash long options, so check the raw words rather than parsed flags.
      if (rest.some((x) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(x))) add("deny", "find_exec_or_delete");
      break;
    case "git": {
      const sub = rest.find((x) => !x.startsWith("-")) ?? "";
      if (sub === "reset" && f.has("hard")) add("deny", "git_reset_hard");
      else if (sub === "clean" && (f.has("f") || f.has("force"))) add("deny", "git_clean_force");
      else if (sub === "push" && (f.has("f") || f.has("force") || f.has("force-with-lease") || f.has("mirror") || f.has("delete") || rest.some((x) => x.startsWith("+")))) add("deny", "git_force_push");
      else if ((sub === "checkout" || sub === "switch") && (f.has("f") || f.has("force") || rest.includes("--") || rest.includes("."))) add("deny", "git_forced_checkout");
      else if (sub === "restore") add("ask", "git_restore");
      else if (sub === "branch" && f.has("D")) add("ask", "git_branch_force_delete");
      else if (sub === "stash" && (rest.includes("drop") || rest.includes("clear"))) add("ask", "git_stash_drop");
      else if (sub === "filter-branch" || sub === "filter-repo" || (sub === "reflog" && rest.includes("expire")) || sub === "gc") add("deny", "git_history_rewrite");
      else if (["push", "commit", "merge", "rebase", "cherry-pick", "revert", "tag", "am", "pull", "fetch", "clone", "remote", "config", "worktree", "submodule"].includes(sub)) add("ask", `git_${sub}`);
      break;
    }
    case "chmod": case "chown": case "chgrp":
      if (f.has("R")) add("deny", "recursive_permission_change"); else add("ask", "permission_change");
      break;
    case "dd": case "mkfs": case "fdisk": case "diskutil": case "newfs_apfs": case "shutdown": case "reboot": case "halt": case "launchctl": case "csrutil": case "spctl": case "systemsetup": case "defaults":
      add("deny", `system_${cmd}`); break;
    case "curl": case "wget": case "scp": case "sftp": case "ssh": case "nc": case "ncat": case "socat": case "telnet": case "ftp":
      add("ask", "network");
      if ((cmd === "nc" || cmd === "ncat") && f.has("l")) add("deny", "network_listener");
      if (cmd === "curl" && (f.has("T") || f.has("upload-file") || f.has("d") || f.has("data") || f.has("F") || f.has("form"))) add("ask", "network_upload");
      break;
    case "brew": case "pip": case "pip3": case "npm": case "pnpm": case "yarn": case "gem": case "cargo": case "uv": case "pipx": case "port": case "go": case "softwareupdate": case "installer": {
      const sub = rest.find((x) => !x.startsWith("-")) ?? "";
      if (/^(install|add|i|upgrade|update|uninstall|remove|rm|services|tap|link|exec|dlx|x|run|tool|publish)$/.test(sub) || cmd === "installer" || cmd === "softwareupdate") add("ask", "package_manager");
      break;
    }
    case "npx": case "bunx": case "pnpx": add("ask", "remote_package_exec"); break;
    case "psql": case "mysql": case "sqlite3": case "mongo": case "mongosh": case "redis-cli":
      if (/\b(drop|truncate)\b/i.test(segment) || /\bflushall\b/i.test(segment)) add("deny", "database_drop"); else add("ask", "database_client");
      break;
    case "security": add("deny", "keychain_access"); break;
    case "printenv": add("ask", "env_dump"); break;
    case "kill": case "killall": case "pkill": add("ask", "process_kill"); break;
    default:
      // http.server binds 0.0.0.0 (whole LAN) unless told otherwise; loopback-only is a normal dev task → ask.
      if (INTERPRETERS.has(cmd) && (f.has("m") && rest.includes("http.server"))) {
        add(/(^|\s)(-b|--bind)[\s=](127\.0\.0\.1|localhost|::1)(\s|$)/.test(segment) ? "ask" : "deny", /(-b|--bind)[\s=](127\.0\.0\.1|localhost|::1)/.test(segment) ? "network_listener_loopback" : "network_listener");
      }
      else if (INTERPRETERS.has(cmd) && (f.has("c") || f.has("e"))) add("ask", "inline_script");
      else if (SHELLS.has(cmd) && !f.has("c")) add("ask", "script_execution");
      else if (!SAFE_READONLY.has(cmd)) { /* unknown command: defer to OpenCode's own permission prompt */ }
  }

  // Redirection that writes outside the project root, or into secret files.
  for (const m of segment.matchAll(/(?:^|[^<>&0-9])>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
    const target = m[1].replace(/^["']|["']$/g, "");
    if (target === "/dev/null") continue;
    if (outsideRoot(target, root)) add("deny", "redirect_outside_root");
    else add("ask", "redirect_write");
  }
  if (/(\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|auth\.json|\.env\b)/.test(segment)) add("deny", "secret_path");

  return { verdict, reasons };
}

export function gateCommand(command: string, root: string, depth = 0): GateResult {
  const { segments, pipedInto } = splitSegments(command);
  let verdict: Verdict = "allow";
  const reasons: string[] = [];
  segments.forEach((s, i) => {
    const r = checkSegment(s, pipedInto[i], root, depth);
    verdict = worst(verdict, r.verdict);
    reasons.push(...r.reasons);
  });
  if (segments.length > 1 && reasons.length) reasons.push("chained");
  return { verdict, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------- paths

const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials(\.json)?|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx))$/i;
const SECRET_DIR = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|Keychains)(\/|$)/;

/** Resolve symlinks for existing paths (or the nearest existing parent). */
function real(p: string): string {
  let cur = p, suffix = "";
  while (!existsSync(cur) && dirname(cur) !== cur) { suffix = sep + basename(cur) + suffix; cur = dirname(cur); }
  try { return realpathSync(cur) + suffix; } catch { return p; }
}

export function outsideRoot(p: string, root: string): boolean {
  if (!p || p.startsWith("-")) return false;
  const expanded = p.startsWith("~") ? (process.env.HOME ?? "/") + p.slice(1) : p;
  if (/^\$|\$\{/.test(expanded)) return true;                 // unresolved variable: assume the worst
  const abs = real(resolve(root, expanded));
  const r = real(resolve(root));
  return abs !== r && !abs.startsWith(r + sep);
}

export function gatePath(path: string, root: string, mode: "read" | "write"): GateResult {
  const reasons: string[] = [];
  let verdict: Verdict = "allow";
  const abs = real(resolve(root, path));
  if (SECRET_FILE.test(abs) || SECRET_DIR.test(abs)) { verdict = "deny"; reasons.push("secret_path"); }
  if (outsideRoot(path, root)) { verdict = worst(verdict, mode === "write" ? "deny" : "ask"); reasons.push(`${mode}_outside_root`); }
  if (mode === "write" && /(^|\/)\.git(\/|$)/.test(abs)) { verdict = "deny"; reasons.push("write_git_internals"); }
  return { verdict, reasons };
}

// ---------------------------------------------------------------- secrets

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai_key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["huggingface_token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer", /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ["assignment", /\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi],
];

/** Each secret-pattern match in one line: kind and the secret value itself (the part after "=" for assignments). */
export function secretMatches(line: string): { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  for (const [kind, re] of SECRET_PATTERNS) for (const m of line.matchAll(new RegExp(re.source, re.flags))) {
    const value = kind === "assignment" ? m[0].slice(m[1].length + m[2].length).replace(/^["']|["']$/g, "") : kind === "bearer" ? m[0].replace(/^Bearer\s+/i, "") : m[0];
    if (!out.some((o) => o.value.includes(value) || value.includes(o.value))) out.push({ kind, value });
  }
  return out;
}

export function redact(text: string): { text: string; found: string[] } {
  const found: string[] = [];
  let out = text;
  for (const [name, re] of SECRET_PATTERNS) {
    out = out.replace(re, (...m: string[]) => {
      found.push(name);
      if (name === "assignment") return `${m[1]}${m[2]}${m[3]}[REDACTED:${name}]${m[3]}`;
      if (name === "bearer") return `${m[1]} [REDACTED:${name}]`;
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, found: [...new Set(found)] };
}

const SECRET_ENV = /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE|^AWS_|^GH_|^GITHUB_|^HF_|^OPENAI_|^ANTHROPIC_)/i;
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV.test(name);
}
