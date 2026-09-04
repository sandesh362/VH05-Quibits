"""Similar-incident retrieval and ranking.

Hybrid retrieval:
  1. Mongo exact error-code matches (organization-scoped, hard filter)
  2. Qdrant semantic search over `incident_memory` (organization + model
     filters, hard)

Ranking is deterministic and documented (docs/HISTORICAL_INCIDENT_RETRIEVAL.md):
  - exact error-code match        +0.35
  - same machine                  +0.15
  - same machine model            +0.10
  - symptom token overlap         +0.05 (capped)
  - confirmed root cause + fix    +0.10  (confirmed evidence ranks above
                                            speculative history)
  - speculative/unresolved        -0.15 (unresolved, rejected/unknown root
                                            cause, no confirmed outcome)
  - recency                       +0.05 * decay over ~2 years

Confirmed incidents rank above speculative ones by construction; every result
carries similarity REASONS and a `confirmed` flag so the UI can render the
"historical context, not proof" disclaimer.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from app.incident_memory.indexing import IncidentVectorIndex
from app.incident_memory.store import MongoIncidentStore
from app.rag.types import HistoricalIncident, HistoricalIncidentHit

EXACT_CODE_BONUS = 0.35
SAME_MACHINE_BONUS = 0.15
SAME_MODEL_BONUS = 0.10
SYMPTOM_OVERLAP_BONUS = 0.05
CONFIRMED_BONUS = 0.10
SPECULATIVE_PENALTY = 0.15
RECENCY_MAX_BONUS = 0.05
RECENCY_HALF_LIFE_DAYS = 365.0

REASON_SAME_MACHINE = "Same machine"
REASON_SAME_MODEL = "Same machine model"
REASON_EXACT_CODE = "Exact error-code match"
REASON_SIMILAR_SYMPTOMS = "Similar symptoms"
REASON_SIMILAR_CONDITIONS = "Similar operating conditions"
REASON_SEMANTIC = "Semantically similar"
REASON_CONFIRMED = "Has confirmed root cause and confirmed fix"
REASON_RECENT = "Recent incident"


def _token_set(text: str) -> set[str]:
    return {t for t in text.casefold().split() if t and len(t) > 2}


def symptom_overlap(query_symptoms: list[str], incident_symptoms: list[str]) -> float:
    if not query_symptoms or not incident_symptoms:
        return 0.0
    q = _token_set(" ".join(query_symptoms))
    i = _token_set(" ".join(incident_symptoms))
    if not q or not i:
        return 0.0
    return len(q & i) / max(len(q), len(i))


def condition_overlap(
    query_conditions: list[str], incident_conditions: list[str]
) -> float:
    if not query_conditions or not incident_conditions:
        return 0.0
    q = _token_set(" ".join(query_conditions))
    i = _token_set(" ".join(incident_conditions))
    if not q or not i:
        return 0.0
    return len(q & i) / max(len(q), len(i))


def recency_bonus(created_at: str | None, now: datetime | None = None) -> float:
    if not created_at:
        return 0.0
    try:
        parsed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    current = now or datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age_days = max((current - parsed).days, 0)
    return RECENCY_MAX_BONUS * math.exp(-age_days / RECENCY_HALF_LIFE_DAYS)


def speculative_penalty(incident: HistoricalIncident) -> float:
    """Penalize incidents without confirmed outcomes.

    Resolved-with-confirmation incidents are the reliable memory; open
    incidents with rejected/unknown root causes and unconfirmed fixes are
    speculative and must rank below confirmed ones.
    """
    if incident.confirmed:
        return 0.0
    if incident.status in {"open", "investigating", "reopened"}:
        return SPECULATIVE_PENALTY
    if incident.root_cause_status in {"unknown", "rejected"}:
        return SPECULATIVE_PENALTY
    return SPECULATIVE_PENALTY * 0.5


def score_incident(
    incident: HistoricalIncident,
    *,
    query: dict[str, Any],
    semantic_score: float | None,
    exact_error_code: bool,
) -> tuple[float, list[str]]:
    reasons: list[str] = []
    score = 0.0

    machine_id = query.get("machine_id")
    model_id = query.get("machine_model_id")

    if machine_id and incident.machine_id == machine_id:
        score += SAME_MACHINE_BONUS
        reasons.append(REASON_SAME_MACHINE)
    elif model_id and incident.machine_model_id == model_id:
        score += SAME_MODEL_BONUS
        reasons.append(REASON_SAME_MODEL)

    if exact_error_code:
        score += EXACT_CODE_BONUS
        reasons.append(REASON_EXACT_CODE)

    overlap = symptom_overlap(
        [str(s) for s in (query.get("symptoms") or [])], incident.symptoms
    )
    if overlap > 0.25:
        score += SYMPTOM_OVERLAP_BONUS
        reasons.append(REASON_SIMILAR_SYMPTOMS)

    cond_overlap = condition_overlap(
        [str(c) for c in (query.get("operating_conditions") or [])],
        incident.operating_conditions,
    )
    if cond_overlap > 0.25:
        score += SYMPTOM_OVERLAP_BONUS * 0.5
        reasons.append(REASON_SIMILAR_CONDITIONS)

    if semantic_score is not None:
        score += max(0.0, semantic_score)
        if semantic_score >= 0.5:
            reasons.append(REASON_SEMANTIC)

    if incident.confirmed:
        score += CONFIRMED_BONUS
        reasons.append(REASON_CONFIRMED)
    else:
        score -= speculative_penalty(incident)

    bonus = recency_bonus(incident.created_at)
    if bonus > 0.01:
        score += bonus
        reasons.append(REASON_RECENT)

    return round(max(0.0, min(score, 1.0)), 4), _dedupe(reasons)


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _merge_and_rank(
    candidates: dict[str, HistoricalIncident],
    *,
    query: dict[str, Any],
    semantic_scores: dict[str, float],
    exact_error_code_ids: set[str],
    limit: int,
) -> list[HistoricalIncidentHit]:
    ranked: list[HistoricalIncidentHit] = []
    for incident_id, incident in candidates.items():
        score, reasons = score_incident(
            incident,
            query=query,
            semantic_score=semantic_scores.get(incident_id),
            exact_error_code=incident_id in exact_error_code_ids,
        )
        ranked.append(
            HistoricalIncidentHit(
                incident=incident,
                score=score,
                reasons=reasons,
                semantic_score=semantic_scores.get(incident_id),
                exact_error_code=incident_id in exact_error_code_ids,
                same_machine=bool(
                    query.get("machine_id")
                    and incident.machine_id == query.get("machine_id")
                ),
                same_model=bool(
                    query.get("machine_model_id")
                    and incident.machine_model_id == query.get("machine_model_id")
                ),
            )
        )
    # Confirmed evidence ranks above speculative history by construction, but
    # keep the tie-break explicit: confirmed first, then score, then recency.
    ranked.sort(
        key=lambda h: (
            h.incident.confirmed,
            h.score,
            h.incident.resolved_at or h.incident.created_at or "",
        ),
        reverse=True,
    )
    return ranked[:limit]


async def retrieve_similar_incidents(
    *,
    store: MongoIncidentStore | None,
    vectors: IncidentVectorIndex | None,
    embed_query: Any | None,
    query: dict[str, Any],
    organization_id: str,
    machine_model_id: str | None,
    exclude_incident_id: str,
    limit: int,
    embedding_model: str,
) -> tuple[list[HistoricalIncidentHit], list[str]]:
    """Hybrid similar-incident retrieval with hard org isolation."""
    warnings: list[str] = []
    candidates: dict[str, HistoricalIncident] = {}
    exact_error_code_ids: set[str] = set()

    # 1. Structured Mongo exact error-code matches (org hard filter).
    error_codes = [str(c) for c in (query.get("error_codes") or [])]
    if store is not None and error_codes:
        try:
            exact = await store.find_exact_error_code_matches(
                organization_id=organization_id,
                machine_model_id=machine_model_id or "",
                error_codes=error_codes,
                exclude_incident_id=exclude_incident_id,
                limit=limit * 2,
            )
            for incident in exact:
                candidates[incident.incident_id] = incident
                exact_error_code_ids.add(incident.incident_id)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"exact incident matching unavailable: {str(exc)[:120]}")

    # 2. Qdrant semantic search (org + model hard filters).
    semantic_scores: dict[str, float] = {}
    if vectors is not None and embed_query is not None:
        try:
            text = " ".join(
                [
                    str(query.get("title") or ""),
                    *[str(s) for s in (query.get("symptoms") or [])],
                    *[str(c) for c in (query.get("operating_conditions") or [])],
                    *[str(c) for c in (query.get("error_codes") or [])],
                ]
            ).strip()
            vector = await embed_query(text)
            hits = await vectors.search(
                vector,
                organization_id=organization_id,
                machine_model_id=machine_model_id,
                exclude_incident_id=exclude_incident_id,
                limit=limit * 2,
                embedding_model=embedding_model,
            )
            for incident, score in hits:
                if incident.incident_id == exclude_incident_id:
                    continue
                candidates[incident.incident_id] = incident
                semantic_scores[incident.incident_id] = score
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"semantic incident retrieval unavailable: {str(exc)[:120]}")

    if not candidates:
        return [], warnings

    # 3. Merge + deterministic ranking.
    ranked = _merge_and_rank(
        candidates,
        query=query,
        semantic_scores=semantic_scores,
        exact_error_code_ids=exact_error_code_ids,
        limit=limit,
    )
    return ranked, warnings
