#!/usr/bin/env python3
"""Score open models on the same benchmark subsets as the local OpenAFM runs (raw protocol: one greedy sample).

  python run_subsets.py --model Qwen/Qwen2.5-Coder-1.5B-Instruct --data data --subsets ../subsets --out results

- Subsets: ../subsets/{humaneval-40,lcb-v6-30,bcb-hard-stdlib}.json (identical ids to the Mac runs).
- Generation: vLLM, chat template, temperature 0, max 1024 new tokens; the code block of the reply is used,
  and for function tasks the prompt is prepended if the reply lacks the function definition.
- Scoring: the same checks as tools/bench/code-eval.ts (HumanEval check(), LiveCodeBench stdin/functional tests
  with the official import prefix, BigCodeBench unittest), each in a subprocess with a timeout; with
  `unshare -rn` (no network) when available.
- Output: results/<model>/<bench>.jsonl ({id, pass, error}) and results/<model>/summary.json.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time

LCB_PREFIX = ("from string import *\nfrom re import *\nfrom datetime import *\nfrom collections import *\nfrom heapq import *\n"
              "from bisect import *\nfrom copy import *\nfrom math import *\nfrom random import *\nfrom statistics import *\n"
              "from itertools import *\nfrom functools import *\nfrom operator import *\nfrom io import *\nfrom sys import *\n"
              "from json import *\nfrom builtins import *\nfrom typing import *\nimport string, re, datetime, collections, heapq, bisect, copy, "
              "math, random, statistics, itertools, functools, operator, io, sys, json\nsys.setrecursionlimit(50000)\n")
NO_NET = ["unshare", "-rn"] if shutil.which("unshare") and subprocess.run(["unshare", "-rn", "true"], capture_output=True).returncode == 0 else []

def jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]

def run_py(program, stdin="", timeout=10):
    d = tempfile.mkdtemp(prefix="eval-")
    try:
        p = os.path.join(d, "prog.py")
        open(p, "w").write(program)
        r = subprocess.run(NO_NET + [sys.executable, "-I", p], input=stdin, capture_output=True, text=True, timeout=timeout, cwd=d)
        return r.returncode == 0, r.stdout + (r.stderr[-2000:] if r.returncode else "")
    except subprocess.TimeoutExpired:
        return False, "[timeout]"
    finally:
        shutil.rmtree(d, ignore_errors=True)

def code_block(text):
    m = re.search(r"```(?:python)?\n(.*?)```", text, re.S)
    return m.group(1) if m else text

def norm_json(x):
    try:
        return json.dumps(json.loads(x))
    except Exception:
        return "!" + str(x).strip()

def problems(bench, data, subset):
    ids = set(json.load(open(subset))["ids"])
    if bench == "humaneval":
        for p in jsonl(os.path.join(data, "humaneval.jsonl")):
            if p["task_id"] in ids:
                yield p["task_id"], f"Complete the following Python function. Return the whole function in one ```python block.\n\n{p['prompt']}", p
    elif bench == "lcb":
        for p in jsonl(os.path.join(data, "lcb.jsonl")):
            if p["id"] in ids:
                how = f"Starter code:\n{p['starter']}" if p.get("starter") else "Read from standard input and write to standard output."
                yield p["id"], f"{p['content']}\n\n{how}\n\nReturn the complete Python solution in one ```python block.", p
    else:
        for p in jsonl(os.path.join(data, "bcb-hard.jsonl")):
            if p["task_id"] in ids:
                yield p["task_id"], f"{p['complete_prompt']}\n\nReturn the complete Python code in one ```python block.", p

def check(bench, p, code):
    if bench == "humaneval":
        if not re.search(rf"def\s+{p['entry_point']}\b", code): code = p["prompt"] + code
        return run_py(f"{code}\n\n{p['test']}\n\ncheck({p['entry_point']})\n")
    if bench == "bcb":
        if not re.search(rf"def\s+{p['entry_point']}\b", code): code = p["complete_prompt"] + code
        return run_py(f"{code}\n\n{p['test']}\n\nimport unittest\nunittest.main(argv=['x'], exit=True)\n", timeout=30)
    fn = (p.get("metadata") or {}).get("func_name")
    for t in (p["public"] + p["private"])[:30]:
        if fn:
            call = f"\nimport json\n_args=[json.loads(x) for x in {json.dumps(t['input'])}.split('\\n') if x.strip()]\nprint(json.dumps(Solution().{fn}(*_args)))\n"
            ok, out = run_py(LCB_PREFIX + code + call)
            if not ok or norm_json((out.strip().split("\n") or ["null"])[-1]) != norm_json(t["output"]): return False, out[-500:]
        else:
            ok, out = run_py(LCB_PREFIX + code, t["input"])
            if not ok or out.strip() != str(t["output"]).strip(): return False, out[-500:]
    return True, "ok"

def main():
    a = argparse.ArgumentParser()
    a.add_argument("--model", required=True); a.add_argument("--data", default="data"); a.add_argument("--subsets", default="../subsets")
    a.add_argument("--out", default="results"); a.add_argument("--max-tokens", type=int, default=1024); a.add_argument("--tp", type=int, default=1)
    args = a.parse_args()
    from vllm import LLM, SamplingParams
    llm = LLM(model=args.model, tensor_parallel_size=args.tp, max_model_len=8192, trust_remote_code=False)
    sp = SamplingParams(temperature=0.0, max_tokens=args.max_tokens)
    out_dir = os.path.join(args.out, args.model.replace("/", "__")); os.makedirs(out_dir, exist_ok=True)
    summary = {"model": args.model, "protocol": "greedy pass@1, chat template, same subsets and checks as OpenAFM raw", "date": time.strftime("%Y-%m-%d")}
    for bench, sub in [("humaneval", "humaneval-40.json"), ("lcb", "lcb-v6-30.json"), ("bcb", "bcb-hard-stdlib.json")]:
        items = list(problems(bench, args.data, os.path.join(args.subsets, sub)))
        msgs = [[{"role": "system", "content": "You are an expert Python programmer."}, {"role": "user", "content": q}] for _, q, _ in items]
        t0 = time.time(); gens = llm.chat(msgs, sp, use_tqdm=True); gen_s = time.time() - t0
        passed = 0
        with open(os.path.join(out_dir, f"{bench}.jsonl"), "w") as f:
            for (pid, _, p), g in zip(items, gens):
                ok, err = check(bench, p, code_block(g.outputs[0].text))
                passed += ok
                f.write(json.dumps({"id": pid, "pass": ok, "error": None if ok else err[-300:]}) + "\n")
        summary[bench] = {"pass": passed, "n": len(items), "pass@1": round(100 * passed / max(1, len(items)), 1), "gen_seconds": round(gen_s, 1)}
        print(bench, summary[bench], flush=True)
    json.dump(summary, open(os.path.join(out_dir, "summary.json"), "w"), indent=1)

if __name__ == "__main__":
    main()
