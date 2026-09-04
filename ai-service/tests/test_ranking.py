"""Merge, dedup and ranking tests."""

from __future__ import annotations

from app.rag.normalize import normalize_query
from app.rag.ranking import merge_hits, rank_hits, token_jaccard
from app.rag.types import RankingWeights, RetrievalHit, ScopeFilter
from tests.helpers_rag import MODEL_A


def _hit(**kwargs: object) -> RetrievalHit:
    base = dict(
        chunk_id="c1",
        manual_id="m1",
        machine_model_id=MODEL_A,
        manual_title="Hydraulic Service Manual",
        manual_version="2.1",
        manual_type="service",
        manufacturer="Haas",
        page_start=42,
        page_end=43,
        section_title="Hydraulic Pressure Troubleshooting",
        section_path=["Hydraulics"],
        text="Error E-104 hydraulic pressure low during startup.",
        content_hash="h1",
        chunk_index=0,
    )
    base.update(kwargs)
    return RetrievalHit(**base)  # type: ignore[arg-type]


def test_merge_preserves_exact_and_semantic() -> None:
    exact = [_hit(exact_match=True, retrieval_source=["exact"], matched_terms=["E-104"])]
    semantic = [
        _hit(
            exact_match=False,
            retrieval_source=["semantic"],
            semantic_score=0.82,
            matched_terms=[],
        )
    ]
    merged = merge_hits(exact, semantic)
    assert len(merged) == 1
    hit = merged[0]
    assert hit.exact_match is True
    assert hit.semantic_score == 0.82
    assert "exact" in hit.retrieval_source and "semantic" in hit.retrieval_source
    assert "E-104" in hit.matched_terms


def test_dedup_by_content_hash() -> None:
    a = _hit(chunk_id="a", content_hash="same")
    b = _hit(chunk_id="b", content_hash="same", text="Error E-104 hydraulic pressure low during startup.")
    merged = merge_hits([a], [b])
    assert len(merged) == 1


def test_exact_match_outranks_semantic() -> None:
    extracted = normalize_query("error E-104")
    scope = ScopeFilter(machine_model_id=MODEL_A)
    exact = _hit(chunk_id="exact", exact_match=True, retrieval_source=["exact"], semantic_score=0.2)
    semantic = _hit(
        chunk_id="sem",
        content_hash="other",
        exact_match=False,
        retrieval_source=["semantic"],
        semantic_score=0.95,
        text="The conveyor lubrication schedule is weekly.",
    )
    ranked = rank_hits([semantic, exact], extracted, scope, RankingWeights())
    assert ranked[0].chunk_id == "exact"


def test_jaccard_near_duplicate() -> None:
    assert token_jaccard("one two three", "one two three") == 1.0
    assert token_jaccard("one two three", "four five six") == 0.0
