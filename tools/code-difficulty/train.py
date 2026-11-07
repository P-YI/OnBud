#!/usr/bin/env python3
"""Train the code skill's difficulty classifier (skills/code/difficulty.json).

Data: DeepMind CodeContests (CC BY 4.0, https://huggingface.co/datasets/deepmind/code_contests). Only the
`description`, `cf_rating`, `difficulty` and `source` columns are read, by HTTP range requests on the dataset's
parquet export (~5 MB); nothing is stored in the repository. Label: "easy" = Codeforces rating <= 1200, or a
CodeChef problem marked EASY. The output holds only weights (hashed word features, no text from the data).

Features (mirrored exactly by services/controller/code-difficulty.ts): lower-cased text without $...$ math,
words of 3+ letters and their bigrams, hashed with CRC-32 into DIM buckets and L2-normalised; plus log length,
the largest power of ten in the constraints, whether it is >= 5, and a bias. Logistic regression, L2.

Usage: python3 tools/code-difficulty/train.py [--cache DIR] [--out skills/code/difficulty.json]
Requires numpy and pyarrow.
"""
import argparse, io, json, math, os, re, urllib.request, zlib
import numpy as np

DIM = 1 << 12
API = "https://datasets-server.huggingface.co/parquet?dataset=deepmind/code_contests"
EASY_RATING = 1200
THRESHOLD = -1.45   # chosen on the development LCB split (dev-lcb-v6-30): Copilot first above it


def words(text):
    t = re.sub(r"\$[^$]*\$", " ", text.lower())
    w = re.findall(r"[a-z]{3,}", t)
    return w + [a + "_" + b for a, b in zip(w, w[1:])]


def max_exp(text):
    c = text.split("onstraints")[-1] if "onstraints" in text else text
    e = [int(x) for x in re.findall(r"10\^\{?\s*(\d+)", c)]
    n = [len(x.replace(",", "")) - 1 for x in re.findall(r"(?:\\leq?|≤|<=)\s*([\d,]{2,})", c)]
    return min(max(e + n + [0]), 18)


def features(text):
    x = np.zeros(DIM + 4)
    for w in words(text):
        x[zlib.crc32(w.encode()) % DIM] += 1
    n = np.linalg.norm(x[:DIM])
    if n:
        x[:DIM] /= n
    me = max_exp(text)
    x[DIM:] = [math.log(len(text) + 1) / 8, me / 18, float(me >= 5), 1.0]
    return x


class RangeFile(io.RawIOBase):
    """A remote file read by HTTP range requests, so pyarrow fetches only the columns it needs."""
    def __init__(self, url):
        r = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60)
        self.url, self.size, self.pos = r.url, int(r.headers["Content-Length"]), 0
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, o, w=0):
        self.pos = {0: o, 1: self.pos + o, 2: self.size + o}[w]
        return self.pos
    def read(self, n=-1):
        if n < 0: n = self.size - self.pos
        if n == 0 or self.pos >= self.size: return b""
        end = min(self.size, self.pos + n) - 1
        d = urllib.request.urlopen(urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"}), timeout=120).read()
        self.pos += len(d)
        return d
    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d
        return len(d)


def load(cache):
    path = os.path.join(cache, "codecontests-columns.jsonl")
    if not os.path.exists(path):
        import pyarrow.parquet as pq
        os.makedirs(cache, exist_ok=True)
        files = json.load(urllib.request.urlopen(API, timeout=60))["parquet_files"]
        with open(path, "w") as out:
            for f in files:
                t = pq.ParquetFile(RangeFile(f["url"])).read(columns=["description", "difficulty", "cf_rating", "source"])
                for r in t.to_pylist():
                    out.write(json.dumps(r) + "\n")
    return [json.loads(l) for l in open(path)]


def train(X, y, lam=1e-3, steps=600, lr=2.0):
    w = np.zeros(X.shape[1])
    for _ in range(steps):
        p = 1 / (1 + np.exp(-X @ w))
        w -= lr * (X.T @ (p - y) / len(y) + lam * w)
    return w


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--cache", default=os.path.expanduser("~/OnBud/runtime/classifier"))
    a.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "skills", "code", "difficulty.json"))
    o = a.parse_args()
    X, y = [], []
    for r in load(o.cache):
        if r["cf_rating"]: lab = r["cf_rating"] <= EASY_RATING
        elif r["source"] == 1 and r["difficulty"] in (1, 2, 3): lab = r["difficulty"] == 1   # CodeChef EASY/MEDIUM/HARD
        else: continue
        X.append(features(r["description"])); y.append(float(lab))
    X, y = np.array(X), np.array(y)
    w = train(X, y)
    json.dump({
        "version": 1, "dim": DIM, "threshold": THRESHOLD, "rows": len(y),
        "source": "Trained on DeepMind CodeContests (CC BY 4.0) problem descriptions and ratings; weights only.",
        "weights": [round(float(v), 5) for v in w],
    }, open(o.out, "w"), separators=(",", ":"))
    print(f"{len(y)} rows, easy share {y.mean():.2f} -> {o.out}")


if __name__ == "__main__":
    main()
