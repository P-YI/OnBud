# ML implementation tasks (2026-11-01): 15 HumanEval-style problems written for OpenAFM (no third-party data),
# pure Python, numeric checks with tolerances. Each reference solution must pass its tests and doctests before
# the file is written.  usage: python3 -I tools/bench/make-ml-impl.py <python3.10+> tools/bench/ml-impl.jsonl
import json, sys, subprocess, textwrap
T = []
def add(tid, entry, prompt, sol, test):
    T.append({"task_id": f"ML/{tid}", "entry_point": entry, "prompt": textwrap.dedent(prompt).lstrip("\n"), "canonical_solution": sol, "test": textwrap.dedent(test)})

add("simple_regression","fit_line",'''
def fit_line(xs: list, ys: list) -> tuple:
    """Fit y = slope * x + intercept by ordinary least squares and return (slope, intercept).
    >>> fit_line([0, 1, 2], [1, 3, 5])
    (2.0, 1.0)
    """
''','''    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys)); sxx = sum((x - mx) ** 2 for x in xs)
    slope = sxy / sxx
    return (slope, my - slope * mx)
''','''
def check(f):
    s, b = f([1, 2, 3, 4, 5], [2.2, 4.1, 6.2, 7.9, 10.1])
    assert abs(s - 1.96) < 1e-9 and abs(b - 0.22) < 1e-9
    s, b = f([0, 1, 2], [1, 3, 5]); assert abs(s - 2) < 1e-9 and abs(b - 1) < 1e-9
    s, b = f([-1, 0, 1, 2], [3, 1, -1, -3]); assert abs(s + 2) < 1e-9 and abs(b - 1) < 1e-9
''')

add("multiple_regression","fit_ols",'''
def fit_ols(X: list, y: list) -> list:
    """Multiple linear regression by least squares (normal equations, solved with Gaussian elimination;
    no numpy). X is a list of rows (features only); add an intercept. Return [intercept, w1, w2, ...].
    >>> [round(v, 6) for v in fit_ols([[1, 0], [0, 1], [1, 1], [2, 1]], [3, 4, 6, 8])]
    [1.0, 2.0, 3.0]
    """
''','''    A = [[1.0] + list(map(float, r)) for r in X]; p = len(A[0])
    M = [[sum(a[i] * a[j] for a in A) for j in range(p)] + [sum(a[i] * t for a, t in zip(A, y))] for i in range(p)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(M[r][c])); M[c], M[piv] = M[piv], M[c]
        for r in range(p):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [a - f * b for a, b in zip(M[r], M[c])]
    return [M[i][p] / M[i][i] for i in range(p)]
''','''
def check(f):
    w = f([[1, 0], [0, 1], [1, 1], [2, 1]], [3, 4, 6, 8]); assert all(abs(a - b) < 1e-6 for a, b in zip(w, [1, 2, 3]))
    X = [[1, 2, 0], [2, 0, 1], [3, 1, 1], [0, 1, 2], [4, 3, 0], [1, 1, 1]]
    y = [0.5 + 1.5 * a - 2 * b + 0.25 * c for a, b, c in X]
    w = f(X, y); assert len(w) == 4 and all(abs(a - b) < 1e-6 for a, b in zip(w, [0.5, 1.5, -2, 0.25]))
''')

add("ridge","fit_ridge",'''
def fit_ridge(X: list, y: list, lam: float) -> list:
    """Ridge regression without an intercept: w = (X^T X + lam * I)^-1 X^T y, solved without numpy.
    X is a list of rows. Return the weights as a list.
    >>> [round(v, 6) for v in fit_ridge([[1, 0], [0, 1]], [2, 4], 1.0)]
    [1.0, 2.0]
    """
''','''    p = len(X[0])
    M = [[sum(r[i] * r[j] for r in X) + (lam if i == j else 0.0) for j in range(p)] + [sum(r[i] * t for r, t in zip(X, y))] for i in range(p)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(M[r][c])); M[c], M[piv] = M[piv], M[c]
        for r in range(p):
            if r != c:
                f = M[r][c] / M[c][c]; M[r] = [a - f * b for a, b in zip(M[r], M[c])]
    return [M[i][p] / M[i][i] for i in range(p)]
''','''
def check(f):
    w = f([[1, 0], [0, 1]], [2, 4], 1.0); assert abs(w[0] - 1) < 1e-9 and abs(w[1] - 2) < 1e-9
    w = f([[1, 2], [3, 4], [5, 6]], [1, 2, 3], 0.5)
    assert abs(w[0] - 11 / 69.75) < 1e-9 and abs(w[1] - 26 / 69.75) < 1e-9
    w = f([[1, 2], [3, 4], [5, 6]], [1, 2, 3], 0.0); assert abs(w[0]) < 1e-6 and abs(w[1] - 0.5) < 1e-6
''')

