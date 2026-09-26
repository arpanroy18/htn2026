"""HNSW (Hierarchical Navigable Small World) index, implemented from scratch.

Follows Malkov & Yashunin (2016): a layered proximity graph where each node
appears on every layer up to a randomly drawn level. Insertion searches the
current graph top-down and links each layer to a diverse set of neighbours;
queries greedy-descend to layer 0 and then run a best-first beam search of
width ``ef_search``.
"""

from __future__ import annotations

import heapq
import math
import random
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np

from . import distance as dist

Predicate = Optional[Callable[[int], bool]]


def _level_for(rng: random.Random, level_mult: float) -> int:
    return int(-math.log(rng.random() + 1e-12) * level_mult)


class HNSW:
    def __init__(
        self,
        dim: int,
        metric: str = "cosine",
        M: int = 16,
        ef_construction: int = 200,
        seed: Optional[int] = None,
        select_heuristic: bool = True,
    ) -> None:
        self.dim = dim
        self.metric = metric
        self.M = M
        self.maxM0 = 2 * M  # layer 0 is denser in the reference design
        self.ef_construction = ef_construction
        self.level_mult = 1.0 / math.log(M)
        self.select_heuristic = select_heuristic
        self._rng = random.Random(seed)

        self.vectors = np.zeros((0, dim), dtype=np.float32)
        self._alive = np.zeros(0, dtype=bool)
        self.levels: List[int] = []
        self.links: List[List[List[int]]] = []  # row -> layer -> neighbour rows
        self.entry: int = -1
        self.max_level: int = -1

    # ------------------------------------------------------------------ util

    def __len__(self) -> int:
        return int(self._alive.sum())

    @property
    def capacity(self) -> int:
        return len(self.vectors)

    def _dist(self, q: np.ndarray, row: int) -> float:
        return dist.pairwise(self.metric, q, self.vectors[row])

    def _dists(self, q: np.ndarray, rows: Sequence[int]) -> np.ndarray:
        return dist.distance(self.metric, q, self.vectors[np.asarray(rows, dtype=np.int64)])

    def _grow(self, n: int) -> None:
        add = n - len(self.vectors)
        if add <= 0:
            return
        cap = max(64, 1 << max(int(math.ceil(math.log2(n))), 6))
        self.vectors = np.vstack([self.vectors, np.zeros((cap - len(self.vectors), self.dim), np.float32)])
        self._alive = np.concatenate([self._alive, np.zeros(cap - len(self._alive), bool)])

    # ------------------------------------------------------------- insertion

    def add(self, row: int, vector: np.ndarray) -> int:
        """Insert ``vector`` as graph node ``row``. Returns the assigned level."""
        self._grow(row + 1)
        self.vectors[row] = vector
        self._alive[row] = True
        level = _level_for(self._rng, self.level_mult)
        self.levels.append(level)
        self.links.append([[] for _ in range(level + 1)])

        if self.entry == -1:
            self.entry, self.max_level = row, level
            return level

        ep = self.entry
        # Greedy descent on layers above the new node's top.
        for layer in range(self.max_level, level, -1):
            ep = self._greedy_layer(vector, ep, layer)

        for layer in range(min(level, self.max_level), -1, -1):
            cands = self._search_layer(vector, [ep], self.ef_construction, layer)
            maxM = self.maxM0 if layer == 0 else self.M
            neighbours = self._select(vector, cands, maxM, layer)
            self.links[row][layer] = neighbours
            for nb in neighbours:
                nbs = self.links[nb][layer]
                if len(nbs) < maxM:
                    nbs.append(row)
                else:
                    # Re-select including the new node, keeping the best maxM.
                    merged = nbs + [row]
                    self.links[nb][layer] = self._select(
                        self.vectors[nb],
                        [(self._dist(self.vectors[nb], r), r) for r in merged],
                        maxM,
                        layer,
                    )
            if cands:
                ep = min(cands)[1]

        if level > self.max_level:
            self.entry, self.max_level = row, level
        return level

    # --------------------------------------------------------------- search

    def _greedy_layer(self, q: np.ndarray, ep: int, layer: int) -> int:
        best, best_d = ep, self._dist(q, ep)
        improved = True
        while improved:
            improved = False
            nbs = [nb for nb in self.links[best][layer] if self._alive[nb]]
            if not nbs:
                break
            for nb, d in zip(nbs, self._dists(q, nbs)):
                if d < best_d:
                    best, best_d = nb, float(d)
                    improved = True
        return best

    def _search_layer(self, q: np.ndarray, eps: List[int], ef: int, layer: int) -> List[Tuple[float, int]]:
        """Best-first search; returns up to ``ef`` (distance, row) results."""
        visited: Set[int] = set()
        cand_heap: List[Tuple[float, int]] = []  # min-heap of candidates to expand
        res_heap: List[Tuple[float, int]] = []   # max-heap (via -d) of results
        for ep in eps:
            if ep < 0 or not self._alive[ep]:
                continue
            d = self._dist(q, ep)
            visited.add(ep)
            heapq.heappush(cand_heap, (d, ep))
            heapq.heappush(res_heap, (-d, ep))
        while cand_heap:
            d, r = heapq.heappop(cand_heap)
            worst = -res_heap[0][0]
            if d > worst and len(res_heap) >= ef:
                break
            new = [nb for nb in self.links[r][layer] if nb not in visited]
            visited.update(new)
            new = [nb for nb in new if self._alive[nb]]
            for nb, dnb in zip(new, self._dists(q, new)):
                dnb = float(dnb)
                worst = -res_heap[0][0]
                if len(res_heap) < ef or dnb < worst:
                    heapq.heappush(cand_heap, (dnb, nb))
                    heapq.heappush(res_heap, (-dnb, nb))
                    if len(res_heap) > ef:
                        heapq.heappop(res_heap)
        out = [(-nd, r) for nd, r in res_heap]
        out.sort()
        return out

    def _select(self, q: np.ndarray, cands: List[Tuple[float, int]], maxM: int, layer: int) -> List[int]:
        """Neighbour selection.

        With ``select_heuristic`` (default) use the paper's diversity rule:
        keep a candidate only if it is closer to the query than to every
        already-picked neighbour — this keeps long-range edges. Otherwise take
        the ``maxM`` closest candidates.
        """
        if not self.select_heuristic:
            return [r for _, r in cands[:maxM]]
        picked: List[Tuple[float, int]] = []
        for d, r in sorted(cands):
            if len(picked) >= maxM:
                break
            d_to_picked = self._dists(self.vectors[r], [p for _, p in picked])
            if all(d <= float(dp) for dp in d_to_picked):
                picked.append((d, r))
        if len(picked) < maxM:  # heuristic under-filled; top up with nearest
            chosen = {r for _, r in picked}
            for d, r in sorted(cands):
                if len(picked) >= maxM:
                    break
                if r not in chosen:
                    picked.append((d, r))
                    chosen.add(r)
        return [r for _, r in picked]

    def search(self, query: np.ndarray, k: int, ef_search: Optional[int] = None,
               predicate: Predicate = None) -> List[Tuple[int, float]]:
        """Return [(row, distance)] for the k nearest live nodes satisfying
        ``predicate`` (row -> bool). Distance is in the index metric."""
        if self.entry == -1 or k <= 0:
            return []
        ef = max(ef_search or 100, k)
        q = np.asarray(query, dtype=np.float32)
        ep = self.entry
        for layer in range(self.max_level, 0, -1):
            ep = self._greedy_layer(q, ep, layer)
        cands = self._search_layer(q, [ep], ef, 0)
        out = []
        for d, r in cands:
            if predicate is None or predicate(r):
                out.append((r, float(d)))
                if len(out) == k:
                    break
        return out

    # -------------------------------------------------------------- deletion

    def mark_deleted(self, row: int) -> None:
        self._alive[row] = False

    def remap(self, keep_rows: List[int]) -> "HNSW":
        """Fresh graph built from ``keep_rows`` only (reindexing to 0..n-1)."""
        new = HNSW(self.dim, self.metric, self.M, self.ef_construction,
                   select_heuristic=self.select_heuristic)
        for i, r in enumerate(keep_rows):
            new.add(i, self.vectors[r])
        return new

    # --------------------------------------------------------- serialization

    def graph_state(self) -> Dict:
        return {
            "levels": self.levels,
            "links": [[list(l) for l in row] for row in self.links],
            "alive": self._alive[: len(self.levels)].tolist(),
            "entry": self.entry,
            "max_level": self.max_level,
            "M": self.M,
            "ef_construction": self.ef_construction,
            "metric": self.metric,
            "select_heuristic": self.select_heuristic,
        }

    def load_graph_state(self, state: Dict) -> None:
        self.levels = list(state["levels"])
        self.links = [[list(map(int, l)) for l in row] for row in state["links"]]
        n = len(self.levels)
        self._alive = np.zeros(len(self.vectors), bool)
        self._alive[:n] = np.asarray(state["alive"], bool)
        self.entry, self.max_level = int(state["entry"]), int(state["max_level"])
