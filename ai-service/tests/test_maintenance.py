"""Maintenance history lane tests (Phase 7 / roadmap Phase 8, AC-13).

The lane is deterministic end to end: parsing, days-before computation,
correlation strength, noted_by_manual part intersection, block formatting,
source refs, and citation validation. Crucially:

- maintenance is NEVER manual evidence;
- causal_claim is ALWAYS false;
- a causal statement supported only by maintenance must not survive
  citation validation (the lane's refs exist, but the rules live in the
  prompt - tested via build_messages).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.rag.citations import validate_citations
from app.rag.maintenance import (
    CORRELATION_MODERATE,
    CORRELATION_STRONG,
    CORRELATION_WEAK,
    build_maintenance_evidence,
    build_maintenance_source_refs,
    compute_correlation_strength,
    compute_days_before,
    correlate_noted_by_manual,
    format_maintenance_context_block,
    normalise_part_token,
    parse_maintenance_context,
)
from app.rag.prompt import build_messages
from app.rag.types import ExtractedQuery, RetrievalHit, ScopeFilter

QUERY_AT = "2026-09-04T09:00:00Z"


def _item(**overrides) -> dict:
    base = {
        "id": "maint-1",
        "maintenance_type": "part_replacement",
        "title": "Replaced suction strainer",
        "performed_at": "2026-08-20T09:00:00Z",
        "parts_replaced": [{"part_number": "strainer-88", "name": "Suction strainer"}],
        "related_incident_id": None,
    }
    base.update(overrides)
    return base


def _manual_hit(text: str, source_id: str = "source-1") -> RetrievalHit:
    return RetrievalHit(
        chunk_id="m:0",
        manual_id="m",
        machine_model_id="model-a",
        manual_title="Hydraulic Service Manual",
        manual_version="2.1",
        manual_type="service",
        manufacturer="Haas",
        page_start=42,
        page_end=43,
        section_title="Hydraulics",
        section_path=["Hydraulics"],
        text=text,
        content_hash="h1",
        chunk_index=0,
        exact_match=True,
        source_id=source_id,
    )


# --- Parsing ---------------------------------------------------------------


def test_parse_maintenance_context_tolerates_malformed_rows() -> None:
    raw = [_item(), {"id": "", "title": ""}, "not-a-dict", None, _item(id="maint-2")]
    items = parse_maintenance_context(raw)
    assert [i.id for i in items] == ["maint-1", "maint-2"]


def test_parse_maintenance_context_rejects_non_list() -> None:
    assert parse_maintenance_context(None) == []
    assert parse_maintenance_context({"id": "x"}) == []


# --- days_before_incident ---------------------------------------------------


def test_days_before_is_whole_days() -> None:
    days = compute_days_before("2026-08-20T09:00:00Z", QUERY_AT)
    assert days == 15


def test_days_before_never_negative() -> None:
    assert compute_days_before("2026-09-10T09:00:00Z", QUERY_AT) == 0


def test_days_before_bad_dates_fall_back_to_zero() -> None:
    assert compute_days_before("not-a-date", QUERY_AT) == 0
    assert compute_days_before("2026-08-20T09:00:00Z", None) >= 0


# --- correlation_strength ----------------------------------------------------


def test_correlation_strong_when_question_names_the_part() -> None:
    item = parse_maintenance_context([_item()])[0]
    strength = compute_correlation_strength(
        item, "The suction strainer keeps clogging - error E-104.", 90
    )
    assert strength == CORRELATION_STRONG


def test_correlation_moderate_for_recent_maintenance() -> None:
    item = parse_maintenance_context([_item()])[0]
    strength = compute_correlation_strength(item, "Hydraulic pressure drops.", 10)
    assert strength == CORRELATION_MODERATE


def test_correlation_weak_for_old_unrelated_maintenance() -> None:
    item = parse_maintenance_context([_item()])[0]
    strength = compute_correlation_strength(item, "Hydraulic pressure drops.", 200)
    assert strength == CORRELATION_WEAK


def test_part_token_normalisation() -> None:
    assert normalise_part_token(" ABC-123 ") == "ABC123"
    assert normalise_part_token("e-1042") == "E1042"


# --- noted_by_manual ---------------------------------------------------------


def test_noted_by_manual_matches_part_intersection() -> None:
    item = parse_maintenance_context([_item()])[0]
    hits = [_manual_hit("Replace the STRAINER-88 element every 500 hours.")]
    noted, source_id = correlate_noted_by_manual(item, hits)
    assert noted is True
    assert source_id == "source-1"


def test_noted_by_manual_is_false_without_intersection() -> None:
    item = parse_maintenance_context([_item()])[0]
    hits = [_manual_hit("Check the relief valve setting.")]
    noted, source_id = correlate_noted_by_manual(item, hits)
    assert noted is False
    assert source_id is None


# --- Full deterministic pipeline ----------------------------------------------


def test_evidence_pipeline_is_fully_deterministic_and_non_causal() -> None:
    items = parse_maintenance_context([_item(), _item(id="maint-2")])
    evidence = build_maintenance_evidence(items, QUERY_AT, "Strainer clogging.", [_manual_hit("STRAINER-88 replacement procedure.")])
    assert len(evidence) == 2
    for entry in evidence:
        assert entry.causal_claim is False
        assert entry.days_before_incident == 15
        assert entry.correlation_strength == CORRELATION_STRONG
        assert entry.noted_by_manual is True
        assert entry.noted_by_manual_source_id == "source-1"


def test_evidence_block_carries_required_fields() -> None:
    items = parse_maintenance_context([_item()])
    evidence = build_maintenance_evidence(items, QUERY_AT, "Strainer clogging.", [])
    block = format_maintenance_context_block(evidence)
    assert "15 days before" in block
    assert "correlation_strength=strong" in block
    assert "causal_claim=false" in block
    assert "STRAINER" not in block  # part numbers come from payload, normalised where needed
    assert "strainer-88" in block


# --- Source refs and citations -------------------------------------------------


def test_maintenance_source_refs_are_maint_numbered_and_pageless() -> None:
    items = parse_maintenance_context([_item()])
    evidence = build_maintenance_evidence(items, QUERY_AT, "q", [])
    refs = build_maintenance_source_refs(evidence)
    assert [r.source_id for r in refs] == ["maint-1"]
    assert refs[0].source_type == "maintenance"
    assert refs[0].page_start == 0 and refs[0].page_end == 0
    assert refs[0].causal_claim is False
    assert "non-causal" in refs[0].citation_label()


def test_citation_validation_accepts_maint_ids() -> None:
    items = parse_maintenance_context([_item()])
    evidence = build_maintenance_evidence(items, QUERY_AT, "q", [])
    refs = build_maintenance_source_refs(evidence)
    payload = {"summary": "A past service record exists.", "cited_source_ids": ["maint-1"]}
    cleaned, _text, report = validate_citations(payload, "Summary\\nA past service record exists.", refs, [])
    assert report.valid is True
    assert cleaned["cited_source_ids"] == ["maint-1"]


def test_prompt_keeps_maintenance_in_its_own_non_causal_section() -> None:
    items = parse_maintenance_context([_item()])
    evidence = build_maintenance_evidence(items, QUERY_AT, "q", [])
    block = format_maintenance_context_block(evidence)
    extracted = ExtractedQuery(
        original="q",
        normalized="q",
        error_codes=[],
        error_code_variants=[],
        part_numbers=[],
        model_numbers=[],
        units=[],
        technical_terms=[],
        component_names=[],
        symptoms=[],
        actions_attempted=[],
        operating_conditions=[],
        kind="general",
        requires_machine_scope=False,
    )
    messages = build_messages(
        extracted=extracted,
        scope=ScopeFilter(),
        evidence_block="[source-1] Manual evidence",
        allowed_source_ids=["source-1", "maint-1"],
        maintenance_block=block,
    )
    user = messages[1]["content"]
    assert "MAINTENANCE HISTORY" in user
    assert "NON-CAUSAL" in user
    # The maintenance block sits in its own section, never in RETRIEVED EVIDENCE.
    assert user.index("MAINTENANCE HISTORY") > user.index("RETRIEVED EVIDENCE")
    assert "maint-1" in user


def test_prompt_never_lets_maintenance_become_manual_evidence() -> None:
    # The lane id namespace guarantees the separation mechanically: maint-N ids
    # can never satisfy a source-N citation and vice versa.
    items = parse_maintenance_context([_item()])
    evidence = build_maintenance_evidence(items, QUERY_AT, "q", [])
    refs = build_maintenance_source_refs(evidence)
    payload = {"summary": "Manual claims X.", "cited_source_ids": ["source-1"]}
    _cleaned, _text, report = validate_citations(
        payload, "Summary\\nManual claims X.", refs, []
    )
    # maint-1 is not a valid manual citation for a source-1 claim; the invented
    # source-1 id is dropped instead of being silently accepted.
    assert report.valid is False
    assert "source-1" in report.dropped