add("gradient_descent","gd_linear",'''
def gd_linear(xs: list, ys: list, lr: float, epochs: int) -> tuple:
    """Fit y = w * x + b with batch gradient descent on the mean squared error, starting from w = b = 0.
    Each epoch: compute the gradients of MSE = mean((w*x + b - y)^2) over all points, then
    w -= lr * dw and b -= lr * db (update both with the gradients from the same epoch). Return (w, b).
    >>> [round(v, 4) for v in gd_linear([0, 1], [0, 2], 0.5, 1)]
    [1.0, 1.0]
    """
''','''    w = b = 0.0; n = len(xs)
    for _ in range(epochs):
        err = [w * x + b - y for x, y in zip(xs, ys)]
        dw = 2 * sum(e * x for e, x in zip(err, xs)) / n; db = 2 * sum(err) / n
        w -= lr * dw; b -= lr * db
    return (w, b)
''','''
def check(f):
    w, b = f([0, 1], [0, 2], 0.5, 1); assert abs(w - 1) < 1e-9 and abs(b - 1) < 1e-9
    w, b = f([0, 1], [0, 2], 0.5, 2); assert abs(w - 1.0) < 1e-9 and abs(b - 0.5) < 1e-9
    w, b = f([1, 2, 3, 4], [3, 5, 7, 9], 0.05, 2000); assert abs(w - 2) < 1e-3 and abs(b - 1) < 1e-3
''')

add("logistic","logistic_fit_predict",'''
import math
def logistic_fit_predict(X: list, y: list, X_test: list, lr: float = 0.1, epochs: int = 1000) -> list:
    """Binary logistic regression with an intercept, trained by batch gradient descent on the mean
    log-loss from all-zero weights. Return predicted labels (0 or 1, threshold 0.5) for X_test.
    >>> logistic_fit_predict([[0], [1], [3], [4]], [0, 0, 1, 1], [[-1], [5]])
    [0, 1]
    """
''','''    import math
    p = len(X[0]); w = [0.0] * (p + 1); n = len(X)
    sig = lambda z: 1 / (1 + math.exp(-max(-60, min(60, z))))
    for _ in range(epochs):
        g = [0.0] * (p + 1)
        for r, t in zip(X, y):
            e = sig(w[0] + sum(a * b for a, b in zip(w[1:], r))) - t
            g[0] += e
            for j in range(p): g[j + 1] += e * r[j]
        w = [a - lr * b / n for a, b in zip(w, g)]
    return [1 if sig(w[0] + sum(a * b for a, b in zip(w[1:], r))) >= 0.5 else 0 for r in X_test]
''','''
def check(f):
    assert f([[0], [1], [3], [4]], [0, 0, 1, 1], [[-1], [5]]) == [0, 1]
    X = [[1, 1], [2, 1], [1, 2], [2, 2], [6, 5], [7, 6], [6, 7], [7, 7]]; y = [0, 0, 0, 0, 1, 1, 1, 1]
    assert f(X, y, [[0, 0], [8, 8], [1.5, 1.5], [6.5, 6.5]]) == [0, 1, 0, 1]
''')

