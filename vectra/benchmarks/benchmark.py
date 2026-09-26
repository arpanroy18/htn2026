"""Recall / latency / memory benchmark: flat vs HNSW vs quantized variants.

    python benchmarks/benchmark.py [--n 20000] [--dim 384] [--queries 200] [--k 10]
"""

from __future__ import annotations

import argparse
import sys
import time
import tracemalloc
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vectra import VectorIndex  # noqa: E402
from vectra.flat import exact_topk  # noqa: E402


def bench(idx: VectorIndex, queries: np.ndarray, k: int):
    lat = []
    results = []
    for q in queries:
        t = time.perf_counter()
        results.append(idx.search(q, k=k))
        lat.append((time.perf_counter() - t) * 1e3)
    lat = np.asarray(lat)
    qps = len(queries) / (lat.sum() / 1e3)
    return results, qps, np.percentile(lat, 50), np.percentile(lat, 99)


def recall(results, truths, ids):
    hits = tot = 0
    for res, tr in zip(results, truths):
        hits += len({r[0] for r in res} & {ids[int(i)] for i in tr})
        tot += len(tr)
    return hits / tot


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20000)
    ap.add_argument("--dim", type=int, default=384)
    ap.add_argument("--queries", type=int, default=200)
    ap.add_argument("--k", type=int, default=10)
    args = ap.parse_args()

    rng = np.random.default_rng(0)
    # clustered data is more representative than pure noise
    centers = rng.normal(size=(64, args.dim)).astype(np.float32)
    vecs = centers[rng.integers(0, 64, args.n)] + 0.15 * rng.normal(
        size=(args.n, args.dim)).astype(np.float32)
    queries = centers[rng.integers(0, 64, args.queries)] + 0.15 * rng.normal(
        size=(args.queries, args.dim)).astype(np.float32)
    ids = [f"v{i}" for i in range(args.n)]

    print(f"dataset: {args.n}x{args.dim}, {args.queries} queries, k={args.k}")

    print("computing exact ground truth ...")
    truth = np.stack([exact_topk(vecs, q, args.k, "cosine") for q in queries])

    rows = []
    for name, kw in [
        ("flat",          dict(index="flat")),
        ("hnsw",          dict(index="hnsw", M=16, ef_construction=200)),
        ("hnsw+scalar",   dict(index="hnsw", quantization="scalar")),
        ("hnsw+pq",       dict(index="hnsw", quantization="product",
                               n_sub=8, n_clusters=64)),
    ]:
        tracemalloc.start()
        t0 = time.time()
        idx = VectorIndex(args.dim, metric="cosine", seed=0, **kw)
        idx.add(ids, vecs)
        build_t = time.time() - t0
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        results, qps, p50, p99 = bench(idx, queries, args.k)
        rows.append((name, qps, p50, p99, recall(results, truth, ids),
                     build_t, peak / 1e6))

    print(f"\n{'config':<14}{'QPS':>9}{'p50 ms':>9}{'p99 ms':>9}"
          f"{'recall':>9}{'build s':>9}{'MB (py)':>10}")
    for name, qps, p50, p99, rec, bt, mem in rows:
        print(f"{name:<14}{qps:>9.0f}{p50:>9.2f}{p99:>9.2f}{rec:>9.3f}"
              f"{bt:>9.1f}{mem:>10.1f}")


if __name__ == "__main__":
    main()
