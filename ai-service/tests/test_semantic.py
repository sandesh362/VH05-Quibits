"""Semantic retrieval isolation and dimension-mismatch tests."""

from __future__ import annotations

import pytest

from app.rag.normalize import normalize_query
from app.rag.semantic import MemoryVectorIndex, semantic_search
from app.rag.store import MemoryChunkStore
from app.rag.types import ScopeFilter
from tests.helpers_rag import MODEL_A, MODEL_B, chunk_vector, chunks, manuals


def _index() -> MemoryVectorIndex:
    return MemoryVectorIndex([(c, chunk_vector(c)) for c in chunks()], dimension=4)


@pytest.mark.asyncio
async def test_semantic_respects_machine_model_filter() -> None:
    extracted = normalize_query("error E-104 hydraulic pressure")
    scope = ScopeFilter(machine_model_id=MODEL_A)
    store = MemoryChunkStore(manuals=manuals(), chunks=chunks())
    found = await store.find_manuals(scope)
    hits = await semantic_search(
        _index(),
        [1.0, 0.0, 0.0, 0.0],
        extracted,
        scope,
        found,
        limit=10,
        embedding_model="nomic-embed-text",
    )
    assert hits
    assert all(h.machine_model_id == MODEL_A for h in hits)
    assert all(h.machine_model_id != MODEL_B for h in hits)
    assert all("Press Service Manual" not in (h.manual_title or "") for h in hits)


@pytest.mark.asyncio
async def test_semantic_empty_when_no_manuals_in_scope() -> None:
    extracted = normalize_query("error E-104")
    scope = ScopeFilter(machine_model_id="ffffffffffffffffffffffff")
    hits = await semantic_search(
        _index(),
        [1.0, 0.0, 0.0, 0.0],
        extracted,
        scope,
        [],
        limit=10,
        embedding_model="nomic-embed-text",
    )
    assert hits == []