add("kmeans","kmeans",'''
def kmeans(points: list, k: int, iters: int) -> list:
    """Lloyd's k-means. Initial centroids are the first k points. Each iteration: assign every point to
    the nearest centroid (squared Euclidean distance, ties to the lower index), then move each centroid
    to the mean of its points (a centroid with no points stays where it is). Return the centroids as
    lists of floats, in index order.
    >>> kmeans([[0, 0], [10, 10], [0, 1], [10, 11]], 2, 3)
    [[0.0, 0.5], [10.0, 10.5]]
    """
''','''    C = [list(map(float, p)) for p in points[:k]]
    for _ in range(iters):
        groups = [[] for _ in range(k)]
        for p in points:
            d = [sum((a - b) ** 2 for a, b in zip(p, c)) for c in C]
            groups[d.index(min(d))].append(p)
        C = [[sum(v) / len(g) for v in zip(*g)] if g else C[i] for i, g in enumerate(groups)]
    return C
''','''
def check(f):
    assert f([[0, 0], [10, 10], [0, 1], [10, 11]], 2, 3) == [[0.0, 0.5], [10.0, 10.5]]
    pts = [[1, 1], [1.5, 2], [3, 4], [5, 7], [3.5, 5], [4.5, 5], [3.5, 4.5]]
    c = f(pts, 2, 10)
    want = [[1.25, 1.5], [3.9, 5.1]]
    assert all(abs(a - b) < 1e-9 for r, s in zip(c, want) for a, b in zip(r, s)), c
''')

add("knn","knn_predict",'''
def knn_predict(train_X: list, train_y: list, x: list, k: int):
    """k-nearest-neighbours classification by Euclidean distance. Take the k nearest training points
    (ties in distance: lower index first) and return the majority label; if labels tie in count, return
    the label of the nearest point among the tied labels.
    >>> knn_predict([[0], [1], [5], [6]], ["a", "a", "b", "b"], [0.4], 3)
    'a'
    """
''','''    order = sorted(range(len(train_X)), key=lambda i: (sum((a - b) ** 2 for a, b in zip(train_X[i], x)), i))[:k]
    counts = {}
    for i in order: counts[train_y[i]] = counts.get(train_y[i], 0) + 1
    best = max(counts.values())
    for i in order:
        if counts[train_y[i]] == best: return train_y[i]
''','''
def check(f):
    assert f([[0], [1], [5], [6]], ["a", "a", "b", "b"], [0.4], 3) == "a"
    assert f([[0, 0], [1, 1], [9, 9], [8, 8]], [0, 0, 1, 1], [7, 7], 1) == 1
    assert f([[0], [2], [3]], ["x", "y", "z"], [2.4], 2) == "y"
    assert f([[1], [3], [10], [11]], ["p", "q", "q", "p"], [2.2], 4) == "q"
''')

add("naive_bayes","gnb_predict",'''
import math
def gnb_predict(X: list, y: list, x: list):
    """Gaussian naive Bayes: per class, prior = class frequency; per feature, mean and population
    variance (divide by n) of that class, plus 1e-9 added to each variance. Return the class with the
    highest log posterior for x (ties: the class that appears first in y).
    >>> gnb_predict([[1.0], [1.2], [3.0], [3.2]], ["lo", "lo", "hi", "hi"], [1.1])
    'lo'
    """
''','''    import math
    classes = list(dict.fromkeys(y)); best, bv = None, -float("inf")
    for c in classes:
        rows = [r for r, t in zip(X, y) if t == c]; n = len(rows)
        lp = math.log(n / len(y))
        for j in range(len(x)):
            m = sum(r[j] for r in rows) / n; v = sum((r[j] - m) ** 2 for r in rows) / n + 1e-9
            lp += -0.5 * math.log(2 * math.pi * v) - (x[j] - m) ** 2 / (2 * v)
        if lp > bv: best, bv = c, lp
    return best
''','''
def check(f):
    assert f([[1.0], [1.2], [3.0], [3.2]], ["lo", "lo", "hi", "hi"], [1.1]) == "lo"
    X = [[6.0, 180], [5.92, 190], [5.58, 170], [5.92, 165], [5.0, 100], [5.5, 150], [5.42, 130], [5.75, 150]]
    y = ["m", "m", "m", "m", "f", "f", "f", "f"]
    assert f(X, y, [6.0, 130]) == "f"
    assert f(X, y, [5.9, 185]) == "m"
''')

