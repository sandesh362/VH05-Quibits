"""Exact identifier retrieval against Mongo (or an in-memory store).

Error codes, part numbers and similar tokens are matched with word-boundary
regular expressions so E-104 cannot hit E-140 or E-014. Matching is
case-insensitive for letters; digits stay exact.
"""

from __future__ import annotations

import re

from app.rag.normalize import identifier_regex
from app.rag.types import (
    ChunkRecord,
    ChunkStore,
    ExtractedQuery,
    ManualRecord,
    RetrievalHit,
    ScopeFilter,
)


def _escape_literal(term: str) -> str:
    return re.escape(term)


def build_exact_patterns(extracted: ExtractedQuery) -> list[str]:
    """Regex strings suitable for Mongo `$regex` and in-memory `re.search`."""
    patterns: list[str] = []
    seen: set[str] = set()

    def add(pattern: str) -> None:
        if pattern and pattern not in seen:
            seen.add(pattern)
            patterns.append(pattern)

    for code in [*extracted.error_codes, *extracted.error_code_variants]:
        add(identifier_regex(code).pattern)

    for part in extracted.part_numbers:
        add(rf"(?<![A-Z0-9]){_escape_literal(part)}(?![A-Z0-9])")

    for model in extracted.model_numbers:
        add(rf"(?<![A-Z0-9]){_escape_literal(model)}(?![A-Z0-9])")

    for unit in extracted.units:
        add(_escape_literal(unit))

    # Multi-word technical phrases (e.g. "hydraulic pressure") as literal matches.
    for term in extracted.technical_terms:
        if " " in term or "-" in term:
            add(_escape_literal(term))

    for name in extracted.component_names:
        if re.search(r"\d", name) or "-" in name:
            add(rf"(?<![A-Z0-9]){_escape_literal(name)}(?![A-Z0-9])")

    return patterns


def matched_terms_in(text: str, extracted: ExtractedQuery) -> list[str]:
    found: list[str] = []
    blob = text
    for code in extracted.error_codes:
        if identifier_regex(code).search(blob):
            found.append(code)
    for extra in [
        *extracted.part_numbers,
        *extracted.units,
        *extracted.technical_terms,
        *extracted.component_names,
        *extracted.model_numbers,
    ]:
        if extra and extra.casefold() in blob.casefold():
            found.append(extra)
    # Preserve order, drop dupes.
    seen: set[str] = set()
    out: list[str] = []
    for item in found:
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def is_exact_hit(text: str, extracted: ExtractedQuery) -> bool:
    if any(identifier_regex(code).search(text) for code in extracted.error_codes):
        return True
    for part in extracted.part_numbers:
        if re.search(
            rf"(?<![A-Z0-9]){re.escape(part)}(?![A-Z0-9])", text, re.IGNORECASE
        ):
            return True
    return False


def hit_from_chunk(
    chunk: ChunkRecord,
    manual: ManualRecord | None,
    extracted: ExtractedQuery,
    *,
    source: str,
    semantic_score: float | None = None,
) -> RetrievalHit:
    text = chunk.text
    terms = matched_terms_in(text, extracted)
    machine_model_id = chunk.machine_model_id or (manual.machine_model_id if manual else None)
    title = (manual.title if manual else None) or chunk.manual_title or ""
    version = (manual.version if manual else None) or chunk.manual_version
    manual_type = (manual.manual_type if manual else None) or chunk.manual_type
    manufacturer = (manual.manufacturer if manual else None) or chunk.manufacturer
    return RetrievalHit(
        chunk_id=chunk.chunk_id,
        manual_id=chunk.manual_id,
        machine_model_id=machine_model_id,
        manual_title=title,
        manual_version=version,
        manual_type=manual_type,
        manufacturer=manufacturer,
        page_start=chunk.page_start,
        page_end=chunk.page_end,
        section_title=chunk.section_title,
        section_path=list(chunk.section_path or []),
        text=text,
        content_hash=chunk.content_hash,
        chunk_index=chunk.chunk_index,
        exact_match=is_exact_hit(text, extracted) if source == "exact" else False,
        matched_terms=terms,
        semantic_score=semantic_score,
        retrieval_source=[source],
        is_current_version=(
            manual.is_current_version if manual else chunk.is_current_version
        ),
        is_active=manual.is_active if manual else True,
        language=(manual.language if manual else None) or chunk.language,
    )


async def exact_search(
    store: ChunkStore,
    extracted: ExtractedQuery,
    scope: ScopeFilter,
    manuals: list[ManualRecord],
    *,
    limit: int,
) -> list[RetrievalHit]:
    if not manuals:
        return []
    patterns = build_exact_patterns(extracted)
    if not patterns:
        # Fall back to a conservative phrase match on the normalized query if
        # it still contains a distinctive token.
        tokens = [t for t in extracted.normalized.split() if len(t) >= 4]
        patterns = [re.escape(" ".join(tokens[:6]))] if tokens else []
        if not patterns:
            return []

    manual_ids = [m.manual_id for m in manuals]
    by_id = {m.manual_id: m for m in manuals}
    chunks = await store.find_chunks(manual_ids=manual_ids, patterns=patterns, limit=limit)

    hits: list[RetrievalHit] = []
    for chunk in chunks:
        if scope.machine_model_id:
            model_id = chunk.machine_model_id or (
                by_id[chunk.manual_id].machine_model_id if chunk.manual_id in by_id else None
            )
            if model_id and model_id != scope.machine_model_id:
                continue
        hit = hit_from_chunk(chunk, by_id.get(chunk.manual_id), extracted, source="exact")
        if not hit.exact_match and not hit.matched_terms:
            continue
        # Identifier queries require a real identifier hit, not a fuzzy term.
        if extracted.error_codes and not is_exact_hit(hit.text, extracted):
            continue
        hits.append(hit)
    return hits
