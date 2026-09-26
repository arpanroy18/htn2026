"""Custom on-disk index format (``.vdb``).

Layout::

    ┌──────────────────────────────────────┐
    │ magic "VTRA" (4B) │ version u32      │
    │ section count u32                    │
    │ per section: name_len u8, name,      │
    │              offset u64, length u64  │
    ├──────────────────────────────────────┤
    │ "config"   JSON                      │
    │ "ids"      u32 count + utf-8 blobs   │
    │ "vectors"  u32 rows, u32 dim, f32[]  │
    │ "hnsw"     JSON graph state          │
    │ "metadata" JSON array                │
    │ "codes"    quantized codes           │
    │ "quantizer" JSON                     │
    └──────────────────────────────────────┘

``load_vectors_mmap`` exposes the vector block as an ``np.memmap`` so a large
index can be queried without reading every float into Python objects.
"""

from __future__ import annotations

import io
import json
import struct
from typing import BinaryIO, Dict, List, Tuple

import numpy as np

MAGIC = b"VTRA"
VERSION = 1
Header = Dict[str, Tuple[int, int]]  # section -> (offset, length)


def write(path: str, sections: Dict[str, bytes]) -> None:
    entries = list(sections.items())
    table_len = sum(1 + len(n.encode()) + 16 for n, _ in entries)
    offset = 4 + 4 + 4 + table_len
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", VERSION, len(entries)))
        cursor = offset
        for name, payload in entries:
            nb = name.encode()
            f.write(struct.pack("<B", len(nb)) + nb)
            f.write(struct.pack("<QQ", cursor, len(payload)))
            cursor += len(payload)
        for _, payload in entries:
            f.write(payload)


def read_sections(path: str) -> Tuple[Header, BinaryIO]:
    f = open(path, "rb")
    if f.read(4) != MAGIC:
        raise ValueError(f"{path} is not a vectra index")
    version, count = struct.unpack("<II", f.read(8))
    if version != VERSION:
        raise ValueError(f"unsupported format version {version}")
    header: Header = {}
    for _ in range(count):
        (nlen,) = struct.unpack("<B", f.read(1))
        name = f.read(nlen).decode()
        off, length = struct.unpack("<QQ", f.read(16))
        header[name] = (off, length)
    return header, f


def read_section(f: BinaryIO, header: Header, name: str) -> bytes:
    off, length = header[name]
    f.seek(off)
    return f.read(length)


def encode_ids(ids: List[str]) -> bytes:
    out = io.BytesIO()
    blobs = [i.encode("utf-8") for i in ids]
    out.write(struct.pack("<I", len(blobs)))
    for b in blobs:
        out.write(struct.pack("<I", len(b)))
        out.write(b)
    return out.getvalue()


def decode_ids(data: bytes) -> List[str]:
    bio = io.BytesIO(data)
    (count,) = struct.unpack("<I", bio.read(4))
    ids = []
    for _ in range(count):
        (l,) = struct.unpack("<I", bio.read(4))
        ids.append(bio.read(l).decode("utf-8"))
    return ids


def encode_vectors(vectors: np.ndarray) -> bytes:
    v = np.ascontiguousarray(vectors, dtype=np.float32)
    return struct.pack("<II", v.shape[0], v.shape[1]) + v.tobytes()


def decode_vectors(data: bytes) -> np.ndarray:
    rows, dim = struct.unpack("<II", data[:8])
    return np.frombuffer(data, dtype=np.float32, offset=8, count=rows * dim).reshape(rows, dim).copy()


def load_vectors_mmap(path: str, header: Header) -> np.ndarray:
    """Memory-map the vector section; returns a read-only (rows, dim) array."""
    off, _ = header["vectors"]
    rows, dim = struct.unpack("<II", np.memmap(path, dtype=np.uint8, mode="r",
                                             offset=off, shape=(8,)).tobytes()[:8])
    return np.memmap(path, dtype=np.float32, mode="r", offset=off + 8,
                     shape=(rows, dim))


def encode_json(obj) -> bytes:
    return json.dumps(obj).encode("utf-8")


def decode_json(data: bytes):
    return json.loads(data)
