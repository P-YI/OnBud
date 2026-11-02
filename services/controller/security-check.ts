// Local security check (2026-11-02): code finds every issue and its evidence; no model decides anything, and
// nothing leaves the Mac (no network, no admin rights, nothing written). Asked to review a folder on its own, AFM
// missed a committed key and called three placeholders real leaks; here a finding needs a concrete pattern, a file
// and line, and a value that is not a placeholder, and values are always masked.
//   project  secrets in files (git: committed, not yet committed, or ignored), secret files deleted from git but
//            still in its history
//   home     credential files (~/.ssh, ~/.aws, ~/.netrc, ~/.git-credentials, ~/.npmrc, ~/.pypirc, ~/.docker),
//            their permissions, and tokens typed into shell history (counted, never shown)
//   system   FileVault, firewall, SIP, Gatekeeper, automatic login, guest account, automatic security updates,
//            TCP ports listening beyond this Mac
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { secretMatches } from "../security/gate.ts";

export type Severity = "high" | "medium" | "low" | "ok";
export interface Finding { area: "project" | "home" | "system"; severity: Severity; what: string; ko?: string; where?: string; fix?: string }

const sh = (cmd: string, args: string[], cwd?: string, timeout = 10_000) => new Promise<{ code: number; out: string; err: string }>((res) =>
  execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", HOME: homedir(), LANG: "en_US.UTF-8", GIT_TERMINAL_PROMPT: "0" } },
    (e: any, out, err) => res({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(out ?? ""), err: String(err ?? "") })));

/** First 4 characters and the length; enough to recognise a key without showing it. */
export const maskValue = (v: string) => (v.length <= 6 ? "•".repeat(v.length) : `${v.slice(0, 4)}…(${v.length} chars)`);

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1);
  return [...n.values()].reduce((h, c) => h - (c / s.length) * Math.log2(c / s.length), 0);
}

/** Values that only stand in for a secret: x/* runs, "your-…", example/changeme/dummy, template variables,
 *  or (for a plain "password = …" assignment) too little randomness to be a real secret. */
export function placeholder(kind: string, v: string): boolean {
  if (/(x{5,}|X{5,}|\*{4,}|•{3,}|\.\.\.|your[-_ ]?|example|sample|changeme|change[-_]me|dummy|placeholder|redacted|fake|todo|<[^>]*>|\$\{|\$[A-Z_]{3,}|\{\{|%\(|^(true|false|null|none)$)/i.test(v)) return true;
  if (kind === "assignment") return v.length < 8 || entropy(v) < 3.0 || /^[a-z]+$/i.test(v) || /^(test|password|secret|admin|root|123)/i.test(v);
  return false;
}

const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(pem|key|p12|pfx)|credentials(\.json)?|\.netrc|\.npmrc|\.pypirc|secrets?\.(json|ya?ml|toml))$/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|swift|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|scala|sh|zsh|bash)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|testdata|examples?|mocks?|samples?)\/|\.(test|spec)\.\w+$|(^|\/)test_[^/]*$/i;
const TEXT_SKIP = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|dmg|pkg|mp[34]|mov|woff2?|ttf|otf|sqlite3?|db|bin|o|a|dylib|so|class|jar|pyc|xlsx|docx|pptx|key)$/i;

