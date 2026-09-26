import numpy as np
import pytest

from vectra import VectorIndex, distance
from vectra.flat import exact_topk, recall_at_k
from vectra.quantization import ScalarQuantizer, ProductQuantizer

rng = np.random.default_rng(42)
DIM = 64


def make(n=500, dim=DIM, seed=42):
    r = np.random.default_rng(seed)
    return r.normal(size=(n, dim)).astype(np.float32)


# ---- distances -------------------------------------------------------------

def test_cosine_and_l2_and_dot_match_naive():
    a, b = rng.normal(size=DIM), rng.normal(size=DIM)
    cos = 1 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b))
    assert abs(distance.pairwise("cosine", a, b) - cos) < 1e-5
    assert abs(distance.pairwise("l2", a, b) - np.linalg.norm(a - b)) < 1e-5
    assert abs(distance.pairwise("dot", a, b) - (-(a @ b))) < 1e-5


def test_bad_metric_raises():
    with pytest.raises(ValueError):
        distance.distance("manhattan", np.zeros(4), np.zeros((2, 4)))


# ---- flat index ------------------------------------------------------------

def test_flat_exact_topk():
    vecs = make()
    idx = VectorIndex(DIM, metric="l2", index="flat")
    idx.add([f"v{i}" for i in range(len(vecs))], vecs)
    q = vecs[7]
    res = idx.search(q, k=5)
    assert res[0][0] == "v7"
    truth = {f"v{r}" for r in exact_topk(vecs, q, 5, "l2")}
    assert {r[0] for r in res} == truth


def test_flat_sorted_and_duplicate_ids():
    vecs = make(20)
    idx = VectorIndex(DIM)
    idx.add(["a", "b"], vecs[:2])
    with pytest.raises(ValueError):
        idx.add(["a"], vecs[2:3])
    res = idx.search(vecs[10], k=10)
    ds = [d for _, d in res]
    assert ds == sorted(ds)


# ---- deletion / rebuild ----------------------------------------------------

def test_delete_and_rebuild():
    vecs = make(200)
    for index in ("flat", "hnsw"):
        idx = VectorIndex(DIM, index=index, metric="l2")
        idx.add([f"v{i}" for i in range(200)], vecs)
        assert idx.delete(["v0", "v1", "nope"]) == 2
        assert len(idx) == 198
        res = idx.search(vecs[0], k=3)
        assert "v0" not in {r[0] for r in res}
        idx.rebuild()
        assert len(idx) == 198 and len(idx.ids) == 198
        res2 = idx.search(vecs[5], k=3)
        assert res2[0][0] == "v5"


# ---- HNSW ------------------------------------------------------------------

def test_hnsw_high_recall():
    vecs = make(1200)
    idx = VectorIndex(DIM, metric="l2", index="hnsw", M=16,
                      ef_construction=200, seed=1)
    idx.add([f"v{i}" for i in range(len(vecs))], vecs)
    queries = make(30, seed=9)
    recs = []
    for q in queries:
        res = idx.search(q, k=10, ef_search=200)
        truth = {f"v{r}" for r in exact_topk(vecs, q, 10, "l2")}
        recs.append(len({r[0] for r in res} & truth) / 10)
    assert np.mean(recs) > 0.95


def test_hnsw_self_query_finds_self():
    vecs = make(300)
    idx = VectorIndex(DIM, index="hnsw", metric="cosine", seed=2)
    idx.add([f"v{i}" for i in range(300)], vecs)
    for i in [0, 100, 299]:
        assert idx.search(vecs[i], k=1)[0][0] == f"v{i}"


def test_hnsw_ef_tradeoff_monotoneish():
    vecs = make(800)
    idx = VectorIndex(DIM, index="hnsw", metric="l2", seed=3)
    idx.add([f"v{i}" for i in range(800)], vecs)
    qs = make(20, seed=5)

    def recall(ef):
        s = 0
        for q in qs:
            res = idx.search(q, k=10, ef_search=ef)
            truth = {f"v{r}" for r in exact_topk(vecs, q, 10, "l2")}
            s += len({r[0] for r in res} & truth)
        return s / (20 * 10)

    assert recall(200) >= recall(10) - 0.05


