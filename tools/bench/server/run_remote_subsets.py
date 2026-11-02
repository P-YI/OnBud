#!/usr/bin/env python3
"""Remote variant of run_subsets.py: generation through an OpenAI-compatible API (vLLM behind an SSH tunnel),
scoring with run_subsets.py's own problems() / code_block() / check(), which are imported, not copied.

  generate  python3 run_remote_subsets.py generate --model Qwen/Qwen3-4B --base-url http://127.0.0.1:18000/v1 --out results
  selftest  python3 run_remote_subsets.py selftest                                  (reference solutions, same runner)
  score     python3 run_remote_subsets.py score --gen results/Qwen__Qwen3-4B
            On macOS each program runs under sandbox-exec with the same profile and Python as the Mac's AFM runs
            (tools/bench/code-eval.ts): no outside network, writes only in temp areas. On Linux run_subsets.py's
            own `unshare -rn` is used.

- Request body is fixed: system "You are an expert Python programmer.", the original prompt, temperature 0,
  max_tokens 1024 (protocol), n 1, no streaming. --max-tokens N is only for the supplementary larger-budget run,
  which must go to its own --out directory (e.g. results-mt4096).
- The reply text (choices[0].message.content) is used as is; only the original code_block() is applied.
- Only transport failures are retried (connection errors, HTTP 429, HTTP 5xx). Already answered problems are
  never regenerated: generate resumes from generations.jsonl.
- finish_reason is kept per problem; the summary reports how many replies were cut off at max_tokens.
"""
import argparse, glob, json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_subsets as rs   # problems, code_block, check (unchanged)

# ---- macOS sandbox, same profile as sandboxRun() in tools/bench/code-eval.ts. Network rules are split by
# direction: a (local ip "localhost:*") rule on network* also matches outbound connections to any host.
def _uv_python():
    found = sorted(glob.glob(os.path.expanduser("~/.local/share/uv/python/cpython-3.1[0-9]*/bin/python3")))
    return found[-1] if found else "/usr/bin/python3"

def run_py_sandboxed(program, stdin="", timeout=10):
    d = tempfile.mkdtemp(prefix="eval-")
    profile = (f'(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(deny file-write*)'
               f'(allow file-write* (subpath "{d}") (subpath "/private{d}") (subpath "/private/tmp") (subpath "/tmp") (subpath "/private/var/folders") (literal "/dev/null"))')
    try:
        p = os.path.join(d, "prog.py")
        open(p, "w").write(program)
        r = subprocess.run(["/usr/bin/sandbox-exec", "-p", profile, PY, "-I", p], input=stdin, capture_output=True, text=True, timeout=timeout, cwd=d,
                           env={"PATH": "/usr/bin:/bin", "HOME": d, "PYTHONDONTWRITEBYTECODE": "1"})
        return r.returncode == 0, r.stdout + (r.stderr[-2000:] if r.returncode else "")
    except subprocess.TimeoutExpired:
        return False, "[timeout]"
    finally:
        shutil.rmtree(d, ignore_errors=True)

MAC_SANDBOX = sys.platform == "darwin" and os.path.exists("/usr/bin/sandbox-exec")
PY = _uv_python()
if MAC_SANDBOX: rs.run_py = run_py_sandboxed   # check() looks run_py up in its module, so this swaps only the runner

BENCHES = [("humaneval", "humaneval-40.json"), ("lcb", "lcb-v6-30.json"), ("bcb", "bcb-hard-stdlib.json")]
SYSTEM = "You are an expert Python programmer."
utc = lambda: datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def post(url, body, timeout=600, tries=6):
    """POST JSON; retry transport failures only. Returns (response, retries)."""
    data = json.dumps(body).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r), i
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500: raise   # 4xx (e.g. context too long) is a result, not a transport failure
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        if i == tries - 1: raise RuntimeError(f"transport failed after {tries} attempts")
        time.sleep(min(60, 2 ** i * 5))

def model_ids(base):
    with urllib.request.urlopen(base.rstrip("/") + "/models", timeout=30) as r:
        return [m["id"] for m in json.load(r)["data"]]

