"""Per-document metadata storage and a small inverted index for filtering.

A filter is a dict mapping field -> expected value (scalar) or a callable
``value -> bool``. Multiple fields are ANDed together.
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any, Callable, Dict, Iterable, List, Optional, Set

Filter = Dict[str, Any]


class MetadataStore:
    def __init__(self) -> None:
        self._docs: List[Optional[Dict[str, Any]]] = []
        # field -> value -> set of row ids; only scalar values are indexed.
        self._index: Dict[str, Dict[Any, Set[int]]] = defaultdict(lambda: defaultdict(set))

    def __len__(self) -> int:
        return len(self._docs)

    @staticmethod
    def _scalar(v: Any) -> bool:
        return isinstance(v, (str, int, float, bool)) or v is None

    def add(self, row: int, metadata: Optional[Dict[str, Any]]) -> None:
        while row >= len(self._docs):
            self._docs.append(None)
        self._docs[row] = metadata or {}
        for field, value in self._docs[row].items():
            if self._scalar(value):
                self._index[field][value].add(row)

    def get(self, row: int) -> Dict[str, Any]:
        return dict(self._docs[row] or {})

    def remove(self, row: int) -> None:
        if row >= len(self._docs) or self._docs[row] is None:
            return
        for field, value in self._docs[row].items():
            if self._scalar(value):
                self._index[field][value].discard(row)
        self._docs[row] = None

    def match_rows(self, flt: Optional[Filter]) -> Optional[Set[int]]:
        """Rows matching the filter, or None when no filter is given.

        Scalar equality terms use the inverted index; callable terms and
        fields absent from the index fall back to scanning the matched set.
        """
        if not flt:
            return None
        rows: Optional[Set[int]] = None
        deferred: List[tuple] = []
        for field, expected in flt.items():
            if callable(expected):
                deferred.append((field, expected))
                continue
            bucket = set(self._index.get(field, {}).get(expected, ()))
            rows = bucket if rows is None else rows & bucket
        if rows is None:
            rows = {r for r, d in enumerate(self._docs) if d is not None}
        for field, pred in deferred:
            rows = {r for r in rows if pred((self._docs[r] or {}).get(field))}
        return rows

    # --- serialization -----------------------------------------------------

    def to_json(self) -> bytes:
        return json.dumps(self._docs).encode("utf-8")

    @classmethod
    def from_json(cls, data: bytes) -> "MetadataStore":
        store = cls()
        for row, doc in enumerate(json.loads(data)):
            store.add(row, doc)
        return store
