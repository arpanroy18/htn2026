"""vectra command line interface.

    vectra build embeddings.npy --index hnsw --metric cosine -o index.vdb
    vectra inspect index.vdb
    vectra benchmark index.vdb --queries queries.npy --k 10
"""

from __future__ import annotations

import argparse
import sys
import time

import numpy as np


def _cmd_build(args) -> int:
    from .index import VectorIndex
    vecs = np.load(args.embeddings).astype(np.float32)
    idx = VectorIndex(vecs.shape[1], metric=args.metric, index=args.index,
                      M=args.M, ef_construction=args.ef_construction,
                      quantization=args.quantization)
    ids = [f"vec{i}" for i in range(len(vecs))]
    t0 = time.time()
    idx.add(ids, vecs)
    idx.save(args.output)
    print(f"built {args.index} index over {len(vecs)}x{vecs.shape[1]} vectors "
          f"in {time.time() - t0:.2f}s -> {args.output}")
    return 0


def _cmd_inspect(args) -> int:
    from .index import VectorIndex
    idx = VectorIndex.load(args.index)
    print(f"index:      {idx.index_type}")
    print(f"metric:     {idx.metric}")
    print(f"dimension:  {idx.dim}")
    print(f"vectors:    {len(idx)} live / {len(idx.ids)} stored")
    print(f"quantized:  {idx.quantization or 'no'}")
    if idx._graph is not None:
        print(f"hnsw:       M={idx._graph.M} ef_construction={idx._graph.ef_construction} "
              f"max_level={idx._graph.max_level}")
    return 0


def _cmd_benchmark(args) -> int:
    from .index import VectorIndex
    from .flat import recall_at_k
    idx = VectorIndex.load(args.index)
    queries = np.load(args.queries).astype(np.float32)
    truth = None
    if args.ground_truth:
        # .npy of shape (n_queries, k) holding true-neighbour row indices
        truth_rows = np.load(args.ground_truth)
        truth = [{idx.ids[int(r)] for r in row} for row in truth_rows]
    lat = []
    t0 = time.time()
    results = []
    for q in queries:
        s = time.perf_counter()
        results.append(idx.search(q, k=args.k))
        lat.append((time.perf_counter() - s) * 1e3)
    total = time.time() - t0
    lat = np.asarray(lat)
    print(f"queries: {len(queries)}  k={args.k}")
    print(f"QPS:     {len(queries) / total:.0f}")
    print(f"p50:     {np.percentile(lat, 50):.2f}ms   p99: {np.percentile(lat, 99):.2f}ms")
    if truth is not None:
        rec = recall_at_k(results, truth)
        print(f"recall@{args.k}: {rec:.4f}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="vectra")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build an index from an .npy matrix")
    b.add_argument("embeddings")
    b.add_argument("-o", "--output", default="index.vdb")
    b.add_argument("--index", choices=["flat", "hnsw"], default="hnsw")
    b.add_argument("--metric", choices=["cosine", "l2", "dot"], default="cosine")
    b.add_argument("--quantization", choices=["scalar", "product"], default=None)
    b.add_argument("--M", type=int, default=16)
    b.add_argument("--ef-construction", type=int, default=200)
    b.set_defaults(fn=_cmd_build)

    i = sub.add_parser("inspect", help="print index stats")
    i.add_argument("index")
    i.set_defaults(fn=_cmd_inspect)

    m = sub.add_parser("benchmark", help="measure QPS/latency (and recall with ground truth)")
    m.add_argument("index")
    m.add_argument("--queries", required=True)
    m.add_argument("--ground-truth")
    m.add_argument("--k", type=int, default=10)
    m.set_defaults(fn=_cmd_benchmark)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