def generate(a):
    ids = model_ids(a.base_url)
    if a.model not in ids: sys.exit(f"model id mismatch: server has {ids}, expected {a.model}; not starting")
    out = os.path.join(a.out, a.model.replace("/", "__")); os.makedirs(out, exist_ok=True)
    gp = os.path.join(out, "generations.jsonl")
    done = {(g["bench"], g["id"]) for g in rs.jsonl(gp)} if os.path.exists(gp) else set()
    meta_p = os.path.join(out, "run.json")
    meta = json.load(open(meta_p)) if os.path.exists(meta_p) else {"model": a.model, "served_ids": ids, "base_url": a.base_url, "max_tokens": a.max_tokens,
            "temperature": 0, "n": 1, "system": SYSTEM, "started_utc": utc(), "sessions": []}
    if meta["max_tokens"] != a.max_tokens: sys.exit(f"{out} was generated with max_tokens {meta['max_tokens']}; use another --out")
    sess = {"started_utc": utc(), "retries": 0, "errors": 0, "generated": 0}
    meta["sessions"].append(sess)
    for bench, sub in BENCHES:
        for pid, q, _ in rs.problems(bench, a.data, os.path.join(a.subsets, sub)):
            if (bench, pid) in done: continue
            body = {"model": a.model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}],
                    "temperature": 0, "max_tokens": a.max_tokens, "n": 1, "stream": False}
            t0 = time.time()
            try:
                r, retries = post(a.base_url.rstrip("/") + "/chat/completions", body)
                rec = {"bench": bench, "id": pid, "content": r["choices"][0]["message"].get("content") or "", "finish_reason": r["choices"][0].get("finish_reason"),
                       "usage": r.get("usage"), "seconds": round(time.time() - t0, 2), "retries": retries}
            except urllib.error.HTTPError as e:   # recorded as a failed generation (scored as fail), not retried
                retries = 0; sess["errors"] += 1
                rec = {"bench": bench, "id": pid, "content": "", "finish_reason": f"http_{e.code}", "error": e.read().decode(errors="replace")[:300], "seconds": round(time.time() - t0, 2), "retries": 0}
            sess["retries"] += retries; sess["generated"] += 1
            with open(gp, "a") as f: f.write(json.dumps(rec) + "\n")
            print(f"{bench} {pid} {rec['finish_reason']} {rec['seconds']}s", flush=True)
            sess["ended_utc"] = utc(); json.dump(meta, open(meta_p, "w"), indent=1)
    sess["ended_utc"] = meta["ended_utc"] = utc(); json.dump(meta, open(meta_p, "w"), indent=1)

def score(a):
    meta = json.load(open(os.path.join(a.gen, "run.json")))
    gens = {(g["bench"], g["id"]): g for g in rs.jsonl(os.path.join(a.gen, "generations.jsonl"))}
    summary = {"model": meta["model"], "protocol": "greedy pass@1, chat template, same subsets and checks as OpenAFM raw (remote API generation)",
               "date": meta["started_utc"][:10], "base_url": meta["base_url"], "served_ids": meta["served_ids"], "max_tokens": meta["max_tokens"],
               "started_utc": meta["started_utc"], "ended_utc": meta.get("ended_utc"), "transport_retries": sum(s["retries"] for s in meta["sessions"]),
               "sessions": len(meta["sessions"]), "scoring": f"macOS sandbox-exec, {PY}" if MAC_SANDBOX else ("unshare -rn" if rs.NO_NET else "NO NETWORK ISOLATION"),
               "network_isolation": MAC_SANDBOX or bool(rs.NO_NET)}
    for bench, sub in BENCHES:
        items = list(rs.problems(bench, a.data, os.path.join(a.subsets, sub)))
        missing = [pid for pid, _, _ in items if (bench, pid) not in gens]
        if missing: sys.exit(f"{bench}: {len(missing)} generations missing ({missing[:3]}…); finish generate first")
        passed = cut = 0
        with open(os.path.join(a.gen, f"{bench}.jsonl"), "w") as f:
            for pid, _, p in items:
                g = gens[(bench, pid)]
                ok, err = rs.check(bench, p, rs.code_block(g["content"]))
                passed += ok; cut += g["finish_reason"] == "length"
                f.write(json.dumps({"id": pid, "pass": ok, "error": None if ok else err[-300:], "finish_reason": g["finish_reason"]}) + "\n")
        secs = sum(gens[(bench, pid)]["seconds"] for pid, _, _ in items)
        summary[bench] = {"pass": passed, "n": len(items), "pass@1": round(100 * passed / max(1, len(items)), 1), "gen_seconds": round(secs, 1),
                          "truncated": cut, "truncated_pct": round(100 * cut / max(1, len(items)), 1)}
        print(bench, summary[bench], flush=True)
    json.dump(summary, open(os.path.join(a.gen, "summary.json"), "w"), indent=1)

def selftest(a):
    """run.sh selftest under the same runner as score: reference solutions must pass before any model is scored."""
    for bench, sub, field in [("humaneval", "humaneval-40.json", "prompt"), ("bcb", "bcb-hard-stdlib.json", "complete_prompt")]:
        items = list(rs.problems(bench, a.data, os.path.join(a.subsets, sub)))
        fails = [pid for pid, _, p in items if not rs.check(bench, p, p[field] + p["canonical_solution"])[0]]
        print(f"{bench}: reference solutions pass {len(items) - len(fails)}/{len(items)}{f' (fail: {fails})' if fails else ''}")
    print("scoring:", f"macOS sandbox-exec, {PY}" if MAC_SANDBOX else ("unshare -rn" if rs.NO_NET else "NO NETWORK ISOLATION"))

def main():
    a = argparse.ArgumentParser(); sp = a.add_subparsers(dest="cmd", required=True)
    g = sp.add_parser("generate"); g.add_argument("--model", required=True); g.add_argument("--base-url", required=True); g.add_argument("--max-tokens", type=int, default=1024)
    s = sp.add_parser("score"); s.add_argument("--gen", required=True)
    t = sp.add_parser("selftest")
    for p in (g, s, t): p.add_argument("--data", default="data"); p.add_argument("--subsets", default="../subsets"); p.add_argument("--out", default="results")
    args = a.parse_args()
    {"generate": generate, "score": score, "selftest": selftest}[args.cmd](args)

if __name__ == "__main__":
    main()
