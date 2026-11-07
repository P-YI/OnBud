// Sandboxed Python for generated code (benchmarks, the code skill's stress test, local jobs' gate).
// sandbox-exec: no network except localhost, writes only inside a fresh temp dir and the temp areas, a timeout.
// Network rules are split by direction: an (allow network* (local ip "localhost:*")) rule also matched outbound
// connections to any host (found 2026-10-31). Localhost sockets and /tmp stay allowed because BigCodeBench tests
// use them (the official harness runs in Docker with the same freedoms).
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface Run { ok: boolean; out: string }

/** Python 3.10+ as in the official harnesses (macOS /usr/bin/python3 is 3.9): the uv-managed 3.1x if present. */
export const PY = (() => {
  try {
    const base = join(homedir(), ".local/share/uv/python");
    const d = readdirSync(base).filter((x) => /^cpython-3\.1\d/.test(x)).sort().pop();
    return d && existsSync(join(base, d, "bin/python3")) ? join(base, d, "bin/python3") : "/usr/bin/python3";
  } catch { return "/usr/bin/python3"; }
})();

export function runPython(program: string, stdin = "", timeoutMs = 10_000): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "afm-eval-"));
  writeFileSync(join(dir, "prog.py"), program);
  const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(deny file-write*)(allow file-write* (subpath "${dir}") (subpath "/private${dir}") (subpath "/private/tmp") (subpath "/tmp") (subpath "/private/var/folders") (literal "/dev/null"))`;
  return new Promise((res) => {
    const child = execFile("/usr/bin/sandbox-exec", ["-p", profile, PY, "-I", join(dir, "prog.py")], { cwd: dir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", HOME: dir, PYTHONDONTWRITEBYTECODE: "1" } },
      (err: any, stdout, stderr) => { rmSync(dir, { recursive: true, force: true }); res({ ok: !err, out: String(stdout ?? "") + (err ? String(stderr ?? "").slice(-3000) : "") + (err?.killed ? "\n[timeout]" : "") }); });   // full stdout: long answers must compare whole
    child.stdin?.end(stdin);
  });
}
