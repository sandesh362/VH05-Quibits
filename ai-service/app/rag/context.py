"""Assemble ranked chunks into a bounded, citable evidence block.

Chunks are never cut mid-sentence when dropping is an option. Exact
error-code matches are kept even if they are longer. Adjacent chunks from the
same page and section may be concatenated while retaining both source ids.
"""

from __future__ import annotations

from app.rag.types import HistoricalIncidentHit, RetrievalHit, SourceRef


def sources_from_hits(hits: list[RetrievalHit]) -> list[SourceRef]:
    refs: list[SourceRef] = []
    for hit in hits:
        source_id = hit.source_id or f"source-{len(refs) + 1}"
        hit.source_id = source_id
        excerpt = (hit.text or "").strip().replace("\n", " ")
        if len(excerpt) > 400:
            excerpt = excerpt[:399].rsplit(" ", 1)[0] + "…"
        refs.append(
            SourceRef(
                source_id=source_id,
                chunk_id=hit.chunk_id,
                manual_id=hit.manual_id,
                manual_title=hit.manual_title,
                manual_version=hit.manual_version,
                page_start=hit.page_start,
                page_end=hit.page_end,
                section_title=hit.section_title,
                machine_model_id=hit.machine_model_id,
                excerpt=excerpt or None,
            )
        )
    return refs


def maybe_combine_adjacent(hits: list[RetrievalHit]) -> list[RetrievalHit]:
    """Combine adjacent same-section chunks without dropping source identity.

    Combination is conservative: same manual, consecutive chunk_index, same
    section, same page range overlap. The surviving hit keeps both source
    signals; we do NOT invent a new chunk id.
    """
    if len(hits) < 2:
        return hits
    ordered = sorted(hits, key=lambda h: (h.manual_id, h.chunk_index))
    combined: list[RetrievalHit] = []
    skip: set[str] = set()
    for hit in ordered:
        if hit.chunk_id in skip:
            continue
        neighbour = None
        for other in ordered:
            if other.chunk_id == hit.chunk_id or other.chunk_id in skip:
                continue
            if other.manual_id != hit.manual_id:
                continue
            if abs(other.chunk_index - hit.chunk_index) != 1:
                continue
            if (other.section_title or "") != (hit.section_title or ""):
                continue
            if other.page_start > hit.page_end + 1 or hit.page_start > other.page_end + 1:
                continue
            neighbour = other
            break
        if neighbour is None:
            combined.append(hit)
            continue
        # Keep the higher-scored hit as the container; concatenate text.
        primary, secondary = (
            (hit, neighbour) if hit.final_score >= neighbour.final_score else (neighbour, hit)
        )
        if secondary.text not in primary.text:
            if primary.chunk_index <= secondary.chunk_index:
                primary.text = f"{primary.text}\n\n{secondary.text}".strip()
            else:
                primary.text = f"{secondary.text}\n\n{primary.text}".strip()
        primary.page_start = min(primary.page_start, secondary.page_start)
        primary.page_end = max(primary.page_end, secondary.page_end)
        primary.matched_terms = list(
            dict.fromkeys([*primary.matched_terms, *secondary.matched_terms])
        )
        primary.retrieval_source = list(
            dict.fromkeys([*primary.retrieval_source, *secondary.retrieval_source])
        )
        primary.exact_match = primary.exact_match or secondary.exact_match
        skip.add(secondary.chunk_id)
        combined.append(primary)
        skip.add(primary.chunk_id)
    # Restore original relevance order among survivors.
    survivors = {h.chunk_id: h for h in combined}
    return [survivors[h.chunk_id] for h in hits if h.chunk_id in survivors]


def select_for_context(
    hits: list[RetrievalHit],
    *,
    max_chars: int,
) -> list[RetrievalHit]:
    """Keep highest-value evidence without exceeding the character budget.

    Exact matches are always taken first. Remaining slots fill by final_score.
    Whole chunks are dropped rather than truncated mid-instruction.
    """
    if max_chars <= 0:
        return []
    exact = [h for h in hits if h.exact_match]
    rest = [h for h in hits if not h.exact_match]
    chosen: list[RetrievalHit] = []
    used = 0

    def try_add(hit: RetrievalHit) -> None:
        nonlocal used
        size = len(hit.text) + 180  # header overhead
        if chosen and used + size > max_chars:
            return
        if not chosen and size > max_chars:
            # Single oversized chunk: keep it, the prompt builder will clip
            # at a paragraph boundary as a last resort.
            chosen.append(hit)
            used += size
            return
        if used + size <= max_chars or not chosen:
            chosen.append(hit)
            used += size

    for hit in exact:
        try_add(hit)
    for hit in rest:
        try_add(hit)
    return chosen


