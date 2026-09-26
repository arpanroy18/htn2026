# vectra

A small vector-search library implemented from scratch in Python — brute-force
and HNSW approximate nearest-neighbour search, a custom memory-mapped
on-disk format, metadata filtering, and scalar/product quantization. No FAISS,
no ANN wrappers: the indexing and search algorithms are implemented here.

```python
from vectra import VectorIndex

index = VectorIndex(dimension=384, metric="cosine", index="hnsw")

index.add(
    ids=["doc1", "doc2", "doc3"],
    vectors=embeddings,                       # (n, dim) float32
    metadata=[{"year": 2026, "category": "finance"}, ...],
)

results = index.search(query_vector, k=10, filter={"year": 2026})
# -> [("doc1", 0.013), ("doc3", 0.041)]   (id, distance; smaller = closer)

index.save("index.vdb")
index = VectorIndex.load("index.vdb")
index = VectorIndex.mmap("index.vdb")        # low-memory, memory-mapped flat search
```

## Features

| Area | What you get |
| --- | --- |
| Metrics | cosine, Euclidean (`"l2"`), dot product — all on `float32` |
| Indexes | `flat` (exact brute force) and `hnsw` (own implementation: random level assignment, greedy layer descent, best-first beam search, heuristic neighbour selection, `M`/`ef_construction`/`ef_search`) |
| Operations | batch `add`, `search`, `delete` (lazy), `rebuild`, `get` |
| Filtering | `search(..., filter={"field": value})` — equality terms hit an inverted index, callables scan candidates |
| Quantization | `quantization="scalar"` (uint8, ~4x smaller) or `"product"` (learned k-means subquantizers) |
| Concurrency | `await index.search_async(...)`, `index.search_batch(...)` (thread pool) |
| Persistence | custom `.vdb` sectioned binary format; `VectorIndex.mmap()` maps vectors without loading them |
| CLI | `vectra build`, `vectra inspect`, `vectra benchmark` |

## HNSW parameters

```python
index = VectorIndex(384, index="hnsw", M=16, ef_construction=200, ef_search=100)
index.search(q, k=10, ef_search=400)  # per-query override
```

`ef_search` trades recall for latency; `M` and `ef_construction` trade build
time/memory for graph quality. `benchmarks/benchmark.py` measures the actual
recall ↔ latency ↔ memory tradeoff on clustered data.

## CLI

```bash
vectra build embeddings.npy --index hnsw --metric cosine -o index.vdb
vectra inspect index.vdb
vectra benchmark index.vdb --queries queries.npy --ground-truth truth.npy --k 10
```

## Development

```bash
cd vectra
pip install -e ".[dev]"
pytest
python benchmarks/benchmark.py --n 20000 --dim 384
```

## Layout

```
vectra/
├── vectra/
│   ├── index.py         # VectorIndex facade: add/search/delete/save/async
│   ├── hnsw.py          # HNSW graph, built and searched from scratch
│   ├── distance.py      # cosine / l2 / dot on float32
│   ├── flat.py          # exact top-k + recall helper
│   ├── quantization.py  # scalar + product quantizers (own k-means)
│   ├── metadata.py      # metadata store + inverted index filtering
│   ├── storage.py       # .vdb sectioned binary format + mmap loader
│   └── cli.py
├── tests/
├── benchmarks/
└── examples/
```

## File format

```
┌──────────────────────────────┐
│ magic "VTRA" + version       │
│ section table (name/off/len) │
├──────────────────────────────┤
│ config (JSON)                │
│ ids (len-prefixed utf-8)     │
│ vectors (rows, dim, f32)     │
│ alive bitmask                │
│ metadata (JSON)              │
│ codes + quantizer (optional) │
│ hnsw graph (JSON)            │
└──────────────────────────────┘
```