add("pca_power","first_component",'''
def first_component(X: list, iters: int = 200) -> list:
    """First principal component of the rows of X: center each column, form the covariance matrix
    (divide by n - 1), and run power iteration from the all-ones vector, normalising each step.
    Return the unit vector with its largest-magnitude entry positive.
    >>> [round(v, 4) for v in first_component([[1, 1], [2, 2], [3, 3]])]
    [0.7071, 0.7071]
    """
''','''    n = len(X); p = len(X[0]); m = [sum(r[j] for r in X) / n for j in range(p)]
    Z = [[r[j] - m[j] for j in range(p)] for r in X]
    C = [[sum(z[i] * z[j] for z in Z) / (n - 1) for j in range(p)] for i in range(p)]
    v = [1.0] * p
    for _ in range(iters):
        v = [sum(C[i][j] * v[j] for j in range(p)) for i in range(p)]
        nv = sum(a * a for a in v) ** 0.5; v = [a / nv for a in v]
    k = max(range(p), key=lambda i: abs(v[i]))
    return [a if v[k] > 0 else -a for a in v]
''','''
def check(f):
    v = f([[1, 1], [2, 2], [3, 3]]); assert abs(v[0] - 0.70710678) < 1e-4 and abs(v[1] - 0.70710678) < 1e-4
    v = f([[2.5, 2.4], [0.5, 0.7], [2.2, 2.9], [1.9, 2.2], [3.1, 3.0], [2.3, 2.7], [2, 1.6], [1, 1.1], [1.5, 1.6], [1.1, 0.9]])
    assert abs(v[0] - 0.6778734) < 1e-4 and abs(v[1] - 0.7351787) < 1e-4, v
    v = f([[0, 5], [0, -5], [1, 0], [-1, 0]]); assert abs(abs(v[1]) - 1) < 1e-6 and v[1] > 0
''')

add("tfidf","tfidf",'''
import math
def tfidf(docs: list) -> list:
    """TF-IDF for a list of documents (each a list of tokens). tf = count / document length;
    idf = ln(N / df) where df is the number of documents containing the term. Return one dict per
    document mapping each of its terms to tf * idf.
    >>> tfidf([["a", "b"], ["a"]])[0]["b"] == 0.5 * math.log(2)
    True
    """
''','''    import math
    N = len(docs); df = {}
    for d in docs:
        for t in set(d): df[t] = df.get(t, 0) + 1
    out = []
    for d in docs:
        c = {}
        for t in d: c[t] = c.get(t, 0) + 1
        out.append({t: (n / len(d)) * math.log(N / df[t]) for t, n in c.items()})
    return out
''','''
import math
def check(f):
    r = f([["a", "b"], ["a"]]); assert r[0]["a"] == 0 and abs(r[0]["b"] - 0.5 * math.log(2)) < 1e-12 and r[1] == {"a": 0.0}
    r = f([["the", "cat", "sat"], ["the", "dog", "sat", "sat"], ["a", "cat"]])
    assert abs(r[1]["sat"] - 0.5 * math.log(1.5)) < 1e-12 and abs(r[2]["a"] - 0.5 * math.log(3)) < 1e-12
''')

add("skipgram_pairs","skipgram_pairs",'''
def skipgram_pairs(tokens: list, window: int) -> list:
    """Training pairs for word2vec skip-gram: for each position i, pair tokens[i] (center) with every
    token at distance 1..window on both sides that exists. Order: by center position, then context
    position from left to right. Return a list of (center, context) tuples.
    >>> skipgram_pairs(["a", "b", "c"], 1)
    [('a', 'b'), ('b', 'a'), ('b', 'c'), ('c', 'b')]
    """
''','''    out = []
    for i, c in enumerate(tokens):
        for j in range(max(0, i - window), min(len(tokens), i + window + 1)):
            if j != i: out.append((c, tokens[j]))
    return out
''','''
def check(f):
    assert f(["a", "b", "c"], 1) == [("a", "b"), ("b", "a"), ("b", "c"), ("c", "b")]
    assert f(["x"], 3) == []
    assert f(["i", "like", "deep", "nets"], 2) == [("i", "like"), ("i", "deep"), ("like", "i"), ("like", "deep"), ("like", "nets"), ("deep", "i"), ("deep", "like"), ("deep", "nets"), ("nets", "like"), ("nets", "deep")]
''')

