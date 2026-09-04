"""Merge, deduplicate and score retrieval hits.

Ranking is deterministic and fully documented in docs (see RETRIEVAL_ENGINE.md
and the scoring strategy section of PHASE_4_IMPLEMENTATION.md). Raw Qdrant
cosine is never used as the final score.
"""

from __future__ import annotations

from app.rag.types import ExtractedQuery, RankingWeights, RetrievalHit, ScopeFilter


def _token_set(text: str) -> set[str]:
    return {t for t in text.lower().split() if t}


def token_jaccard(left: str, right: str) -> float:
    a, b = _token_set(left), _token_set(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _clip01(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return value


def merge_hits(exact: list[RetrievalHit], semantic: list[RetrievalHit]) -> list[RetrievalHit]:
    """Union exact and semantic hits, keyed by chunk_id then content_hash."""
    merged: dict[str, RetrievalHit] = {}
    hash_index: dict[str, str] = {}

    def absorb(hit: RetrievalHit) -> None:
        existing_id = merged.get(hit.chunk_id)
        if existing_id is None and hit.content_hash:
            hashed = hash_index.get(hit.content_hash)
            if hashed is not None:
                existing_id = merged.get(hashed)
        if existing_id is None:
            merged[hit.chunk_id] = hit
            if hit.content_hash:
                hash_index[hit.content_hash] = hit.chunk_id
            return
        # Merge signals into the existing hit.
        existing_id.exact_match = existing_id.exact_match or hit.exact_match
        existing_id.matched_terms = list(
            dict.fromkeys([*existing_id.matched_terms, *hit.matched_terms])
        )
        sources = list(dict.fromkeys([*existing_id.retrieval_source, *hit.retrieval_source]))
        existing_id.retrieval_source = sources
        if hit.semantic_score is not None and (
            existing_id.semantic_score is None
            or hit.semantic_score > existing_id.semantic_score
        ):
            existing_id.semantic_score = hit.semantic_score
        # Prefer the longer text (overlap windows can truncate).
        if len(hit.text) > len(existing_id.text):
            existing_id.text = hit.text
            existing_id.section_title = existing_id.section_title or hit.section_title
            existing_id.section_path = existing_id.section_path or hit.section_path
        if not existing_id.manual_title and hit.manual_title:
            existing_id.manual_title = hit.manual_title
            existing_id.manual_version = hit.manual_version
            existing_id.manual_type = hit.manual_type

    for hit in exact:
        absorb(hit)
    for hit in semantic:
        absorb(hit)
    return list(merged.values())


def drop_near_duplicates(hits: list[RetrievalHit], threshold: float) -> list[RetrievalHit]:
    """Keep the higher-scored hit when two chunks are near-identical."""
    ordered = sorted(hits, key=lambda h: h.final_score, reverse=True)
    kept: list[RetrievalHit] = []
    for hit in ordered:
        duplicate = False
        for other in kept:
            if hit.chunk_id == other.chunk_id or (
                hit.content_hash and hit.content_hash == other.content_hash
            ):
                duplicate = True
                break
            if token_jaccard(hit.text, other.text) >= threshold:
                duplicate = True
                break
        if not duplicate:
            kept.append(hit)
    return kept


def _term_ratio(hit: RetrievalHit, extracted: ExtractedQuery) -> float:
    needles = [
        *extracted.error_codes,
        *extracted.error_code_variants,
        *extracted.part_numbers,
        *extracted.technical_terms,
        *extracted.units,
        *extracted.component_names,
    ]
    if not needles:
        return 0.0
    blob = hit.text.casefold()
    hits = 0
    for needle in needles:
        if needle.casefold() in blob:
            hits += 1
    return hits / len(needles)


def _section_boost(hit: RetrievalHit, extracted: ExtractedQuery) -> float:
    hay = " ".join(
        [
            hit.section_title or "",
            " ".join(hit.section_path or []),
        ]
    ).casefold()
    if not hay.strip():
        return 0.0
    for term in [*extracted.error_codes, *extracted.technical_terms, *extracted.symptoms]:
        if term.casefold() in hay:
            return 1.0
    if "troubleshoot" in hay or "fault" in hay or "alarm" in hay:
        return 0.6
    return 0.0


def score_hit(
    hit: RetrievalHit,
    extracted: ExtractedQuery,
    scope: ScopeFilter,
    weights: RankingWeights,
) -> float:
    exact = 1.0 if hit.exact_match else 0.0
    terms = _term_ratio(hit, extracted)
    machine = 0.0
    if scope.machine_model_id and hit.machine_model_id == scope.machine_model_id:
        machine = 1.0
    elif scope.general:
        machine = 0.4
    manual = 0.0
    if scope.manual_id and hit.manual_id == scope.manual_id:
        manual = 1.0
    elif scope.manual_version and hit.manual_version == scope.manual_version:
        manual = 0.8
    elif hit.is_current_version:
        manual = 0.5
    semantic = hit.semantic_score if hit.semantic_score is not None else 0.0
    section = _section_boost(hit, extracted)

    score = (
        weights.exact_match * exact
        + weights.technical_term * terms
        + weights.machine_scope * machine
        + weights.manual_scope * manual
        + weights.semantic * semantic
        + weights.section * section
    )
    return _clip01(score)


def rank_hits(
    hits: list[RetrievalHit],
    extracted: ExtractedQuery,
    scope: ScopeFilter,
    weights: RankingWeights,
    *,
    near_duplicate_threshold: float = 0.92,
) -> list[RetrievalHit]:
    for hit in hits:
        hit.final_score = score_hit(hit, extracted, scope, weights)
    deduped = drop_near_duplicates(hits, near_duplicate_threshold)
    # Exact error-code matches are pinned ahead of equally-scored semantic hits.
    deduped.sort(
        key=lambda h: (
            1 if h.exact_match and extracted.error_codes else 0,
            h.final_score,
            1 if h.is_current_version else 0,
        ),
        reverse=True,
    )
    return deduped


def assign_source_ids(hits: list[RetrievalHit]) -> list[RetrievalHit]:
    for index, hit in enumerate(hits, start=1):
        hit.source_id = f"source-{index}"
    return hits