def format_evidence_block(hits: list[RetrievalHit]) -> str:
    parts: list[str] = []
    for hit in hits:
        source_id = hit.source_id or "source-?"
        version = hit.manual_version or "unknown"
        pages = (
            str(hit.page_start)
            if hit.page_start == hit.page_end
            else f"{hit.page_start}-{hit.page_end}"
        )
        section = hit.section_title or "(no section title)"
        header = (
            f"SOURCE_ID: {source_id}\n"
            f"MANUAL: {hit.manual_title or '(untitled)'}\n"
            f"VERSION: {version}\n"
            f"PAGES: {pages}\n"
            f"SECTION: {section}\n"
            f"CHUNK_ID: {hit.chunk_id}\n"
            f"MACHINE_MODEL_ID: {hit.machine_model_id or ''}"
        )
        body = hit.text.strip()
        parts.append(
            f"{header}\n\nCONTENT:\n<<<UNTRUSTED_DOCUMENT_CONTENT>>>\n{body}\n<<<END_UNTRUSTED_DOCUMENT_CONTENT>>>"
        )
    return "\n\n-----\n\n".join(parts)


def format_historical_evidence_block(
    hits: list[HistoricalIncidentHit], *, max_chars: int
) -> str:
    """Render historical incidents as clearly-labeled supplementary evidence.

    Every block carries the HISTORICAL label, the incident number, dates, the
    similarity reasons, and ONLY confirmed root-cause/fix content (unconfirmed
    or rejected content is never embedded as a fact). Manual evidence is
    rendered separately and remains authoritative.
    """
    parts: list[str] = []
    used = 0
    for hit in hits:
        incident = hit.incident
        resolved = incident.resolved_at or ""
        resolved_bit = f", resolved {resolved[:10]}" if resolved else ""
        header = (
            f"SOURCE_ID: history-{len(parts) + 1}\n"
            f"TYPE: HISTORICAL_INCIDENT_SOURCE (supplementary, not authoritative)\n"
            f"INCIDENT: {incident.incident_number or '(unnumbered)'}{resolved_bit}\n"
            f"SIMILARITY: {', '.join(hit.reasons) or 'semantic similarity'}\n"
            f"STATUS: {incident.status} | issue {incident.issue_status}"
        )
        lines: list[str] = [header]
        if incident.error_codes:
            lines.append("Error codes: " + ", ".join(incident.error_codes))
        if incident.symptoms:
            lines.append("Symptoms: " + "; ".join(incident.symptoms[:4]))
        if incident.operating_conditions:
            lines.append(
                "Operating conditions: " + "; ".join(incident.operating_conditions[:4])
            )
        if incident.confirmed_root_cause:
            lines.append(f"Confirmed root cause (for THAT incident): {incident.confirmed_root_cause}")
        if incident.confirmed_fix:
            lines.append(f"Confirmed fix (for THAT incident): {incident.confirmed_fix}")
        if incident.resolution_summary:
            lines.append(f"Resolution summary: {incident.resolution_summary}")
        if not incident.confirmed:
            lines.append(
                "NOTE: this incident is UNCONFIRMED or unresolved - speculative history, not proof."
            )
        block = "\n".join(lines).strip()
        if used + len(block) > max_chars and parts:
            break
        parts.append(block)
        used += len(block) + 40
    return "\n\n-----\n\n".join(parts)


def clip_text_at_boundary(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    window = text[:max_chars]
    for sep in ("\n\n", "\n", ". ", "; "):
        idx = window.rfind(sep)
        if idx >= max_chars // 2:
            return window[: idx + len(sep)].rstrip() + "…"
    return window.rstrip() + "…"
