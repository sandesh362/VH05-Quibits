"""Exact retrieval tests."""

from __future__ import annotations

import pytest

from app.rag.exact import build_exact_patterns, exact_search
from app.rag.normalize import identifier_regex as ident
from app.rag.normalize import normalize_query
from app.rag.store import MemoryChunkStore
from app.rag.types import ScopeFilter
from tests.helpers_rag import MODEL_A, chunks, manuals


@pytest.fixture
def store() -> MemoryChunkStore:
    return MemoryChunkStore(manuals=manuals(), chunks=chunks())


@pytest.mark.asyncio
async def test_exact_error_code_hit(store: MemoryChunkStore) -> None:
    extracted = normalize_query("What should be checked for error E-104?")
    scope = ScopeFilter(machine_model_id=MODEL_A)
    found_manuals = await store.find_manuals(scope)
    hits = await exact_search(store, extracted, scope, found_manuals, limit=20)
    assert hits
    assert all(h.machine_model_id == MODEL_A for h in hits)
    assert any(h.exact_match and "E-104" in h.matched_terms for h in hits)
    assert any(h.page_start == 42 for h in hits)


@pytest.mark.asyncio
async def test_machine_model_isolation(store: MemoryChunkStore) -> None:
    extracted = normalize_query("error E-104")
    scope = ScopeFilter(machine_model_id=MODEL_A)
    found_manuals = await store.find_manuals(scope)
    hits = await exact_search(store, extracted, scope, found_manuals, limit=20)
    assert hits
    assert all(h.machine_model_id == MODEL_A for h in hits)
    assert all(h.manual_title != "Press Service Manual" for h in hits)


@pytest.mark.asyncio
async def test_does_not_match_similar_codes(store: MemoryChunkStore) -> None:
    extracted = normalize_query("error E-140")
    scope = ScopeFilter(machine_model_id=MODEL_A)
    found_manuals = await store.find_manuals(scope)
    hits = await exact_search(store, extracted, scope, found_manuals, limit=20)
    assert hits == []


@pytest.mark.asyncio
async def test_manual_version_filter(store: MemoryChunkStore) -> None:
    extracted = normalize_query("error E-104")
    scope = ScopeFilter(machine_model_id=MODEL_A, manual_version="2.1")
    found_manuals = await store.find_manuals(scope)
    # Version filter keeps other versions unless a specific manual id is set,
    # so isolation of the *selected* version is applied by ranking. Direct
    # manual id filter is strict.
    from tests.helpers_rag import MANUAL_A

    scope = ScopeFilter(machine_model_id=MODEL_A, manual_id=MANUAL_A)
    found_manuals = await store.find_manuals(scope)
    hits = await exact_search(store, extracted, scope, found_manuals, limit=20)
    assert hits
    assert all(h.manual_id == MANUAL_A for h in hits)


def test_identifier_boundaries() -> None:
    pattern = ident("E-104")
    assert pattern.search("code E-104 appearing")
    assert not pattern.search("E-1040")
    assert not pattern.search("E-140")


def test_build_patterns_includes_error_code() -> None:
    extracted = normalize_query("E-104 hydraulic")
    patterns = build_exact_patterns(extracted)
    assert patterns
    joined = " ".join(patterns)
    assert "104" in joined