add("sgns_step","sgns_update",'''
import math
def sgns_update(center: list, context: list, negatives: list, lr: float) -> tuple:
    """One SGD step of word2vec skip-gram with negative sampling (minimising
    -log sigma(u_o . v_c) - sum_k log sigma(-u_k . v_c)). center is v_c, context is u_o, negatives is a
    list of vectors u_k. Compute every gradient with the vectors before the update, then apply
    x -= lr * grad to all of them. Return (new_center, new_context, new_negatives).
    >>> c, o, n = sgns_update([0.0, 0.0], [1.0, 0.0], [], 1.0)
    >>> [round(v, 4) for v in c], [round(v, 4) for v in o]
    ([0.5, 0.0], [1.0, 0.0])
    """
''','''    import math
    s = lambda z: 1 / (1 + math.exp(-z)); dot = lambda a, b: sum(x * y for x, y in zip(a, b))
    gp = s(dot(context, center)) - 1
    gc = [gp * u for u in context]
    g_ctx = [gp * v for v in center]
    g_negs = []
    for u in negatives:
        gn = s(dot(u, center))
        gc = [a + gn * b for a, b in zip(gc, u)]
        g_negs.append([gn * v for v in center])
    upd = lambda x, g: [a - lr * b for a, b in zip(x, g)]
    return (upd(center, gc), upd(context, g_ctx), [upd(u, g) for u, g in zip(negatives, g_negs)])
''','''
import math
def check(f):
    c, o, n = f([0.0, 0.0], [1.0, 0.0], [], 1.0)
    assert all(abs(a - b) < 1e-9 for a, b in zip(c, [0.5, 0.0])) and all(abs(a - b) < 1e-9 for a, b in zip(o, [1.0, 0.0])) and n == []
    c, o, n = f([0.1, 0.2], [0.3, -0.1], [[0.2, 0.2], [-0.1, 0.4]], 0.5)
    s = lambda z: 1 / (1 + math.exp(-z))
    gp = s(0.3 * 0.1 - 0.1 * 0.2) - 1; g1 = s(0.2 * 0.1 + 0.2 * 0.2); g2 = s(-0.1 * 0.1 + 0.4 * 0.2)
    want_c = [0.1 - 0.5 * (gp * 0.3 + g1 * 0.2 + g2 * -0.1), 0.2 - 0.5 * (gp * -0.1 + g1 * 0.2 + g2 * 0.4)]
    want_o = [0.3 - 0.5 * gp * 0.1, -0.1 - 0.5 * gp * 0.2]
    want_n0 = [0.2 - 0.5 * g1 * 0.1, 0.2 - 0.5 * g1 * 0.2]
    assert all(abs(a - b) < 1e-9 for a, b in zip(c, want_c)) and all(abs(a - b) < 1e-9 for a, b in zip(o, want_o))
    assert all(abs(a - b) < 1e-9 for a, b in zip(n[0], want_n0)) and len(n) == 2
''')

add("most_similar","most_similar",'''
def most_similar(emb: dict, word: str, k: int) -> list:
    """Nearest words to `word` by cosine similarity in the embedding dict {word: vector}, excluding the
    word itself. Return the top k words, highest similarity first (ties: alphabetical order).
    >>> most_similar({"a": [1, 0], "b": [0.9, 0.1], "c": [0, 1]}, "a", 1)
    ['b']
    """
''','''    def cos(u, v):
        d = sum(x * y for x, y in zip(u, v)); nu = sum(x * x for x in u) ** 0.5; nv = sum(x * x for x in v) ** 0.5
        return d / (nu * nv)
    sims = [(-cos(emb[word], v), w) for w, v in emb.items() if w != word]
    return [w for _, w in sorted(sims)[:k]]
''','''
def check(f):
    assert f({"a": [1, 0], "b": [0.9, 0.1], "c": [0, 1]}, "a", 1) == ["b"]
    e = {"king": [0.8, 0.6, 0.1], "queen": [0.75, 0.65, 0.2], "apple": [0.1, 0.2, 0.9], "man": [0.7, 0.3, 0.1], "prince": [1.6, 1.2, 0.2]}
    assert f(e, "king", 2) == ["prince", "queen"]
    assert f({"x": [1, 1], "z": [2, 2], "y": [3, 3], "w": [-1, 0]}, "x", 3) == ["y", "z", "w"]
''')

