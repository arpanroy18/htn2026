"""Exact (brute-force) search helpers — the recall reference for benchmarks."""

from __future__ import annotations

from typing import Collection, List, Sequence, Tuple

import numpy as np

from . import distance as dist


def exact_topk(vectors: np.ndarray, query: np.ndarray, k: int,
               metric: str = "cosine") -> np.ndarray:
    """Indices of the k nearest rows of ``vectors`` to ``query``."""
    d = dist.distance(metric, query, vectors)
    return np.argsort(d, kind="stable")[:k]


def recall_at_k(results: Sequence[Sequence[Tuple[str, float]]],
                ground_truth_ids: Sequence[Collection[str]]) -> float:
    """Fraction of true neighbour ids returned, averaged over queries."""
    hits, total = 0, 0
    for res, truth in zip(results, ground_truth_ids):
        got = {r[0] for r in res}
        hits += len(got & set(truth))
        total += len(truth)
    return hits / total if total else 0.0
