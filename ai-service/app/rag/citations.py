"""Citation construction and validation.

The application — not the model — authors page numbers, titles and versions.
The model may only emit SOURCE_IDs drawn from the evidence block. Any other
citation is dropped. Invalid output triggers one controlled regeneration;
persistent failure yields a structured generation_failed / evidence-only
response rather than fabricated citations.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.rag.types import CitationReport, RetrievalHit, SourceRef

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
_SOURCE_ID = re.compile(r"\b(source|history|maint)-(\d+)\b", re.IGNORECASE)
_PAGE_MENTION = re.compile(
    r"\b(?:pp?\.?|pages?)\s*(\d+)(?:\s*[–-]\s*(\d+))?",
    re.IGNORECASE,
)


def parse_model_json(text: str) -> dict[str, Any] | None:
    if not text or not text.strip():
        return None
    stripped = text.strip()
    fenced = _JSON_FENCE.search(stripped)
    if fenced:
        stripped = fenced.group(1).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def allowed_pages(hits: list[RetrievalHit] | list[SourceRef]) -> set[int]:
    pages: set[int] = set()
    for item in hits:
        start = int(getattr(item, "page_start", 0) or 0)
        end = int(getattr(item, "page_end", start) or start)
        if start < 1:
            continue
        for page in range(start, max(end, start) + 1):
            pages.add(page)
    return pages


def extract_cited_ids(payload: dict[str, Any], answer_text: str) -> list[str]:
    ids: list[str] = []
    raw = payload.get("cited_source_ids") or payload.get("citedSourceIds") or []
    if isinstance(raw, list):
        for item in raw:
            token = str(item).strip().lower()
            if token:
                ids.append(token)
    for match in _SOURCE_ID.finditer(answer_text or ""):
        ids.append(f"{match.group(1).lower()}-{match.group(2)}")
    seen: set[str] = set()
    out: list[str] = []
    for item in ids:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def pages_mentioned(text: str) -> set[int]:
    found: set[int] = set()
    for match in _PAGE_MENTION.finditer(text or ""):
        found.add(int(match.group(1)))
        if match.group(2):
            found.add(int(match.group(2)))
    return found


def validate_citations(
    payload: dict[str, Any],
    answer_text: str,
    sources: list[SourceRef],
    hits: list[RetrievalHit],
) -> tuple[dict[str, Any], str, CitationReport]:
    allowed_ids = { (s.source_id or "").lower() for s in sources }
    cited = extract_cited_ids(payload, answer_text)
    dropped = [cid for cid in cited if cid not in allowed_ids]
    valid_ids = [cid for cid in cited if cid in allowed_ids]

    allowed = allowed_pages(hits)
    mentioned = pages_mentioned(answer_text)
    extra_pages = sorted(p for p in mentioned if p not in allowed)

    repaired = False
    cleaned_text = answer_text
    if extra_pages:
        def _strip(match: re.Match[str]) -> str:
            start = int(match.group(1))
            end = int(match.group(2) or match.group(1))
            if start not in allowed or end not in allowed:
                return ""
            return match.group(0)

        cleaned_text = _PAGE_MENTION.sub(_strip, cleaned_text)
        cleaned_text = re.sub(r"[ ]{2,}", " ", cleaned_text).strip()
        repaired = True

    cleaned_payload = dict(payload)
    cleaned_payload["cited_source_ids"] = valid_ids

    valid = not dropped and not extra_pages
    # Empty cited_source_ids is acceptable: the application attaches sources.
    report = CitationReport(
        valid=valid or (not dropped and repaired),
        dropped=dropped,
        page_mismatches=[str(p) for p in extra_pages],
        repaired=repaired,
        details=[
            *(f"unknown source id {d}" for d in dropped),
            *(f"page {p} is not in retrieved evidence" for p in extra_pages),
        ],
    )
    if dropped:
        report.valid = False
    return cleaned_payload, cleaned_text, report


def sources_for_ids(source_ids: list[str], sources: list[SourceRef]) -> list[SourceRef]:
    by_id = {s.source_id.lower(): s for s in sources}
    if not source_ids:
        return list(sources)
    selected = []
    seen: set[str] = set()
    for sid in source_ids:
        ref = by_id.get(sid.lower())
        if ref and ref.source_id not in seen:
            selected.append(ref)
            seen.add(ref.source_id)
    return selected or list(sources)