add("metrics","prf1",'''
def prf1(y_true: list, y_pred: list, positive=1) -> tuple:
    """Precision, recall and F1 for the positive class. A ratio with a zero denominator is 0.0.
    Return (precision, recall, f1) as floats.
    >>> prf1([1, 0, 1, 1], [1, 1, 0, 1])
    (0.6666666666666666, 0.6666666666666666, 0.6666666666666666)
    """
''','''    tp = sum(1 for a, b in zip(y_true, y_pred) if a == positive and b == positive)
    fp = sum(1 for a, b in zip(y_true, y_pred) if a != positive and b == positive)
    fn = sum(1 for a, b in zip(y_true, y_pred) if a == positive and b != positive)
    p = tp / (tp + fp) if tp + fp else 0.0; r = tp / (tp + fn) if tp + fn else 0.0
    return (p, r, 2 * p * r / (p + r) if p + r else 0.0)
''','''
def check(f):
    p, r, s = f([1, 0, 1, 1], [1, 1, 0, 1]); assert abs(p - 2/3) < 1e-12 and abs(r - 2/3) < 1e-12 and abs(s - 2/3) < 1e-12
    assert f([0, 0], [0, 0]) == (0.0, 0.0, 0.0)
    p, r, s = f(["s", "h", "s", "s", "h"], ["s", "s", "s", "h", "h"], positive="s"); assert abs(p - 2/3) < 1e-12 and abs(r - 2/3) < 1e-12
    p, r, s = f([1, 1, 1, 0], [1, 0, 0, 0]); assert p == 1.0 and abs(r - 1/3) < 1e-12 and abs(s - 0.5) < 1e-12
''')

add("softmax_ce","softmax_cross_entropy",'''
import math
def softmax_cross_entropy(logits: list, target: int) -> tuple:
    """Numerically stable softmax (subtract the max logit) and the cross-entropy loss -log p[target].
    Must work for large logits such as 1000. Return (probabilities as a list, loss).
    >>> p, l = softmax_cross_entropy([0.0, 0.0], 1); [round(v, 3) for v in p], round(l, 4)
    ([0.5, 0.5], 0.6931)
    """
''','''    import math
    m = max(logits); e = [math.exp(z - m) for z in logits]; s = sum(e); p = [v / s for v in e]
    return (p, -(logits[target] - m - math.log(s)))
''','''
import math
def check(f):
    p, l = f([0.0, 0.0], 1); assert all(abs(v - 0.5) < 1e-12 for v in p) and abs(l - math.log(2)) < 1e-12
    p, l = f([1000.0, 1001.0, 1002.0], 0)
    want = [math.exp(-2) / (1 + math.exp(-1) + math.exp(-2)), math.exp(-1) / (1 + math.exp(-1) + math.exp(-2)), 1 / (1 + math.exp(-1) + math.exp(-2))]
    assert all(abs(a - b) < 1e-9 for a, b in zip(p, want)) and abs(l + math.log(want[0])) < 1e-9
    p, l = f([-5.0, 3.0], 1); assert abs(sum(p) - 1) < 1e-12 and l < 0.001
''')


