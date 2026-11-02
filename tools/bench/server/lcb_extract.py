#!/usr/bin/env python3
"""Keep only the LiveCodeBench v6 problems in the subset file; decode hidden tests safely.
usage: python3 -I lcb_extract.py test6.jsonl ../subsets/lcb-v6-30.json lcb.jsonl"""
import base64, json, pickle, pickletools, sys, zlib

UNSAFE = {"GLOBAL", "STACK_GLOBAL", "REDUCE", "INST", "OBJ", "NEWOBJ", "NEWOBJ_EX", "BUILD", "EXT1", "EXT2", "EXT4"}

def safe_unpickle(b):
    for op, _, _ in pickletools.genops(b):
        if op.name in UNSAFE:
            raise ValueError("unsafe pickle opcode " + op.name)
    return pickle.loads(b)

def private(s):
    try:
        return json.loads(s)
    except Exception:
        return json.loads(safe_unpickle(zlib.decompress(base64.b64decode(s.encode()))))

ids = set(json.load(open(sys.argv[2]))["ids"])
n = 0
with open(sys.argv[3], "w") as out:
    for line in open(sys.argv[1]):
        r = json.loads(line)
        if r["question_id"] not in ids:
            continue
        out.write(json.dumps({"id": r["question_id"], "title": r["question_title"], "difficulty": r["difficulty"], "date": r["contest_date"],
                              "content": r["question_content"], "starter": r.get("starter_code", ""), "public": json.loads(r["public_test_cases"]),
                              "private": private(r["private_test_cases"]), "metadata": json.loads(r.get("metadata") or "{}")}) + "\n")
        n += 1
print(f"lcb: kept {n} of {len(ids)} subset problems")
