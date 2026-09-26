"""vectra — a small vector-search library built from scratch.

Brute-force and HNSW approximate search over float32 vectors, with metadata
filtering, scalar/product quantization, mmap persistence and async queries.
"""

from .index import VectorIndex, SearchResult
from .hnsw import HNSW
from .quantization import ScalarQuantizer, ProductQuantizer
from . import distance

__version__ = "0.1.0"
__all__ = [
    "VectorIndex",
    "SearchResult",
    "HNSW",
    "ScalarQuantizer",
    "ProductQuantizer",
    "distance",
]
