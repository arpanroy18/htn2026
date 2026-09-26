"""Public index API: VectorIndex facade over flat and HNSW backends."""

from __future__ import annotations

import asyncio
import math
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from . import distance as dist
from .hnsw import HNSW
from .metadata import MetadataStore
from .quantization import ProductQuantizer, ScalarQuantizer
from . import storage

SearchResult = Tuple[str, float]  # (id, distance — smaller is closer)

_EXECUTOR = ThreadPoolExecutor(max_workers=max(4, (os.cpu_count() or 4)))


class VectorIndex:
    """A vector index supporting brute-force or HNSW search.

    Parameters
    ----------
    dimension : int
        Vector dimensionality; all added vectors must match.
    metric : {"cosine", "l2", "dot"}
        Similarity metric. Results are returned as distances (smaller =
        closer); for ``dot`` the distance is the negated inner product.
    index : {"flat", "hnsw"}
        ``flat`` is exact brute-force search; ``hnsw`` is approximate.
    M, ef_construction : HNSW build parameters.
    quantization : {None, "scalar", "product"}
        When set, vectors are stored as compressed codes and the index is
        built over their dequantized approximations.
    n_sub, n_clusters : product-quantizer parameters.
    """

    def __init__(
        self,
        dimension: int,
        metric: str = "cosine",
        index: str = "flat",
        M: int = 16,
        ef_construction: int = 200,
        ef_search: int = 100,
        quantization: Optional[str] = None,
        n_sub: int = 8,
        n_clusters: int = 256,
        seed: Optional[int] = None,
    ) -> None:
        if index not in ("flat", "hnsw"):
            raise ValueError("index must be 'flat' or 'hnsw'")
        if quantization not in (None, "scalar", "product"):
            raise ValueError("quantization must be None, 'scalar' or 'product'")
        self.dim = dimension
        self.metric = metric
        self.index_type = index
        self.ef_search = ef_search
        self.seed = seed
        self._hnsw_args = dict(M=M, ef_construction=ef_construction)
        self.quantization = quantization
        self._pq_args = dict(n_sub=n_sub, n_clusters=n_clusters)

        self.ids: List[str] = []
        self._row_of: Dict[str, int] = {}
        self.metadata = MetadataStore()
        self.vectors = np.zeros((0, dimension), np.float32)   # decoded/original
        self.codes: Optional[np.ndarray] = None
        self._alive = np.zeros(0, bool)
        self._quantizer: Optional[object] = None
        self._graph: Optional[HNSW] = None
        if index == "hnsw":
            self._graph = HNSW(dimension, metric, M=M,
                               ef_construction=ef_construction, seed=seed)

    # ------------------------------------------------------------------ meta

    def __len__(self) -> int:
        return int(self._alive.sum())

    def __contains__(self, id: str) -> bool:
        return id in self._row_of

    def get(self, id: str) -> np.ndarray:
        return self.vectors[self._row_of[id]].copy()

    # ------------------------------------------------------------------- add

    def _check(self, vectors: np.ndarray) -> np.ndarray:
        v = np.asarray(vectors, dtype=np.float32)
        if v.ndim == 1:
            v = v.reshape(1, -1)
        if v.shape[1] != self.dim:
            raise ValueError(f"expected {self.dim}-D vectors, got {v.shape[1]}-D")
        return v

    def _fit_quantizer(self, v: np.ndarray) -> None:
        """Fit the quantizer once, on the first inserted batch."""
        if self.quantization is None or self._quantizer is not None:
            return
        if self.quantization == "scalar":
            self._quantizer = ScalarQuantizer(self.dim).fit(v)
        else:
            self._quantizer = ProductQuantizer(self.dim, seed=self.seed,
                                               **self._pq_args).fit(v)

    def add(
        self,
        ids: Sequence[str],
        vectors: np.ndarray,
        metadata: Optional[Sequence[Optional[Dict[str, Any]]]] = None,
    ) -> None:
        """Batch insert. ``ids`` must be unique within the call and the index."""
        v = self._check(vectors)
        ids = list(ids)
        if len(ids) != len(v):
            raise ValueError("ids and vectors must have equal length")
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate ids in batch")
        overlap = set(ids) & self._row_of.keys()
        if overlap:
            raise ValueError(f"ids already present: {sorted(overlap)[:5]}")
        metadata = metadata or [None] * len(ids)
        if len(metadata) != len(ids):
            raise ValueError("metadata length must match ids")

        self._fit_quantizer(v)
        if self._quantizer is not None:
            new_codes = self._quantizer.transform(v)
            stored = self._quantizer.inverse(new_codes)
            self.codes = new_codes if self.codes is None else np.vstack([self.codes, new_codes])
        else:
            stored = v

        start = len(self.ids)
        need = start + len(ids)
        if need > len(self.vectors):
            cap = max(64, 1 << int(math.ceil(math.log2(need))))
            grown = np.zeros((cap, self.dim), np.float32)
            grown[: len(self.ids)] = self.vectors[: len(self.ids)]
            self.vectors = grown
            self._alive = np.concatenate(
                [self._alive, np.zeros(cap - len(self._alive), bool)])
        self.vectors[start:need] = stored
        self._alive[start:need] = True

        for i, (id_, meta) in enumerate(zip(ids, metadata)):
            row = start + i
            self.ids.append(id_)
            self._row_of[id_] = row
            self.metadata.add(row, meta)
            if self._graph is not None:
                self._graph.add(row, self.vectors[row])

    # ---------------------------------------------------------------- search

    def _predicate(self, flt: Optional[Dict[str, Any]]):
        if flt is None:
            return None
        rows = self.metadata.match_rows(flt)
        return lambda r: r in rows

    def search(
        self,
        query: np.ndarray,
        k: int = 10,
        filter: Optional[Dict[str, Any]] = None,
        ef_search: Optional[int] = None,
    ) -> List[SearchResult]:
        """Top-k nearest neighbours, optionally restricted by metadata."""
        q = self._check(query)[0]
        pred = self._predicate(filter)
        if self._graph is not None:
            hits = self._graph.search(q, k, ef_search or self.ef_search, pred)
            return [(self.ids[r], d) for r, d in hits]
        mask = self._alive.copy()
        if pred is not None:
            keep = np.zeros(len(mask), bool)
            for r in self.metadata.match_rows(filter) or ():
                keep[r] = True
            mask &= keep
        rows = np.nonzero(mask[: len(self.ids)])[0]
        if not len(rows):
            return []
        d = dist.distance(self.metric, q, self.vectors[rows])
        top = rows[np.argsort(d)[:k]]
        return [(self.ids[r], float(dist.pairwise(self.metric, q, self.vectors[r])))
                for r in top]

    async def search_async(self, query: np.ndarray, k: int = 10, **kw) -> List[SearchResult]:
        return await asyncio.get_event_loop().run_in_executor(
            _EXECUTOR, lambda: self.search(query, k, **kw))

    def search_batch(self, queries: np.ndarray, k: int = 10, **kw) -> List[List[SearchResult]]:
        return list(_EXECUTOR.map(lambda q: self.search(q, k, **kw), queries))

    # -------------------------------------------------------------- deletion

    def delete(self, ids: Sequence[str]) -> int:
        """Remove ids (lazy deletion for HNSW). Returns the count removed."""
        removed = 0
        for id_ in ids:
            row = self._row_of.pop(id_, None)
            if row is None:
                continue
            self._alive[row] = False
            self.metadata.remove(row)
            if self._graph is not None:
                self._graph.mark_deleted(row)
            removed += 1
        return removed

    def rebuild(self) -> None:
        """Compact the index, physically dropping deleted vectors."""
        keep = [r for r in range(len(self.ids)) if self._alive[r]]
        if len(keep) == len(self.ids):
            return
        self.ids = [self.ids[r] for r in keep]
        self.vectors[: len(keep)] = self.vectors[keep]
        self._alive = np.zeros(len(self.vectors), bool)
        self._alive[: len(keep)] = True
        self._row_of = {id_: i for i, id_ in enumerate(self.ids)}
        if self.codes is not None:
            self.codes = self.codes[keep]
        docs = [self.metadata.get(r) for r in keep]
        self.metadata = MetadataStore()
        for i, doc in enumerate(docs):
            self.metadata.add(i, doc)
        if self._graph is not None:
            g = HNSW(self.dim, self.metric, seed=self.seed, **self._hnsw_args)
            for i in range(len(keep)):
                g.add(i, self.vectors[i])
            self._graph = g

    # ------------------------------------------------------------ persistence

    def save(self, path: str) -> None:
        """Write the index to ``path`` in vectra's ``.vdb`` format."""
        n = len(self.ids)
        sections = {
            "config": storage.encode_json({
                "dimension": self.dim, "metric": self.metric,
                "index": self.index_type, "ef_search": self.ef_search,
                "quantization": self.quantization, "seed": self.seed,
                **self._hnsw_args, **self._pq_args}),
            "ids": storage.encode_ids(self.ids),
            "vectors": storage.encode_vectors(self.vectors[:n]),
            "alive": np.packbits(self._alive[:n]).tobytes(),
            "metadata": self.metadata.to_json(),
        }
        if self.codes is not None:
            sections["codes"] = np.ascontiguousarray(self.codes).tobytes()
            sections["quantizer"] = storage.encode_json({
                "kind": self.quantization, "state": self._quantizer.state()})
        if self._graph is not None:
            sections["hnsw"] = storage.encode_json(self._graph.graph_state())
        storage.write(path, sections)

    @classmethod
    def load(cls, path: str) -> "VectorIndex":
        header, f = storage.read_sections(path)
        cfg = storage.decode_json(storage.read_section(f, header, "config"))
        idx = cls(cfg["dimension"], metric=cfg["metric"], index=cfg["index"],
                  ef_search=cfg["ef_search"], quantization=cfg["quantization"],
                  n_sub=cfg.get("n_sub", 8), n_clusters=cfg.get("n_clusters", 256),
                  M=cfg.get("M", 16), ef_construction=cfg.get("ef_construction", 200),
                  seed=cfg.get("seed"))
        idx.ids = storage.decode_ids(storage.read_section(f, header, "ids"))
        idx._row_of = {id_: i for i, id_ in enumerate(idx.ids)}
        idx.vectors = storage.decode_vectors(storage.read_section(f, header, "vectors"))
        n = len(idx.ids)
        alive = np.unpackbits(np.frombuffer(storage.read_section(f, header, "alive"),
                                          np.uint8))[:n]
        idx._alive = np.zeros(len(idx.vectors), bool)
        idx._alive[:n] = alive.astype(bool)
        idx.metadata = MetadataStore.from_json(storage.read_section(f, header, "metadata"))
        if "codes" in header:
            raw = np.frombuffer(storage.read_section(f, header, "codes"), np.uint8)
            q = storage.decode_json(storage.read_section(f, header, "quantizer"))
            if q["kind"] == "scalar":
                idx._quantizer = ScalarQuantizer.from_state(idx.dim, q["state"])
                idx.codes = raw.reshape(n, idx.dim)
            else:
                idx._quantizer = ProductQuantizer.from_state(idx.dim, q["state"])
                idx.codes = raw.reshape(n, idx._quantizer.n_sub)
        if "hnsw" in header and idx._graph is not None:
            idx._graph.vectors = idx.vectors
            idx._graph.load_graph_state(
                storage.decode_json(storage.read_section(f, header, "hnsw")))
        f.close()
        return idx

    @classmethod
    def mmap(cls, path: str) -> "VectorIndex":
        """Load an index with its vector block memory-mapped (flat search)."""
        header, f = storage.read_sections(path)
        cfg = storage.decode_json(storage.read_section(f, header, "config"))
        idx = cls(cfg["dimension"], metric=cfg["metric"], index="flat",
                  quantization=cfg["quantization"])
        idx.ids = storage.decode_ids(storage.read_section(f, header, "ids"))
        idx._row_of = {id_: i for i, id_ in enumerate(idx.ids)}
        idx.vectors = storage.load_vectors_mmap(path, header)
        n = len(idx.ids)
        alive = np.unpackbits(np.frombuffer(storage.read_section(f, header, "alive"),
                                          np.uint8))[:n]
        idx._alive = np.zeros(n, bool)
        idx._alive[:n] = alive.astype(bool)
        idx.metadata = MetadataStore.from_json(storage.read_section(f, header, "metadata"))
        f.close()
        return idx
