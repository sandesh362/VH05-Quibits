"""Evidence sufficiency, refusal and conflict tests."""

from __future__ import annotations

from app.rag.evidence import detect_conflicts, select_evidence
from app.rag.normalize import normalize_query
from app.rag.types import RetrievalHit, ScopeFilter
from tests.helpers_rag import MODEL_A, rag_runtime_config


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
        text="Error E-104. Set relief to 200 bar. Inspect filter A first.",
        content_hash="h1",
        chunk_index=0,
        exact_match=True,
        matched_terms=["E-104"],
        semantic_score=0.8,
        final_score=0.9,
        retrieval_source=["exact"],
    )
    base.update(kwargs)
    return RetrievalHit(**base)  # type: ignore[arg-type]


def test_sufficient_with_exact_match() -> None:
    extracted = normalize_query("error E-104")
    decision = select_evidence(
        [_hit()],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(),
    )
    assert decision.sufficient is True
    assert decision.status == "answered"
    assert decision.selected


def test_insufficient_when_nothing_relevant() -> None:
    extracted = normalize_query("error E-104")
    weak = _hit(
        exact_match=False,
        matched_terms=[],
        semantic_score=0.1,
        final_score=0.1,
        text="This chapter covers paint colours.",
    )
    decision = select_evidence(
        [weak],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(),
    )
    assert decision.sufficient is False
    assert decision.status == "insufficient_evidence"


def test_non_technical_question_is_refused_even_with_a_strong_semantic_hit() -> None:
    """A selected model must not make this a general-purpose chat assistant."""
    extracted = normalize_query("Tell me about Shah Rukh Khan")
    decision = select_evidence(
        [_hit(exact_match=False, matched_terms=[], semantic_score=0.99, final_score=0.99)],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(),
    )
    assert decision.sufficient is False
    assert decision.status == "insufficient_evidence"
    assert decision.selected == []
    assert decision.message is not None
    assert "No relevant evidence" in decision.message


def test_missing_metadata_rejected() -> None:
    extracted = normalize_query("error E-104")
    bare = _hit(manual_title="", page_start=0)
    decision = select_evidence(
        [bare],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(require_source_metadata=True),
    )
    assert decision.sufficient is False


def test_conflict_between_versions() -> None:
    extracted = normalize_query("error E-104")
    a = _hit(manual_id="m1", manual_version="2.1", text="Error E-104. Relief 200 bar.")
    b = _hit(
        chunk_id="c2",
        manual_id="m2",
        manual_version="1.0",
        page_start=18,
        page_end=18,
        is_current_version=False,
        text="Error E-104. Relief 250 bar.",
        content_hash="h2",
    )
    warnings = detect_conflicts([a, b], extracted)
    assert warnings
    decision = select_evidence(
        [a, b],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(),
    )
    # Current version wins; superseded disagreement is a warning.
    assert decision.status == "answered"
    assert decision.warnings
    both_current = select_evidence(
        [
            a,
            _hit(
                chunk_id="c2",
                manual_id="m2",
                manual_version="2.0",
                page_start=18,
                page_end=18,
                is_current_version=True,
                text="Error E-104. Relief 250 bar.",
                content_hash="h2",
            ),
        ],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(),
    )
    assert both_current.status == "conflicting_evidence"


def test_qdrant_down_without_exact_is_unavailable() -> None:
    extracted = normalize_query("the spindle is noisy at idle")
    decision = select_evidence(
        [],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(),
        semantic_available=False,
        qdrant_error="Qdrant is unreachable",
    )
    assert decision.status == "processing_unavailable"


def test_drops_other_machine_model() -> None:
    extracted = normalize_query("error E-104")
    leak = _hit(machine_model_id="other-model")
    decision = select_evidence(
        [leak],
        extracted,
        ScopeFilter(machine_model_id=MODEL_A),
        rag_runtime_config(),
    )
    assert decision.sufficient is False
