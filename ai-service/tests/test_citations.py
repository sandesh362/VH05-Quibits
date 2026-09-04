"""Citation construction and validation tests."""

from __future__ import annotations

from app.rag.citations import parse_model_json, sources_for_ids, validate_citations
from app.rag.context import sources_from_hits
from app.rag.prompt import format_answer_from_structured
from app.rag.ranking import assign_source_ids
from app.rag.types import RetrievalHit, SourceRef
from tests.helpers_rag import MODEL_A


def _hit() -> RetrievalHit:
    return RetrievalHit(
        chunk_id="m:0",
        manual_id="m",
        machine_model_id=MODEL_A,
        manual_title="Hydraulic Service Manual",
        manual_version="2.1",
        manual_type="service",
        manufacturer="Haas",
        page_start=42,
        page_end=43,
        section_title="Hydraulic Pressure Troubleshooting",
        section_path=["Hydraulics"],
        text="Error E-104. Check the suction strainer.",
        content_hash="h1",
        chunk_index=0,
        exact_match=True,
        source_id="source-1",
    )


def test_parse_fenced_json() -> None:
    raw = "```json\n{\"summary\": \"ok\", \"cited_source_ids\": [\"source-1\"]}\n```"
    parsed = parse_model_json(raw)
    assert parsed is not None
    assert parsed["summary"] == "ok"


def test_drops_invented_source_ids() -> None:
    hits = assign_source_ids([_hit()])
    refs = sources_from_hits(hits)
    payload = {
        "summary": "Invented citation",
        "cited_source_ids": ["source-99"],
        "likely_causes": ["magic"],
    }
    draft = format_answer_from_structured(payload, ["[Hydraulic Service Manual, version 2.1, pp. 42–43]"])
    cleaned, _text, report = validate_citations(payload, draft, refs, hits)
    assert report.valid is False
    assert "source-99" in report.dropped
    assert cleaned["cited_source_ids"] == []


def test_strips_invented_page_numbers() -> None:
    hits = assign_source_ids([_hit()])
    refs = sources_from_hits(hits)
    payload = {"summary": "See page 999.", "cited_source_ids": ["source-1"]}
    draft = "Summary\nSee page 999 for the procedure."
    _cleaned, text, report = validate_citations(payload, draft, refs, hits)
    assert report.repaired is True
    assert "999" not in text or report.page_mismatches == ["999"]
    assert "999" in report.page_mismatches


def test_accepts_valid_source_id() -> None:
    hits = assign_source_ids([_hit()])
    refs = sources_from_hits(hits)
    payload = {"summary": "Check the strainer.", "cited_source_ids": ["source-1"]}
    draft = format_answer_from_structured(payload, [refs[0].citation_label()])
    cleaned, _text, report = validate_citations(payload, draft, refs, hits)
    assert report.valid is True
    assert cleaned["cited_source_ids"] == ["source-1"]
    assert "Hydraulic Service Manual" in refs[0].citation_label()
    assert "p" in refs[0].citation_label().lower()


def test_sources_for_ids_falls_back_to_all() -> None:
    refs = [
        SourceRef(
            source_id="source-1",
            chunk_id="m:0",
            manual_id="m",
            manual_title="Hydraulic Service Manual",
            manual_version="2.1",
            page_start=42,
            page_end=43,
            section_title="Hydraulic Pressure Troubleshooting",
            machine_model_id=MODEL_A,
        )
    ]
    assert sources_for_ids([], refs) == refs
    assert sources_for_ids(["source-1"], refs) == refs
