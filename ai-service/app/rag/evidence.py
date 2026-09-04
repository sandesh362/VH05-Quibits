"""Evidence sufficiency, conflict detection and refusal decisions.

Generation is skipped entirely when evidence is insufficient or a machine
model must be clarified. Guessing is never an option.
"""

from __future__ import annotations

import re

from app.rag.types import (
    EvidenceDecision,
    ExtractedQuery,
    RagRuntimeConfig,
    RetrievalHit,
    ScopeFilter,
)

_NUMBER_UNIT = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>bar|psi|kpa|mpa|vdc|vac|v|a|ma|°c|c|mm|rpm|hz|kw)\b",
    re.IGNORECASE,
)

MACHINE_MODEL_REQUIRED = "MACHINE_MODEL_REQUIRED"
INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
CONFLICTING_EVIDENCE = "CONFLICTING_EVIDENCE"
MISSING_SOURCE_METADATA = "MISSING_SOURCE_METADATA"
QDRANT_UNAVAILABLE = "QDRANT_UNAVAILABLE"
OLLAMA_UNAVAILABLE = "OLLAMA_UNAVAILABLE"
EMBEDDING_MODEL_MISMATCH = "EMBEDDING_MODEL_MISMATCH"

REFUSAL_MESSAGES = {
    MACHINE_MODEL_REQUIRED: (
        "Please select the machine model before troubleshooting this issue."
    ),
    INSUFFICIENT_EVIDENCE: (
        "I could not find enough evidence in the selected manuals to answer this reliably."
    ),
    CONFLICTING_EVIDENCE: (
        "The selected manuals contain different instructions for this condition."
    ),
    MISSING_SOURCE_METADATA: (
        "Retrieved passages are missing source metadata required for a citable answer."
    ),
    QDRANT_UNAVAILABLE: (
        "Semantic search is unavailable, and exact matches were not sufficient to answer."
    ),
    OLLAMA_UNAVAILABLE: "The local language model is unavailable, so no answer could be generated.",
    EMBEDDING_MODEL_MISMATCH: (
        "The embedding model does not match the indexed vectors; refusing to search semantically."
    ),
}


def clarification_required(reason: str, message: str | None = None) -> EvidenceDecision:
    return EvidenceDecision(
        sufficient=False,
        status="clarification_required",
        reason=reason,
        message=message or REFUSAL_MESSAGES.get(reason, message),
    )


def metadata_complete(hit: RetrievalHit) -> bool:
    if not hit.manual_title:
        return False
    if hit.page_start is None or hit.page_start < 1:
        return False
    return bool(hit.manual_id and hit.chunk_id)


def _numeric_fingerprint(text: str) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for match in _NUMBER_UNIT.finditer(text):
        unit = match.group("unit").lower()
        value = match.group("value")
        found.setdefault(unit, set()).add(value)
    return found


def detect_conflicts(hits: list[RetrievalHit], extracted: ExtractedQuery) -> list[str]:
    """Flag contradictory numeric values or versioned procedures for the same code."""
    if len(hits) < 2:
        return []
    warnings: list[str] = []

    by_code: dict[str, list[RetrievalHit]] = {}
    if extracted.error_codes:
        for code in extracted.error_codes:
            needle = code.casefold()
            for hit in hits:
                if needle in hit.text.casefold() or any(
                    needle in t.casefold() for t in hit.matched_terms
                ):
                    by_code.setdefault(code, []).append(hit)
    else:
        by_code["*"] = list(hits)

    for code, group in by_code.items():
        versions = {(h.manual_id, h.manual_version or "") for h in group}
        if len(versions) < 2:
            continue
        fingerprints: list[tuple[RetrievalHit, dict[str, set[str]]]] = [
            (h, _numeric_fingerprint(h.text)) for h in group
        ]
        units: set[str] = set()
        for _, fp in fingerprints:
            units.update(fp)
        for unit in units:
            values: dict[str, list[str]] = {}
            for hit, fp in fingerprints:
                for value in fp.get(unit, set()):
                    values.setdefault(value, []).append(
                        f"{hit.manual_title} {hit.manual_version or ''}".strip()
                    )
            if len(values) > 1:
                pretty = ", ".join(f"{v} {unit}" for v in values)
                label = f"error {code}" if code != "*" else "this condition"
                warnings.append(
                    f"Manual versions disagree on {label}: {pretty}."
                )
    return warnings