# ---- persistence -----------------------------------------------------------

@pytest.mark.parametrize("index", ["flat", "hnsw"])
def test_save_load_roundtrip(tmp_path, index):
    vecs = make(300)
    idx = VectorIndex(DIM, index=index, metric="cosine", seed=4)
    idx.add([f"v{i}" for i in range(300)], vecs,
            metadata=[{"cat": i % 3} for i in range(300)])
    p = str(tmp_path / "i.vdb")
    idx.save(p)
    idx2 = VectorIndex.load(p)
    assert len(idx2) == 300 and idx2.metric == "cosine"
    q = vecs[42]
    assert idx.search(q, k=5) == idx2.search(q, k=5)
    assert idx2.get("v42") == pytest.approx(vecs[42])
    res = idx2.search(q, k=5, filter={"cat": 0})
    assert all(int(r[0][1:]) % 3 == 0 for r in res)


def test_mmap_load(tmp_path):
    vecs = make(200)
    idx = VectorIndex(DIM, metric="l2")
    idx.add([f"v{i}" for i in range(200)], vecs)
    p = str(tmp_path / "i.vdb")
    idx.save(p)
    mi = VectorIndex.mmap(p)
    assert not mi.vectors.flags.writeable  # read-only memmap
    res = mi.search(vecs[3], k=4)
    assert res[0][0] == "v3"


# ---- metadata --------------------------------------------------------------

def test_metadata_filter_and_callable():
    vecs = make(200)
    idx = VectorIndex(DIM, metric="l2")
    idx.add([f"v{i}" for i in range(200)], vecs,
            metadata=[{"year": 2020 + i % 5, "lang": "en" if i % 2 else "fr"}
                      for i in range(200)])
    res = idx.search(vecs[0], k=200, filter={"year": 2022, "lang": "en"})
    assert res and all(int(r[0][1:]) % 5 == 2 and int(r[0][1:]) % 2 == 1
                       for r in res)
    res2 = idx.search(vecs[0], k=50, filter={"year": lambda y: y and y >= 2023})
    assert all(int(r[0][1:]) % 5 >= 3 for r in res2)


# ---- quantization ----------------------------------------------------------

def test_scalar_quantizer_roundtrip_shape():
    vecs = make(100)
    q = ScalarQuantizer(DIM).fit(vecs)
    codes = q.transform(vecs)
    assert codes.dtype == np.uint8 and codes.shape == (100, DIM)
    dec = q.inverse(codes)
    assert np.abs(dec - vecs).max() < 0.2  # bounded quantization error


def test_product_quantizer():
    vecs = make(400, dim=32)
    q = ProductQuantizer(32, n_sub=8, n_clusters=16, seed=0).fit(vecs)
    codes = q.transform(vecs)
    assert codes.shape == (400, 8) and codes.max() < 16
    dec = q.inverse(codes)
    assert np.linalg.norm(dec - vecs, axis=1).mean() < np.linalg.norm(vecs, axis=1).mean()


def test_quantized_index_search(tmp_path):
    vecs = make(500)
    for quant in ("scalar", "product"):
        idx = VectorIndex(DIM, metric="l2", quantization=quant,
                          n_sub=8, n_clusters=32)
        idx.add([f"v{i}" for i in range(500)], vecs)
        res = idx.search(vecs[10], k=5)
        assert len(res) == 5
        p = str(tmp_path / f"{quant}.vdb")
        idx.save(p)
        idx2 = VectorIndex.load(p)
        assert idx2.codes is not None
        assert idx2.search(vecs[10], k=5)


# ---- async / batch ---------------------------------------------------------

async def test_async_and_batch_search():
    vecs = make(200)
    idx = VectorIndex(DIM, metric="l2")
    idx.add([f"v{i}" for i in range(200)], vecs)
    res = await idx.search_async(vecs[9], k=3)
    assert res[0][0] == "v9"
    batch = idx.search_batch(vecs[:10], k=3)
    assert len(batch) == 10 and batch[4][0][0] == "v4"
