"""Context assembly and size-limit tests."""

from __future__ import annotations

from app.rag.context import (
    clip_text_at_boundary,
    format_evidence_block,
    select_for_context,
    sources_from_hits,
)
from app.rag.ranking import assign_source_ids
from app.rag.types import RetrievalHit
from tests.helpers_rag import MODEL_A


def _hit(index: int, text: str, *, exact: bool = False, score: float = 0.5) -> RetrievalHit:
    return RetrievalHit(
        chunk_id=f"m:{index}",
        manual_id="m",
        machine_model_id=MODEL_A,
        manual_title="Hydraulic Service Manual",
        manual_version="2.1",
        manual_type="service",
        manufacturer="Haas",
        page_start=42 + index,
        page_end=42 + index,
        section_title="Hydraulic Pressure Troubleshooting",
        section_path=["Hydraulics"],
        text=text,
        content_hash=f"h{index}",
        chunk_index=index,
        exact_match=exact,
        final_score=score,
        retrieval_source=["exact"] if exact else ["semantic"],
    )


def test_format_includes_source_headers() -> None:
    hits = assign_source_ids([_hit(0, "Error E-104. Check the filter.", exact=True, score=0.9)])
    block = format_evidence_block(hits)
    assert "SOURCE_ID: source-1" in block
    assert "PAGES: 42" in block
    assert "<<<UNTRUSTED_DOCUMENT_CONTENT>>>" in block
    assert "E-104" in block


def test_context_prefers_exact_and_respects_budget() -> None:
    exact = _hit(0, "E-104 exact " + ("alpha " * 20), exact=True, score=0.4)
    filler = [_hit(i, "semantic filler " * 40, exact=False, score=0.9) for i in range(1, 8)]
    chosen = select_for_context([exact, *filler], max_chars=400)
    assert chosen[0].exact_match is True
    assert sum(len(h.text) for h in chosen) < 2000


def test_clip_at_paragraph() -> None:
    text = "First paragraph.\n\nSecond paragraph is longer and should be cut.\n\nThird."
    clipped = clip_text_at_boundary(text, 40)
    assert "First paragraph" in clipped
    assert not clipped.endswith("Third.")


def test_sources_from_hits() -> None:
    hits = assign_source_ids([_hit(0, "body", exact=True)])
    refs = sources_from_hits(hits)
    assert refs[0].source_id == "source-1"
    assert "Hydraulic Service Manual" in refs[0].citation_label()
    assert "p. 42" in refs[0].citation_label()