def select_evidence(
    ranked: list[RetrievalHit],
    extracted: ExtractedQuery,
    scope: ScopeFilter,
    config: RagRuntimeConfig,
    *,
    semantic_available: bool = True,
    qdrant_error: str | None = None,
) -> EvidenceDecision:
    """Choose the context set and decide whether generation is allowed."""
    warnings: list[str] = []

    eligible: list[RetrievalHit] = []
    for hit in ranked:
        if config.require_source_metadata and not metadata_complete(hit):
            continue
        # Hard isolation: never leak another model's chunk.
        if (
            scope.machine_model_id
            and hit.machine_model_id
            and hit.machine_model_id != scope.machine_model_id
        ):
            continue
        exact_ok = hit.exact_match
        semantic_ok = (
            hit.semantic_score is not None and hit.semantic_score >= config.min_semantic_score
        )
        final_ok = hit.final_score >= config.min_final_score
        if exact_ok or semantic_ok or final_ok:
            eligible.append(hit)

    # Prefer exact error-code matches; keep remaining by score. Cap at top_k.
    exact_first = [h for h in eligible if h.exact_match]
    rest = [h for h in eligible if not h.exact_match]
    selected = (exact_first + rest)[: config.top_k]

    conflicts = detect_conflicts(selected, extracted)
    if conflicts:
        # Prefer the explicitly selected version / the current version.
        preferred: list[RetrievalHit] = []
        others: list[RetrievalHit] = []
        for hit in selected:
            version_match = (
                scope.manual_version and hit.manual_version == scope.manual_version
            )
            current_default = (
                not scope.manual_version
                and not scope.manual_id
                and hit.is_current_version
            )
            manual_match = scope.manual_id and hit.manual_id == scope.manual_id
            if version_match or current_default or manual_match:
                preferred.append(hit)
            else:
                others.append(hit)
        ordered = preferred + others
        preferred_conflicts = detect_conflicts(preferred, extracted) if preferred else conflicts
        if preferred and not preferred_conflicts:
            # Superseded manuals disagree with the current one: answer from the
            # current version and surface the disagreement as a warning.
            return EvidenceDecision(
                sufficient=True,
                status="answered",
                reason=None,
                message=None,
                warnings=[*conflicts],
                conflicts=conflicts,
                selected=preferred[: config.top_k],
            )
        return EvidenceDecision(
            sufficient=True,
            status="conflicting_evidence",
            reason=CONFLICTING_EVIDENCE,
            message=REFUSAL_MESSAGES[CONFLICTING_EVIDENCE],
            warnings=[*conflicts, REFUSAL_MESSAGES[CONFLICTING_EVIDENCE]],
            conflicts=conflicts,
            selected=ordered[: config.top_k],
        )

    if len(selected) < config.min_context_chunks:
        if not semantic_available and not any(h.exact_match for h in ranked):
            return EvidenceDecision(
                sufficient=False,
                status="processing_unavailable",
                reason=QDRANT_UNAVAILABLE,
                message=REFUSAL_MESSAGES[QDRANT_UNAVAILABLE],
                warnings=[qdrant_error] if qdrant_error else [],
                selected=[],
            )
        if config.require_source_metadata and ranked and not any(
            metadata_complete(h) for h in ranked
        ):
            return EvidenceDecision(
                sufficient=False,
                status="insufficient_evidence",
                reason=MISSING_SOURCE_METADATA,
                message=REFUSAL_MESSAGES[MISSING_SOURCE_METADATA],
                selected=[],
            )
        extra = ""
        if extracted.error_codes:
            extra = (
                f" I found references to {', '.join(extracted.error_codes)}, but not enough "
                "information to determine the correct corrective action for this machine model."
                if any(
                    any(code.lower() in (h.text or "").lower() for code in extracted.error_codes)
                    for h in ranked
                )
                else ""
            )
        return EvidenceDecision(
            sufficient=False,
            status="insufficient_evidence",
            reason=INSUFFICIENT_EVIDENCE,
            message=REFUSAL_MESSAGES[INSUFFICIENT_EVIDENCE] + extra,
            warnings=warnings,
            selected=selected,
        )

    if extracted.error_codes and not any(h.exact_match for h in selected):
        warnings.append(
            "No exact error-code match was found; the answer relies on "
            "semantically similar passages."
        )

    return EvidenceDecision(
        sufficient=True,
        status="answered",
        reason=None,
        message=None,
        warnings=warnings,
        selected=selected,
    )
