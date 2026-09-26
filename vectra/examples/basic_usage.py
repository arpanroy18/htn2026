import numpy as np

from vectra import VectorIndex

embeddings = np.random.default_rng(0).normal(size=(3, 384)).astype(np.float32)

index = VectorIndex(dimension=384, metric="cosine", index="hnsw")
index.add(
    ids=["doc1", "doc2", "doc3"],
    vectors=embeddings,
    metadata=[{"year": 2026, "category": "finance"},
              {"year": 2025, "category": "tech"},
              {"year": 2026, "category": "finance"}],
)

results = index.search(embeddings[0], k=2, filter={"category": "finance"})
print(results)

index.save("demo.vdb")
index2 = VectorIndex.load("demo.vdb")
print(index2.search(embeddings[1], k=2))
