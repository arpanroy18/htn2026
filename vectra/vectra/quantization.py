"""Vector quantization: scalar (uint8) and product quantization.

Scalar quantization maps each dimension to 256 uniform bins fitted on the
training data — 4x smaller vectors with a small recall cost. Product
quantization splits vectors into ``n_sub`` sub-vectors and replaces each with
the index of its nearest of ``n_clusters`` learned centroids (trained with an
in-house Lloyd's-algorithm k-means).
"""

from __future__ import annotations

import json
from typing import Dict, Optional

import numpy as np


class ScalarQuantizer:
    def __init__(self, dim: int) -> None:
        self.dim = dim
        self.mins: Optional[np.ndarray] = None
        self.ranges: Optional[np.ndarray] = None

    def fit(self, vectors: np.ndarray) -> "ScalarQuantizer":
        v = np.asarray(vectors, dtype=np.float32)
        self.mins = v.min(axis=0)
        ranges = v.max(axis=0) - self.mins
        self.ranges = np.maximum(ranges, 1e-8)
        return self

    def transform(self, vectors: np.ndarray) -> np.ndarray:
        if self.mins is None:
            raise RuntimeError("quantizer is not fitted")
        v = (np.asarray(vectors, np.float32) - self.mins) / self.ranges
        return (np.clip(v, 0, 1) * 255).round().astype(np.uint8)

    def inverse(self, codes: np.ndarray) -> np.ndarray:
        return codes.astype(np.float32) / 255.0 * self.ranges + self.mins

    def state(self) -> Dict:
        return {"mins": self.mins.tolist(), "ranges": self.ranges.tolist()}

    @classmethod
    def from_state(cls, dim: int, state: Dict) -> "ScalarQuantizer":
        q = cls(dim)
        q.mins = np.asarray(state["mins"], np.float32)
        q.ranges = np.asarray(state["ranges"], np.float32)
        return q


def _kmeans(x: np.ndarray, k: int, iters: int, rng: np.random.Generator) -> np.ndarray:
    """Plain Lloyd's algorithm with k-means++-style greedy seeding."""
    n = len(x)
    k = min(k, n)
    # Seed: pick first at random, then greedily farthest-point sampling.
    first = rng.integers(n)
    centroids = [x[first]]
    d2 = np.sum((x - x[first]) ** 2, axis=1)
    for _ in range(k - 1):
        centroids.append(x[int(np.argmax(d2))])
        d2 = np.minimum(d2, np.sum((x - centroids[-1]) ** 2, axis=1))
    c = np.stack(centroids)
    for _ in range(iters):
        assign = np.argmin(((x[:, None, :] - c[None]) ** 2).sum(-1), axis=1)
        new = c.copy()
        for j in range(k):
            pts = x[assign == j]
            if len(pts):
                new[j] = pts.mean(axis=0)
        if np.allclose(new, c):
            break
        c = new
    return c


class ProductQuantizer:
    def __init__(self, dim: int, n_sub: int = 8, n_clusters: int = 256,
                 iters: int = 25, seed: Optional[int] = 0) -> None:
        if dim % n_sub != 0:
            raise ValueError(f"dimension {dim} not divisible by n_sub={n_sub}")
        self.dim, self.n_sub, self.n_clusters = dim, n_sub, n_clusters
        self.sub_dim = dim // n_sub
        self.iters, self.seed = iters, seed
        self.centroids: Optional[np.ndarray] = None  # (n_sub, n_clusters, sub_dim)

    def fit(self, vectors: np.ndarray) -> "ProductQuantizer":
        v = np.asarray(vectors, np.float32)
        rng = np.random.default_rng(self.seed)
        self.centroids = np.stack([
            _kmeans(v[:, s * self.sub_dim:(s + 1) * self.sub_dim],
                    self.n_clusters, self.iters, rng)
            for s in range(self.n_sub)
        ])
        return self

    def transform(self, vectors: np.ndarray) -> np.ndarray:
        if self.centroids is None:
            raise RuntimeError("quantizer is not fitted")
        v = np.asarray(vectors, np.float32).reshape(-1, self.n_sub, self.sub_dim)
        # distance to each centroid in each subspace
        d = ((v[:, :, None, :] - self.centroids[None]) ** 2).sum(-1)
        return np.argmin(d, axis=-1).astype(np.uint8 if self.n_clusters <= 256 else np.uint16)

    def inverse(self, codes: np.ndarray) -> np.ndarray:
        return self.centroids[np.arange(self.n_sub)[None, :], codes].reshape(-1, self.dim)

    def state(self) -> Dict:
        return {"centroids": self.centroids.tolist(), "n_sub": self.n_sub,
                "n_clusters": self.n_clusters}

    @classmethod
    def from_state(cls, dim: int, state: Dict) -> "ProductQuantizer":
        q = cls(dim, n_sub=state["n_sub"], n_clusters=state["n_clusters"])
        q.centroids = np.asarray(state["centroids"], np.float32)
        return q