async function projectFindings(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const git = (await sh("git", ["rev-parse", "--is-inside-work-tree"], root)).out.trim() === "true";
  const list = async (...a: string[]) => (await sh("git", ["-c", "core.quotepath=off", "ls-files", "-z", ...a], root)).out.split("\0").filter(Boolean);
  let files: { path: string; state: "committed" | "untracked" | "ignored" | "plain" }[] = [];
  if (git) {
    files = [...(await list()).map((p) => ({ path: p, state: "committed" as const })), ...(await list("--others", "--exclude-standard")).map((p) => ({ path: p, state: "untracked" as const })),
      ...(await list("--others", "--ignored", "--exclude-standard")).filter((p) => SECRET_FILE.test(p)).map((p) => ({ path: p, state: "ignored" as const }))];
  } else {
    const walk = (rel: string, depth: number) => {
      if (files.length > 3000 || depth > 4) return;
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (/^(\.git|node_modules|\.build|\.venv|venv|__pycache__|dist|build)$/.test(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r, depth + 1); else files.push({ path: r, state: "plain" });
      }
    };
    walk("", 0);
  }
  for (const f of files.slice(0, 5000)) {
    if (TEXT_SKIP.test(f.path) && !SECRET_FILE.test(f.path)) continue;
    let text: string;
    try { const st = statSync(join(root, f.path)); if (!st.isFile() || st.size > 1_000_000) continue; text = readFileSync(join(root, f.path), "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && i < 20_000; i++) {
      // A private key spans lines, so its BEGIN line counts as the match (the gate's pattern needs the END too).
      // A private key spans lines: its BEGIN line counts when key material follows (next line, or after an
      // escaped \n in the same string).
      const pk = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----(?:\\n)?([A-Za-z0-9+/=]{40,})?/.exec(lines[i]);
      const body = pk ? (pk[2] ?? (/^\s*[A-Za-z0-9+/=]{40,}\s*$/.test(lines[i + 1] ?? "") ? lines[i + 1].trim() : "")) : "";
      const found = pk ? (body ? [{ kind: "private_key", value: body }] : []) : secretMatches(lines[i]);
      for (const m of found) {
        if (placeholder(m.kind, m.value)) continue;
        // In source code a "password = …" assignment counts only with a quoted literal value, not an expression.
        if (m.kind === "assignment" && CODE_EXT.test(f.path) && (!["\"", "'", "`"].some((q) => lines[i].includes(`${q}${m.value}${q}`)) || /[()[\]{}]|=>|\\\(|^\w+\.\w|^\//.test(m.value))) continue;
        const test = TEST_PATH.test(f.path);
        const provider = m.kind !== "assignment" && m.kind !== "bearer" && m.kind !== "jwt";
        let severity: Severity = f.state === "committed" ? (provider ? "high" : "medium") : f.state === "ignored" ? "ok" : f.state === "untracked" ? "medium" : provider ? "medium" : "low";
        // Test and example files usually hold fake values on purpose: reported, but as low and labelled.
        if (test && severity !== "ok") severity = "low";
        const stKo = { committed: "git에 커밋됨", untracked: "아직 커밋 안 됨", ignored: ".gitignore로 제외됨", plain: "git 폴더 아님" }[f.state];
        out.push({ area: "project", severity, what: `${m.kind.replace(/_/g, " ")} ${maskValue(m.value)} (${f.state === "plain" ? "not a git folder" : f.state}${test ? ", test file: likely a fake value" : ""})`, ko: `${KIND_KO[m.kind] ?? m.kind} ${maskValue(m.value)} (${stKo}${test ? ", 테스트 파일이라 가짜 값일 가능성이 큼" : ""})`, where: `${f.path}:${i + 1}`,
          fix: f.state === "committed" ? "rotate" : f.state === "untracked" ? "ignore" : f.state === "ignored" ? undefined : "move" });
      }
    }
  }
  if (git) {
    // Secret-like files that were committed and later deleted: still readable in the history.
    const gone = (await sh("git", ["-c", "core.quotepath=off", "log", "--all", "--diff-filter=D", "--name-only", "--format="], root)).out.split("\n").filter((p) => p && SECRET_FILE.test(p));
    for (const p of [...new Set(gone)].slice(0, 20)) if (!existsSync(join(root, p))) out.push({ area: "project", severity: "medium", what: "secret-like file deleted from git, still in its history", ko: "비밀 파일로 보이는 파일이 삭제됐지만 git 기록에 남아 있음", where: p, fix: "history" });
  }
  return out;
}

const KIND_KO: Record<string, string> = { private_key: "개인 키", anthropic_key: "Anthropic 키", openai_key: "OpenAI 키", github_token: "GitHub 토큰", aws_access_key: "AWS 액세스 키", slack_token: "Slack 토큰", google_api_key: "Google API 키", huggingface_token: "Hugging Face 토큰", jwt: "JWT", bearer: "Bearer 토큰", assignment: "비밀번호/키 대입값" };
const mode = (p: string) => { try { return statSync(p).mode & 0o777; } catch { return undefined; } };
const loose = (m?: number) => m !== undefined && (m & 0o077) !== 0;

async function homeFindings(): Promise<Finding[]> {
  const H = homedir(), out: Finding[] = [];
  const at = (p: string) => p.replace(H, "~");
  const sshDir = join(H, ".ssh");
  if (existsSync(sshDir)) {
    for (const n of readdirSync(sshDir)) {
      const p = join(sshDir, n);
      let head = "";
      try { if (statSync(p).isFile() && statSync(p).size < 100_000) head = readFileSync(p, "utf8").slice(0, 400); } catch { continue; }
      if (!/PRIVATE KEY-----/.test(head)) continue;
      if (loose(mode(p))) out.push({ area: "home", severity: "high", what: `SSH private key readable by other users (mode ${mode(p)!.toString(8)})`, ko: `다른 사용자도 읽을 수 있는 SSH 개인 키 (권한 ${mode(p)!.toString(8)})`, where: at(p), fix: "chmod600" });
      const b64 = head.split("\n").slice(1).join("");
      const unencrypted = /ENCRYPTED/.test(head) ? false : /OPENSSH/.test(head) ? Buffer.from(b64, "base64").toString("latin1").includes("none") : true;
      out.push({ area: "home", severity: unencrypted ? "low" : "ok", what: unencrypted ? "SSH private key without a passphrase" : "SSH private key protected by a passphrase", ko: unencrypted ? "암호가 없는 SSH 개인 키" : "암호로 보호된 SSH 개인 키", where: at(p), fix: unencrypted ? "passphrase" : undefined });
    }
  }
  const files: [string, RegExp, string, string][] = [
    [".git-credentials", /:\/\/[^:\s]+:[^@\s]+@/, "plaintext git passwords/tokens", "평문으로 저장된 git 비밀번호/토큰"],
    [".netrc", /\bpassword\s+\S+/, "plaintext passwords", "평문 비밀번호"],
    [".npmrc", /_authToken\s*=\s*\S{8,}/, "npm token", "npm 토큰"],
    [".pypirc", /\bpassword\s*[:=]\s*\S{6,}/, "PyPI password", "PyPI 비밀번호"],
    [".aws/credentials", /aws_secret_access_key\s*=\s*\S{20,}/, "AWS secret key", "AWS 비밀 키"],
    [".docker/config.json", /"auth"\s*:\s*"[A-Za-z0-9+/=]{8,}"/, "Docker registry password (base64, not in Keychain)", "Docker 레지스트리 비밀번호 (Keychain이 아닌 base64)"],
    ["OpenAFM/config/apfel.token", /\S{16,}/, "OpenAFM local API token", "OpenAFM 로컬 API 토큰"],
  ];
  for (const [rel, re, label, labelKo] of files) {
    const p = join(H, rel);
    if (!existsSync(p)) continue;
    let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
    if (!re.test(t)) continue;
    const m = mode(p);
    const fileSev: Severity = rel.startsWith("OpenAFM") ? (loose(m) ? "medium" : "ok") : rel === ".aws/credentials" || rel === ".npmrc" ? (loose(m) ? "medium" : "low") : "medium";
    out.push({ area: "home", severity: fileSev, what: `${label}${loose(m) ? `, readable by other users (mode ${m!.toString(8)})` : ""}`, ko: `${labelKo}${loose(m) ? `, 다른 사용자도 읽을 수 있음 (권한 ${m!.toString(8)})` : ""}`, where: at(p), fix: loose(m) ? "chmod600" : fileSev === "ok" ? undefined : "keychain" });
  }
  for (const hist of [".zsh_history", ".bash_history"]) {
    const p = join(H, hist);
    if (!existsSync(p)) continue;
    let t = ""; try { t = readFileSync(p, "latin1"); } catch { continue; }
    const kinds = new Map<string, number>();
    for (const l of t.split("\n")) for (const m of secretMatches(l)) if (!placeholder(m.kind, m.value)) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
    const n = [...kinds.values()].reduce((a, b) => a + b, 0);
    if (n) out.push({ area: "home", severity: "medium", what: `${n} secret-looking values typed into shell history (${[...kinds].map(([k, c]) => `${k.replace(/_/g, " ")} ${c}`).join(", ")})`, ko: `셸 기록에 비밀값으로 보이는 값 ${n}개 (${[...kinds].map(([k, c]) => `${KIND_KO[k] ?? k} ${c}`).join(", ")})`, where: at(p), fix: "history_shell" });
  }
  return out;
}

async function systemFindings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const [fv, fw, stealth, sip, gk, autologin, guest, su, lsof] = await Promise.all([
    sh("/usr/bin/fdesetup", ["status"]), sh("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]), sh("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getstealthmode"]),
    sh("/usr/bin/csrutil", ["status"]), sh("/usr/sbin/spctl", ["--status"]), sh("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]),
    sh("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "GuestEnabled"]), sh("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate"]),
    sh("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]),
  ]);
  const add = (sev: Severity, what: string, fix?: string, ko?: string) => out.push({ area: "system", severity: sev, what, ko, fix });
  const on = (b: boolean) => (b ? "켜짐" : "꺼짐");
  add(/FileVault is On/.test(fv.out) ? "ok" : /Off/.test(fv.out) ? "high" : "low", `FileVault ${/On/.test(fv.out) ? "on" : /Off/.test(fv.out) ? "off" : "unknown"}`, /Off/.test(fv.out) ? "filevault" : undefined, `FileVault 암호화 ${on(/On/.test(fv.out))}`);
  add(/enabled/.test(fw.out) ? "ok" : "medium", `firewall ${/enabled/.test(fw.out) ? "on" : "off"}${/enabled/.test(stealth.out) ? ", stealth mode on" : ""}`, /enabled/.test(fw.out) ? undefined : "firewall", `방화벽 ${on(/enabled/.test(fw.out))}${/enabled/.test(stealth.out) ? ", 스텔스 모드 켜짐" : ""}`);
  add(/enabled/.test(sip.out) ? "ok" : "high", `System Integrity Protection ${/enabled/.test(sip.out) ? "on" : "off"}`, /enabled/.test(sip.out) ? undefined : "sip", `시스템 무결성 보호 ${on(/enabled/.test(sip.out))}`);
  add(/enabled/.test(gk.out) ? "ok" : "high", `Gatekeeper ${/enabled/.test(gk.out) ? "on" : "off"}`, /enabled/.test(gk.out) ? undefined : "gatekeeper", `Gatekeeper ${on(/enabled/.test(gk.out))}`);
  if (autologin.code === 0 && autologin.out.trim()) add("high", `automatic login enabled for ${autologin.out.trim()}`, "autologin", `자동 로그인 켜짐 (${autologin.out.trim()})`);
  else add("ok", "automatic login off", undefined, "자동 로그인 꺼짐");
  if (guest.code === 0 && guest.out.trim() === "1") add("low", "guest account enabled", "guest", "게스트 계정 켜짐");
  const flag = (k: string) => new RegExp(`${k} = (\\d)`).exec(su.out)?.[1];
  const critical = flag("CriticalUpdateInstall"), config = flag("ConfigDataInstall");
  if (critical === "0" || config === "0") add("medium", "automatic security responses / system data files off", "updates", "자동 보안 대응/시스템 데이터 파일 설치 꺼짐");
  else add("ok", "automatic security updates not turned off", undefined, "자동 보안 업데이트 켜짐 (끄지 않음)");
  // TCP listeners beyond loopback: something on this Mac accepts connections from the network.
  const exposed = new Map<string, Set<string>>();
  for (const l of lsof.out.split("\n").slice(1)) {
    const c = l.trim().split(/\s+/); const addr = c[8] ?? "";
    if (!addr || /^(127\.|\[::1\]|localhost)/.test(addr)) continue;
    const port = addr.split(":").pop()!; (exposed.get(c[0]) ?? exposed.set(c[0], new Set()).get(c[0])!).add(`${addr.startsWith("*") ? "all interfaces" : addr.replace(/:\d+$/, "")}:${port}`);
  }
  // Apple's own services that listen on every Mac by default: shown as normal, with what they are.
  const APPLE: Record<string, [string, string]> = { rapportd: ["Apple Continuity (Handoff, Universal Clipboard)", "Apple 연속성 기능 (Handoff, 공유 클립보드)"], ControlCe: ["AirPlay Receiver (System Settings > General > AirDrop & Handoff)", "AirPlay 수신 (시스템 설정 > 일반 > AirDrop 및 Handoff)"], sharingd: ["AirDrop", "AirDrop"], mDNSRespo: ["Bonjour", "Bonjour"] };
  if (exposed.size) for (const [proc, ports] of exposed) {
    const ps = [...ports].join(", ");
    if (APPLE[proc]) add("ok", `${APPLE[proc][0]} listening on ${ps}`, undefined, `${APPLE[proc][1]}: ${ps.replace(/all interfaces/g, "모든 네트워크")}에서 대기`);
    else add("low", `${proc} accepts network connections on ${ps}`, "listener", `${proc}가 네트워크 연결을 받음 (${ps.replace(/all interfaces/g, "모든 네트워크")})`);
  }
  else add("ok", "no TCP service of yours listening beyond this Mac (loopback only)", undefined, "외부 네트워크에 열린 내 TCP 서비스 없음 (이 Mac 안에서만)");
  return out;
}

const FIX: Record<string, [string, string]> = {
  rotate: ["커밋된 키는 지워도 git 기록에 남아요. 먼저 해당 서비스에서 키를 폐기·재발급하고, 파일에서 지운 뒤 .gitignore에 추가하세요.", "A committed key stays in git history even after deletion: revoke and reissue it first, then remove it and add the file to .gitignore."],
  ignore: ["아직 커밋되지 않았어요. 커밋 전에 .gitignore에 추가하거나 환경 변수/Keychain으로 옮기세요.", "Not committed yet: add the file to .gitignore or move the value to an environment variable or the Keychain before committing."],
  move: ["환경 변수나 Keychain으로 옮기는 것을 권해요.", "Consider moving it to an environment variable or the Keychain."],
  history: ["git 기록에서 지우려면 git filter-repo 등이 필요해요. 이미 공유된 저장소라면 키를 폐기하는 것이 우선이에요.", "Removing it from history needs git filter-repo or similar; if the repository was shared, revoke the key first."],
  chmod600: ["`chmod 600 <파일>`로 본인만 읽게 하세요.", "Run `chmod 600 <file>` so only you can read it."],
  passphrase: ["`ssh-keygen -p -f <키>`로 암호를 걸 수 있어요 (FileVault가 켜져 있으면 위험은 낮아요).", "`ssh-keygen -p -f <key>` adds a passphrase (lower risk while FileVault is on)."],
  keychain: ["가능하면 Keychain 기반 저장(git credential-osxkeychain, docker credsStore 등)으로 바꾸세요.", "Where possible, switch to Keychain-backed storage (git credential-osxkeychain, Docker credsStore)."],
  history_shell: ["명령줄에 직접 입력한 토큰은 기록에 남아요. 해당 줄을 지우고, 앞으로는 환경 변수 파일이나 Keychain을 쓰세요 (값이 진짜라면 폐기·재발급).", "Tokens typed on the command line stay in history: delete those lines, use env files or the Keychain instead, and reissue the token if it was real."],
  filevault: ["시스템 설정 > 개인정보 보호 및 보안 > FileVault에서 켜세요.", "Turn it on in System Settings > Privacy & Security > FileVault."],
  firewall: ["시스템 설정 > 네트워크 > 방화벽에서 켜세요.", "Turn it on in System Settings > Network > Firewall."],
  sip: ["의도한 게 아니라면 복구 모드에서 `csrutil enable`로 켜세요.", "Unless intended, re-enable it from Recovery with `csrutil enable`."],
  gatekeeper: ["`sudo spctl --master-enable` 또는 시스템 설정에서 켜세요.", "Re-enable it with `sudo spctl --master-enable` or in System Settings."],
  autologin: ["시스템 설정 > 사용자 및 그룹에서 자동 로그인을 끄세요.", "Turn off automatic login in System Settings > Users & Groups."],
  guest: ["필요 없다면 시스템 설정 > 사용자 및 그룹에서 끄세요.", "Turn it off in System Settings > Users & Groups if unused."],
  updates: ["시스템 설정 > 일반 > 소프트웨어 업데이트 > 자동 업데이트에서 보안 대응을 켜세요.", "Turn on security responses in System Settings > General > Software Update > Automatic Updates."],
  listener: ["의도한 서비스인지 확인하세요. 필요 없으면 끄거나 127.0.0.1에만 열도록 설정하세요.", "Check that this service is intended; turn it off or bind it to 127.0.0.1 if not."],
};
const NOT_CHECKED_KO = "검사하지 않은 것: 악성코드, 비밀번호 유출 DB(인터넷 필요), Keychain 내용, 브라우저 저장 비밀번호, git 기록 안의 파일 내용, 관리자 권한이 있어야 보이는 설정과 서비스(root 소유 포트).";
const NOT_CHECKED_EN = "Not checked: malware, breached-password databases (need the internet), Keychain contents, browser-saved passwords, file contents inside git history, settings and services that need admin rights to see (root-owned listeners).";

export async function securityCheckAnswer(root: string | undefined, ko: boolean): Promise<{ answer: string; detail: string }> {
  const [proj, home, sys] = await Promise.all([root ? projectFindings(root) : Promise.resolve([]), homeFindings(), systemFindings()]);
  const all = [...proj, ...home, ...sys];
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, ok: 3 };
  const issues = all.filter((f) => f.severity !== "ok").sort((a, b) => rank[a.severity] - rank[b.severity]);
  const label = (s: Severity) => (ko ? { high: "높음", medium: "중간", low: "낮음", ok: "정상" }[s] : s);
  const area = (a: Finding["area"]) => (ko ? { project: "프로젝트", home: "홈 폴더", system: "시스템" }[a] : a);
  const count = (s: Severity) => issues.filter((f) => f.severity === s).length;
  const head = ko
    ? (issues.length ? `확인이 필요한 항목 ${issues.length}개 (높음 ${count("high")}, 중간 ${count("medium")}, 낮음 ${count("low")}).` : "확인된 문제가 없어요.")
    : (issues.length ? `${issues.length} findings (high ${count("high")}, medium ${count("medium")}, low ${count("low")}).` : "No issues found.");
  const L: string[] = [head];
  if (issues.length) {
    L.push(`\n| ${ko ? "위험도 | 영역 | 내용 | 위치" : "Severity | Area | Finding | Where"} |\n|---|---|---|---|`);
    for (const f of issues.slice(0, 40)) L.push(`| ${label(f.severity)} | ${area(f.area)} | ${(ko && f.ko ? f.ko : f.what).replace(/\|/g, "\\|")} | ${f.where ? `\`${f.where}\`` : "–"} |`);
    if (issues.length > 40) L.push(ko ? `\n외 ${issues.length - 40}개` : `\n${issues.length - 40} more`);
    const fixes = [...new Set(issues.map((f) => f.fix).filter((x): x is string => !!x))];
    L.push(`\n**${ko ? "조치" : "What to do"}**\n${fixes.map((k) => `- ${FIX[k][ko ? 0 : 1]}`).join("\n")}`);
  }
  const okList = all.filter((f) => f.severity === "ok").map((f) => (ko && f.ko ? f.ko : f.what) + (f.where ? ` (${f.where})` : ""));
  if (okList.length) L.push(`\n${ko ? "정상" : "OK"}: ${okList.join("; ")}`);
  L.push(`\n_${ko ? `${root ? "프로젝트 폴더, " : ""}홈 폴더의 자격 증명 파일, 시스템 설정을 이 Mac 안에서만 검사했어요. 값은 앞 4자만 보여요. ` : `Checked ${root ? "the project folder, " : ""}credential files in your home folder and system settings, on this Mac only; values show their first 4 characters. `}${ko ? NOT_CHECKED_KO : NOT_CHECKED_EN}_`);
  return { answer: L.join("\n"), detail: `${count("high")} high, ${count("medium")} medium, ${count("low")} low` };
}

export const _test = { projectFindings, homeFindings, systemFindings };