HOLDOUT_START = len(T)   # tasks below: held out, written before the numeric kit was first measured
add("zscore","standardize",'''
def standardize(X: list) -> list:
    """Standardize each column of X (list of rows) to zero mean and unit variance, using the population
    standard deviation (divide by n). A column with zero variance becomes all zeros. Return new rows.
    >>> standardize([[1, 5], [3, 5]])
    [[-1.0, 0.0], [1.0, 0.0]]
    """
''','''    n = len(X); cols = list(zip(*X)); out_cols = []
    for c in cols:
        m = sum(c) / n; sd = (sum((v - m) ** 2 for v in c) / n) ** 0.5
        out_cols.append([(v - m) / sd if sd else 0.0 for v in c])
    return [list(r) for r in zip(*out_cols)]
''','''
def check(f):
    assert f([[1, 5], [3, 5]]) == [[-1.0, 0.0], [1.0, 0.0]]
    r = f([[1, 10], [2, 20], [3, 60]]); import math
    assert all(abs(a - b) < 1e-9 for a, b in zip([row[0] for row in r], [-math.sqrt(1.5), 0.0, math.sqrt(1.5)]))
    assert abs(sum(row[1] for row in r)) < 1e-9 and abs(sum(row[1] ** 2 for row in r) / 3 - 1) < 1e-9
''')
add("covariance","cov_matrix",'''
def cov_matrix(X: list) -> list:
    """Sample covariance matrix of the columns of X (list of rows), dividing by n - 1.
    >>> cov_matrix([[1, 2], [3, 6]])
    [[2.0, 4.0], [4.0, 8.0]]
    """
''','''    n = len(X); p = len(X[0]); m = [sum(r[j] for r in X) / n for j in range(p)]
    return [[sum((r[i] - m[i]) * (r[j] - m[j]) for r in X) / (n - 1) for j in range(p)] for i in range(p)]
''','''
def check(f):
    assert f([[1, 2], [3, 6]]) == [[2.0, 4.0], [4.0, 8.0]]
    c = f([[2, 0, 1], [4, 2, 1], [6, 1, 4]])
    want = [[4.0, 1.0, 3.0], [1.0, 1.0, 0.0], [3.0, 0.0, 3.0]]
    assert all(abs(a - b) < 1e-9 for r, s in zip(c, want) for a, b in zip(r, s)), c
''')
add("r2","r2_score",'''
def r2_score(y_true: list, y_pred: list) -> float:
    """Coefficient of determination R^2 = 1 - SS_res / SS_tot. If SS_tot is 0, return 1.0 when the
    predictions are exact and 0.0 otherwise.
    >>> r2_score([1, 2, 3], [1, 2, 3])
    1.0
    """
''','''    m = sum(y_true) / len(y_true)
    ss_res = sum((a - b) ** 2 for a, b in zip(y_true, y_pred)); ss_tot = sum((a - m) ** 2 for a in y_true)
    if ss_tot == 0: return 1.0 if ss_res == 0 else 0.0
    return 1 - ss_res / ss_tot
''','''
def check(f):
    assert f([1, 2, 3], [1, 2, 3]) == 1.0
    assert abs(f([3, -0.5, 2, 7], [2.5, 0.0, 2, 8]) - 0.9486081370449679) < 1e-12
    assert f([5, 5], [5, 5]) == 1.0 and f([5, 5], [4, 6]) == 0.0
''')
add("polyfit","poly_fit",'''
def poly_fit(xs: list, ys: list, degree: int) -> list:
    """Least-squares polynomial fit. Return coefficients [c0, c1, ..., c_degree] for
    y = c0 + c1*x + ... + c_degree*x**degree, computed without numpy.
    >>> [round(c, 6) + 0 for c in poly_fit([0, 1, 2, 3], [1, 2, 5, 10], 2)]
    [1.0, 0.0, 1.0]
    """
''','''    p = degree + 1; A = [[x ** k for k in range(p)] for x in xs]
    M = [[sum(a[i] * a[j] for a in A) for j in range(p)] + [sum(a[i] * y for a, y in zip(A, ys))] for i in range(p)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(M[r][c])); M[c], M[piv] = M[piv], M[c]
        for r in range(p):
            if r != c:
                f = M[r][c] / M[c][c]; M[r] = [a - f * b for a, b in zip(M[r], M[c])]
    return [M[i][p] / M[i][i] for i in range(p)]
''','''
def check(f):
    c = f([0, 1, 2, 3], [1, 2, 5, 10], 2); assert all(abs(a - b) < 1e-6 for a, b in zip(c, [1, 0, 1]))
    xs = [-2, -1, 0, 1, 2, 3]; ys = [2 - x + 0.5 * x ** 3 for x in xs]
    c = f(xs, ys, 3); assert len(c) == 4 and all(abs(a - b) < 1e-6 for a, b in zip(c, [2, -1, 0, 0.5]))
    c = f([0, 1, 2], [1, 3, 5], 1); assert all(abs(a - b) < 1e-9 for a, b in zip(c, [1, 2]))
''')
add("analogy","analogy",'''
def analogy(emb: dict, a: str, b: str, c: str) -> str:
    """Word analogy "a is to b as c is to ?": the word whose vector has the highest cosine similarity to
    emb[b] - emb[a] + emb[c], excluding a, b and c (ties: alphabetical order).
    >>> analogy({"man": [1, 0], "king": [1, 1], "woman": [0, 0.1], "queen": [0, 1.1], "apple": [5, -5]}, "man", "king", "woman")
    'queen'
    """
''','''    t = [y - x + z for x, y, z in zip(emb[a], emb[b], emb[c])]
    def cos(u, v):
        return sum(p * q for p, q in zip(u, v)) / ((sum(p * p for p in u) ** 0.5) * (sum(q * q for q in v) ** 0.5))
    return sorted((-cos(v, t), w) for w, v in emb.items() if w not in (a, b, c))[0][1]
''','''
def check(f):
    e = {"man": [1, 0], "king": [1, 1], "woman": [0, 0.1], "queen": [0, 1.1], "apple": [5, -5]}
    assert f(e, "man", "king", "woman") == "queen"
    e = {"paris": [1, 0, 1], "france": [1, 0, 0], "tokyo": [0, 1, 1], "japan": [0, 1, 0], "rome": [0.5, 0.5, 1]}
    assert f(e, "france", "paris", "japan") == "tokyo"
''')
add("kfold","kfold_indices",'''
def kfold_indices(n: int, k: int) -> list:
    """Split indices 0..n-1 into k contiguous folds; the first n % k folds get one extra index. Return a
    list of (train_indices, test_indices) pairs, one per fold, each list sorted.
    >>> kfold_indices(5, 2)
    [([3, 4], [0, 1, 2]), ([0, 1, 2], [3, 4])]
    """
''','''    sizes = [n // k + (1 if i < n % k else 0) for i in range(k)]; out = []; start = 0
    for s in sizes:
        test = list(range(start, start + s)); out.append(([i for i in range(n) if i < start or i >= start + s], test)); start += s
    return out
''','''
def check(f):
    assert f(5, 2) == [([3, 4], [0, 1, 2]), ([0, 1, 2], [3, 4])]
    r = f(10, 3); assert [len(t) for _, t in r] == [4, 3, 3] and r[1] == ([0, 1, 2, 3, 7, 8, 9], [4, 5, 6])
    assert f(3, 3) == [([1, 2], [0]), ([0, 2], [1]), ([0, 1], [2])]
''')

py = sys.argv[1]; out = sys.argv[2]; ok = 0
for t in T:
    prog = t["prompt"] + t["canonical_solution"] + "\n" + t["test"] + f"\ncheck({t['entry_point']})\n"
    r = subprocess.run([py, "-I", "-c", prog], capture_output=True, text=True, timeout=30)
    print(("OK  " if r.returncode == 0 else "BAD ") + t["task_id"], r.stderr.strip().splitlines()[-1:] if r.returncode else "")
    ok += r.returncode == 0
    # doctest examples must hold too
    r2 = subprocess.run([py, "-I", "-c", t["prompt"] + t["canonical_solution"] + "\nimport doctest, sys\nsys.exit(doctest.testmod().failed)\n"], capture_output=True, text=True, timeout=30)
    if r2.returncode: print("   doctest BAD", t["task_id"], r2.stdout[-300:])
print(ok, "/", len(T))
if ok == len(T):
    with open(out, "w") as f:
        for t in T[:HOLDOUT_START]: f.write(json.dumps(t, ensure_ascii=False) + "\n")
    with open(out.replace(".jsonl", "-holdout.jsonl"), "w") as f:
        for t in T[HOLDOUT_START:]: f.write(json.dumps(t, ensure_ascii=False) + "\n")
