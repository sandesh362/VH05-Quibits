"""Retrieval + RAG orchestration.

Express validates identity and machine scope. This module owns query
normalization, exact/semantic search, ranking, evidence gates, prompting,
generation and citation validation. Conversation memory, incident history and
maintenance intelligence are intentionally absent (Phase 5+).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from app.clients.ollama import QUERY_PREFIX, OllamaEmbeddingClient
from app.clients.qdrant import new_qdrant_client
from app.core.config import Settings
from app.core.errors import ServiceError
from app.core.logging import get_logger
from app.rag.citations import (
    parse_model_json,
    sources_for_ids,
    validate_citations,
)
from app.rag.context import (
    clip_text_at_boundary,
    format_evidence_block,
    maybe_combine_adjacent,
    select_for_context,
    sources_from_hits,
)
from app.rag.evidence import (
    EMBEDDING_MODEL_MISMATCH,
    MACHINE_MODEL_REQUIRED,
    OLLAMA_UNAVAILABLE,
    REFUSAL_MESSAGES,
    select_evidence,
)
from app.rag.exact import exact_search
from app.rag.generate import OllamaChatClient
from app.rag.normalize import extracted_to_public, normalize_query, query_hash
from app.rag.prompt import (
    build_messages,
    format_answer_from_structured,
    regeneration_messages,
)
from app.rag.ranking import assign_source_ids, merge_hits, rank_hits
from app.rag.semantic import QdrantVectorIndex, semantic_search
from app.rag.settings import rag_config_from_settings
from app.rag.store import MongoChunkStore
from app.rag.types import (
    ChatGenerator,
    ChunkStore,
    Embedder,
    ExtractedQuery,
    HistoricalIncidentHit,
    IncidentStore,
    IncidentVectorIndex,
    RagAnswer,
    RagRuntimeConfig,
    RetrievalHit,
    ScopeFilter,
    VectorIndex,
)

log = get_logger()


@dataclass
class PipelineRequest:
    query: str
    machine_id: str | None = None
    machine_model_id: str | None = None
    manual_id: str | None = None
    manual_version: str | None = None
    manual_type: str | None = None
    manufacturer: str | None = None
    include_inactive: bool = False
    conversation_id: str | None = None
    conversation_context: dict[str, Any] | None = None
    organization_id: str | None = None
    # Phase 7 maintenance lane: bounded, org-scoped facts supplied by Express.
    maintenance_context: Any = None
    query_at: str | None = None
    debug: bool = False
    top_k: int | None = None


@dataclass
class PipelineDeps:
    store: ChunkStore | None
    embedder: Embedder | None
    vectors: VectorIndex | None
    generator: ChatGenerator | None
    config: RagRuntimeConfig
    embedding_model: str
    warnings: list[str] = field(default_factory=list)
    # Phase 6 incident memory (supplementary evidence only).
    incident_store: IncidentStore | None = None
    incident_vectors: IncidentVectorIndex | None = None
    incident_memory_enabled: bool = False
    incident_top_k: int = 4
    incident_max_context_chars: int = 2_500


@dataclass
class RetrievalTrace:
    extracted: ExtractedQuery
    scope: ScopeFilter
    exact: list[RetrievalHit]
    semantic: list[RetrievalHit]
    merged: list[RetrievalHit]
    ranked: list[RetrievalHit]
    selected: list[RetrievalHit]
    warnings: list[str]
    semantic_available: bool
    duration_ms: int
    manuals_in_scope: int
    historical: list[HistoricalIncidentHit] = field(default_factory=list)


async def _embed_query_sync(deps: PipelineDeps, text: str) -> list[float]:
    if deps.embedder is None:
        raise ServiceError("SERVICE_UNAVAILABLE", "Embedding unavailable.")
    return await deps.embedder.embed_query(text)


def _scope_from_request(req: PipelineRequest) -> ScopeFilter:
    return ScopeFilter(
        machine_id=req.machine_id,
        machine_model_id=req.machine_model_id,
        manual_id=req.manual_id,
        manual_version=req.manual_version,
        manual_type=req.manual_type,
        manufacturer=req.manufacturer,
        include_inactive=req.include_inactive,
        general=not bool(req.machine_model_id or req.manual_id or req.machine_id),
    )


def _query_public(extracted: ExtractedQuery) -> dict[str, Any]:
    return extracted_to_public(extracted)


def _scope_public(scope: ScopeFilter) -> dict[str, Any]:
    return {
        "machine_id": scope.machine_id,
        "machine_model_id": scope.machine_model_id,
        "manual_id": scope.manual_id,
        "manual_version": scope.manual_version,
        "manual_type": scope.manual_type,
        "manufacturer": scope.manufacturer,
        "general": scope.general,
    }


def _retrieval_public(
    exact_n: int,
    semantic_n: int,
    context_n: int,
    *,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "exact_matches": exact_n,
        "semantic_matches": semantic_n,
        "final_context_chunks": context_n,
    }
    if extra:
        payload.update(extra)
    return payload


def empty_answer(
    *,
    status: str,
    extracted: ExtractedQuery,
    scope: ScopeFilter,
    reason: str | None,
    message: str | None,
    warnings: list[str] | None = None,
    sources: list[dict[str, Any]] | None = None,
    retrieval: dict[str, Any] | None = None,
    debug: dict[str, Any] | None = None,
    confidence: str | None = None,
    evidence_sufficient: bool = False,
    answer: str | None = None,
) -> RagAnswer:
    return RagAnswer(
        status=status,  # type: ignore[arg-type]
        answer=answer,
        confidence=confidence,  # type: ignore[arg-type]
        evidence_sufficient=evidence_sufficient,
        query=_query_public(extracted),
        scope=_scope_public(scope),
        sources=sources or [],
        retrieval=retrieval or _retrieval_public(0, 0, 0),
        warnings=warnings or [],
        reason=reason,
        message=message,
        debug=debug,
    )


async def retrieve(
    req: PipelineRequest,
    deps: PipelineDeps,
) -> RetrievalTrace:
    started = time.perf_counter()
    extracted = normalize_query(req.query)
    scope = _scope_from_request(req)
    warnings: list[str] = list(deps.warnings)
    exact_hits: list[RetrievalHit] = []
    semantic_hits: list[RetrievalHit] = []
    semantic_available = True
    manuals_in_scope = 0

    if extracted.requires_machine_scope and not (
        scope.machine_model_id or scope.manual_id
    ):
        return RetrievalTrace(
            extracted=extracted,
            scope=scope,
            exact=[],
            semantic=[],
            merged=[],
            ranked=[],
            selected=[],
            warnings=warnings,
            semantic_available=True,
            duration_ms=int((time.perf_counter() - started) * 1000),
            manuals_in_scope=0,
        )

    manuals = []
    if deps.store is not None:
        try:
            manuals = await deps.store.find_manuals(scope)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"exact search unavailable: {str(exc)[:120]}")
            manuals = []
    manuals_in_scope = len(manuals)

    # Isolation: a selected model with zero manuals must not fall back.
    if scope.machine_model_id and not manuals:
        warnings.append("No indexed manuals found for the selected machine model.")

    if deps.store is not None and manuals:
        try:
            exact_hits = await exact_search(
                deps.store,
                extracted,
                scope,
                manuals,
                limit=deps.config.candidate_limit,
            )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"exact search failed: {str(exc)[:120]}")
            exact_hits = []

    if deps.vectors is None or deps.embedder is None:
        semantic_available = False
        warnings.append("semantic search unavailable")
    elif scope.machine_model_id and not manuals:
        semantic_available = True  # available, but correctly empty
    else:
        try:
            vector = await deps.embedder.embed_query(extracted.normalized)
            actual_dim = len(vector)
            collection_dim = await deps.vectors.collection_dimension()
            expected = deps.config.expected_embedding_dimension
            if collection_dim is not None and actual_dim != collection_dim:
                semantic_available = False
                warnings.append(
                    f"{EMBEDDING_MODEL_MISMATCH}: query dim {actual_dim} "
                    f"!= collection dim {collection_dim}"
                )
            elif expected and actual_dim != expected:
                semantic_available = False
                warnings.append(
                    f"{EMBEDDING_MODEL_MISMATCH}: query dim {actual_dim} != configured {expected}"
                )
            else:
                semantic_hits = await semantic_search(
                    deps.vectors,
                    vector,
                    extracted,
                    scope,
                    manuals,
                    limit=deps.config.candidate_limit,
                    embedding_model=deps.embedding_model,
                )
        except ServiceError as exc:
            semantic_available = False
            warnings.append(exc.message)
        except Exception as exc:  # noqa: BLE001
            semantic_available = False
            warnings.append(f"semantic search failed: {str(exc)[:120]}")

    merged = merge_hits(exact_hits, semantic_hits)
    ranked = rank_hits(
        merged,
        extracted,
        scope,
        deps.config.weights,
        near_duplicate_threshold=deps.config.near_duplicate_threshold,
    )
    if req.top_k:
        ranked = ranked[: max(req.top_k, deps.config.top_k)]

    # --- Phase 6: historical incident evidence (SUPPLEMENTARY) -------------
    # Only when the caller's organization is known and the query is scoped to
    # a machine or model. Organization filtering is enforced inside the
    # incident store/vector index - never delegated to the request.
    historical: list[HistoricalIncidentHit] = []
    if (
        deps.incident_memory_enabled
        and req.organization_id
        and (scope.machine_model_id or scope.machine_id)
    ):
        try:
            from app.incident_memory.similar import retrieve_similar_incidents

            historical, history_warnings = await retrieve_similar_incidents(
                store=deps.incident_store,
                vectors=deps.incident_vectors,
                embed_query=(
                    (lambda text: _embed_query_sync(deps, text))
                    if deps.embedder is not None
                    else None
                ),
                query={
                    "title": extracted.original[:200],
                    "machine_id": scope.machine_id,
                    "machine_model_id": scope.machine_model_id,
                    "error_codes": extracted.error_codes,
                    "symptoms": extracted.symptoms,
                    "operating_conditions": extracted.operating_conditions,
                },
                organization_id=req.organization_id,
                machine_model_id=scope.machine_model_id,
                exclude_incident_id="",
                limit=deps.incident_top_k,
                embedding_model=deps.embedding_model,
            )
            warnings.extend(history_warnings)
        except Exception as exc:  # noqa: BLE001 - history is supplementary
            warnings.append(f"historical incident retrieval failed: {str(exc)[:120]}")
            historical = []

    return RetrievalTrace(
        extracted=extracted,
        scope=scope,
        exact=exact_hits,
        semantic=semantic_hits,
        merged=merged,
        ranked=ranked,
        selected=[],
        warnings=warnings,
        semantic_available=semantic_available,
        duration_ms=int((time.perf_counter() - started) * 1000),
        manuals_in_scope=manuals_in_scope,
        historical=historical,
    )


def _debug_payload(
    req: PipelineRequest,
    trace: RetrievalTrace,
    *,
    prompt_meta: dict[str, Any] | None = None,
    citation: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not req.debug:
        return {}
    payload: dict[str, Any] = {
        "query_hash": query_hash(req.query),
        "normalized_query": trace.extracted.normalized,
        "applied_filters": _scope_public(trace.scope),
        "manuals_in_scope": trace.manuals_in_scope,
        "exact_results": [h.to_public_dict() for h in trace.exact[:20]],
        "semantic_results": [h.to_public_dict() for h in trace.semantic[:20]],
        "historical_results": [h.to_public_dict() for h in trace.historical[:10]],
        "ranking_scores": [
            {
                "chunk_id": h.chunk_id,
                "final_score": round(h.final_score, 4),
                "semantic_score": h.semantic_score,
                "exact_match": h.exact_match,
                "retrieval_source": h.retrieval_source,
            }
            for h in trace.ranked[:20]
        ],
        "selected_chunks": [h.to_public_dict() for h in trace.selected],
        "prompt_metadata": prompt_meta
        or {"prompt_version": deps_prompt_version()},
        "citation_validation": citation or {},
        "duration_ms": trace.duration_ms,
    }
    if extra:
        payload.update(extra)
    return payload


def deps_prompt_version() -> str:
    from app.rag.settings import PROMPT_VERSION

    return PROMPT_VERSION


async def run_search(req: PipelineRequest, deps: PipelineDeps) -> dict[str, Any]:
    trace = await retrieve(req, deps)
    extracted = trace.extracted
    scope = trace.scope

    if extracted.requires_machine_scope and not (scope.machine_model_id or scope.manual_id):
        answer = empty_answer(
            status="clarification_required",
            extracted=extracted,
            scope=scope,
            reason=MACHINE_MODEL_REQUIRED,
            message=REFUSAL_MESSAGES[MACHINE_MODEL_REQUIRED],
            warnings=trace.warnings,
            debug=_debug_payload(req, trace) or None,
        )
        return answer.to_dict() | {
            "results": [],
        }

    decision = select_evidence(
        trace.ranked,
        extracted,
        scope,
        deps.config,
        semantic_available=trace.semantic_available,
    )
    trace.selected = assign_source_ids(decision.selected)
    results = [h.to_public_dict() for h in trace.ranked[: deps.config.top_k]]
    payload = {
        "status": "retrieved" if trace.ranked else decision.status,
        "query": _query_public(extracted),
        "scope": _scope_public(scope),
        "results": results,
        "retrieval": _retrieval_public(
            len(trace.exact), len(trace.semantic), len(trace.selected)
        ),
        "warnings": [*trace.warnings, *decision.warnings],
        "reason": decision.reason,
        "message": decision.message,
    }
    log.info(
        "retrieval_completed",
        query_hash=query_hash(req.query),
        status=payload["status"],
        machine_model_id=scope.machine_model_id,
        manual_id=scope.manual_id,
        exact_matches=len(trace.exact),
        semantic_matches=len(trace.semantic),
        selected_chunk_count=len(trace.selected),
        duration_ms=trace.duration_ms,
    )
    if req.debug:
        payload["debug"] = _debug_payload(req, trace)
    return payload


def _confidence(
    decision_status: str, selected: list[RetrievalHit], extracted: ExtractedQuery
) -> str:
    if decision_status == "conflicting_evidence":
        return "low"
    exact = any(h.exact_match for h in selected)
    strong_semantic = any(
        (h.semantic_score or 0) >= 0.7 for h in selected
    )
    if exact and (strong_semantic or len(selected) >= 2):
        return "high"
    if exact or strong_semantic:
        return "medium"
    return "low"


async def run_answer(req: PipelineRequest, deps: PipelineDeps) -> RagAnswer:
    started = time.perf_counter()
    trace = await retrieve(req, deps)
    extracted = trace.extracted
    scope = trace.scope

    if extracted.requires_machine_scope and not (scope.machine_model_id or scope.manual_id):
        return empty_answer(
            status="clarification_required",
            extracted=extracted,
            scope=scope,
            reason=MACHINE_MODEL_REQUIRED,
            message=REFUSAL_MESSAGES[MACHINE_MODEL_REQUIRED],
            warnings=trace.warnings,
            debug=_debug_payload(req, trace) or None,
        )

    qdrant_error = next(
        (
            w
            for w in trace.warnings
            if "semantic" in w.lower()
            or "qdrant" in w.lower()
            or EMBEDDING_MODEL_MISMATCH in w
        ),
        None,
    )
    decision = select_evidence(
        trace.ranked,
        extracted,
        scope,
        deps.config,
        semantic_available=trace.semantic_available,
        qdrant_error=qdrant_error,
    )

    if decision.status == "clarification_required":
        return empty_answer(
            status="clarification_required",
            extracted=extracted,
            scope=scope,
            reason=decision.reason,
            message=decision.message,
            warnings=[*trace.warnings, *decision.warnings],
            debug=_debug_payload(req, trace) or None,
        )

    if decision.status == "processing_unavailable":
        return empty_answer(
            status="processing_unavailable",
            extracted=extracted,
            scope=scope,
            reason=decision.reason,
            message=decision.message,
            warnings=[*trace.warnings, *decision.warnings],
            retrieval=_retrieval_public(len(trace.exact), len(trace.semantic), 0),
            debug=_debug_payload(req, trace) or None,
        )

    if not decision.sufficient or decision.status == "insufficient_evidence":
        relevant = [
            h
            for h in decision.selected
            if h.exact_match or (h.semantic_score or 0) >= deps.config.min_semantic_score
        ]
        assign_source_ids(relevant)
        sources = [s.to_dict() for s in sources_from_hits(relevant)]
        return empty_answer(
            status="insufficient_evidence",
            extracted=extracted,
            scope=scope,
            reason=decision.reason,
            message=decision.message
            or REFUSAL_MESSAGES.get(decision.reason or "", None),
            warnings=[*trace.warnings, *decision.warnings],
            sources=sources,
            retrieval=_retrieval_public(
                len(trace.exact), len(trace.semantic), len(relevant)
            ),
            debug=_debug_payload(req, trace) or None,
        )

    selected = maybe_combine_adjacent(decision.selected)
    selected = select_for_context(selected, max_chars=deps.config.max_context_chars)
    selected = assign_source_ids(selected)
    trace.selected = selected
    source_refs = sources_from_hits(selected)
    evidence_block = format_evidence_block(selected)
    if len(evidence_block) > deps.config.max_prompt_chars:
        evidence_block = clip_text_at_boundary(evidence_block, deps.config.max_prompt_chars)

    # --- Historical incident evidence: clearly labeled, supplementary only ---
    from app.rag.context import format_historical_evidence_block
    from app.rag.types import SourceRef as IncidentSourceRef

    historical_block = ""
    historical_source_refs: list[Any] = []
    for index, hit in enumerate(trace.historical, start=1):
        incident = hit.incident
        ref = IncidentSourceRef(
            source_id=f"history-{index}",
            chunk_id=incident.incident_id,
            manual_id="",
            manual_title=f"INCIDENT {incident.incident_number}",
            manual_version=None,
            page_start=0,
            page_end=0,
            section_title=None,
            machine_model_id=incident.machine_model_id,
            excerpt=None,
            source_type="incident",
            incident_number=incident.incident_number,
            incident_resolved_at=incident.resolved_at,
        )
        historical_source_refs.append(ref)
    if trace.historical:
        historical_block = format_historical_evidence_block(
            trace.historical, max_chars=deps.incident_max_context_chars
        )

    # --- Phase 7 maintenance lane: separate evidence class, never manual ---
    from app.rag.maintenance import (
        build_maintenance_evidence,
        build_maintenance_source_refs,
        format_maintenance_context_block,
    )

    maintenance_evidence = (
        build_maintenance_evidence(
            req.maintenance_context, req.query_at, extracted.original, selected
        )
        if req.maintenance_context
        else []
    )
    maintenance_block = (
        format_maintenance_context_block(maintenance_evidence, max_chars=1_500)
        if maintenance_evidence
        else ""
    )
    maintenance_source_refs = build_maintenance_source_refs(maintenance_evidence)

    all_source_refs = [
        *source_refs,
        *historical_source_refs,
        *maintenance_source_refs,
    ]
    precedence_notes = list(decision.conflicts)
    if trace.historical:
        precedence_notes.append(
            "Manual evidence is authoritative. Historical incident notes are "
            "supplementary context that may be machine-specific; they must "
            "never override manual instructions."
        )
    if maintenance_evidence:
        precedence_notes.append(
            "Maintenance history is NON-CAUSAL context. It can never confirm a "
            "root cause or fix, and it never appears as manual evidence."
        )

    messages = build_messages(
        extracted=extracted,
        scope=scope,
        evidence_block=evidence_block,
        historical_evidence_block=historical_block,
        maintenance_block=maintenance_block,
        allowed_source_ids=[s.source_id for s in all_source_refs],
        conflict_notes=precedence_notes,
        conversation_context=req.conversation_context,
    )
    prompt_meta = {
        "prompt_version": deps_prompt_version(),
        "evidence_chars": len(evidence_block),
        "source_count": len(source_refs),
        "message_chars": sum(len(m["content"]) for m in messages),
    }

    if deps.generator is None:
        labels = [s.citation_label() for s in source_refs]
        evidence_only = "Sources\n" + "\n".join(labels) if labels else None
        return empty_answer(
            status="generation_failed",
            extracted=extracted,
            scope=scope,
            reason=OLLAMA_UNAVAILABLE,
            message=REFUSAL_MESSAGES[OLLAMA_UNAVAILABLE],
            warnings=[*trace.warnings, *decision.warnings],
            sources=[s.to_dict() for s in all_source_refs],
            retrieval=_retrieval_public(
                len(trace.exact), len(trace.semantic), len(selected)
            ),
            debug=_debug_payload(req, trace, prompt_meta=prompt_meta) or None,
            answer=evidence_only,
        )

    try:
        await deps.generator.ensure_chat_model(deps.config.chat_model)
        raw = await deps.generator.generate(
            messages,
            temperature=deps.config.temperature,
            max_tokens=deps.config.max_output_tokens,
            timeout_s=deps.config.request_timeout_ms / 1000,
        )
    except ServiceError as exc:
        return empty_answer(
            status="generation_failed",
            extracted=extracted,
            scope=scope,
            reason=OLLAMA_UNAVAILABLE,
            message=exc.message,
            warnings=[*trace.warnings, *decision.warnings],
            sources=[s.to_dict() for s in all_source_refs],
            retrieval=_retrieval_public(
                len(trace.exact), len(trace.semantic), len(selected)
            ),
            debug=_debug_payload(req, trace, prompt_meta=prompt_meta) or None,
        )
    except Exception as exc:  # noqa: BLE001
        return empty_answer(
            status="generation_failed",
            extracted=extracted,
            scope=scope,
            reason=OLLAMA_UNAVAILABLE,
            message=str(exc)[:200],
            warnings=[*trace.warnings, *decision.warnings],
            sources=[s.to_dict() for s in all_source_refs],
            retrieval=_retrieval_public(
                len(trace.exact), len(trace.semantic), len(selected)
            ),
            debug=_debug_payload(req, trace, prompt_meta=prompt_meta) or None,
        )

    parsed = parse_model_json(raw)
    regenerated = False
    if parsed is None:
        try:
            raw = await deps.generator.generate(
                regeneration_messages(messages, reason="output was not valid JSON"),
                temperature=0.0,
                max_tokens=deps.config.max_output_tokens,
                timeout_s=deps.config.request_timeout_ms / 1000,
            )
            parsed = parse_model_json(raw)
            regenerated = True
        except Exception:  # noqa: BLE001
            parsed = None

    if parsed is None:
        return empty_answer(
            status="generation_failed",
            extracted=extracted,
            scope=scope,
            reason="INVALID_MODEL_OUTPUT",
            message="The model did not return a usable structured answer.",
            warnings=[*trace.warnings, *decision.warnings],
            sources=[s.to_dict() for s in source_refs],
            retrieval=_retrieval_public(
                len(trace.exact), len(trace.semantic), len(selected)
            ),
            debug=_debug_payload(
                req,
                trace,
                prompt_meta=prompt_meta,
                citation={"valid": False, "regenerated": regenerated},
            )
            or None,
        )

    if parsed.get("evidence_insufficient") is True and not deps.config.allow_unsupported_answer:
        return empty_answer(
            status="insufficient_evidence",
            extracted=extracted,
            scope=scope,
            reason="MODEL_DECLARED_INSUFFICIENT",
            message=(parsed.get("summary") or REFUSAL_MESSAGES["INSUFFICIENT_EVIDENCE"]),
            warnings=[*trace.warnings, *decision.warnings],
            sources=[s.to_dict() for s in source_refs],
            retrieval=_retrieval_public(
                len(trace.exact), len(trace.semantic), len(selected)
            ),
            debug=_debug_payload(req, trace, prompt_meta=prompt_meta) or None,
        )

    draft = format_answer_from_structured(parsed, [s.citation_label() for s in all_source_refs])
    cleaned_payload, cleaned_text, report = validate_citations(
        parsed, draft, all_source_refs, selected
    )
    if not report.valid:
        try:
            raw = await deps.generator.generate(
                regeneration_messages(
                    messages,
                    reason="; ".join(report.details) or "citations were invalid",
                ),
                temperature=0.0,
                max_tokens=deps.config.max_output_tokens,
                timeout_s=deps.config.request_timeout_ms / 1000,
            )
            parsed_retry = parse_model_json(raw)
            regenerated = True
            if parsed_retry is not None:
                draft = format_answer_from_structured(
                    parsed_retry, [s.citation_label() for s in all_source_refs]
                )
                cleaned_payload, cleaned_text, report = validate_citations(
                    parsed_retry, draft, all_source_refs, selected
                )
                report.regenerated = True
        except Exception:  # noqa: BLE001
            report.regenerated = True

    if not report.valid and report.dropped:
        # Never silently accept invented source ids. Return evidence-only.
        return empty_answer(
            status="generation_failed",
            extracted=extracted,
            scope=scope,
            reason="CITATION_VALIDATION_FAILED",
            message="The generated answer cited sources that are not in the retrieved evidence.",
            warnings=[*trace.warnings, *decision.warnings, *report.details],
            sources=[s.to_dict() for s in source_refs],
            retrieval=_retrieval_public(
                len(trace.exact), len(trace.semantic), len(selected)
            ),
            debug=_debug_payload(
                req,
                trace,
                prompt_meta=prompt_meta,
                citation={
                    "valid": False,
                    "dropped": report.dropped,
                    "page_mismatches": report.page_mismatches,
                    "regenerated": report.regenerated or regenerated,
                },
            )
            or None,
        )

    cited = sources_for_ids(cleaned_payload.get("cited_source_ids") or [], all_source_refs)
    # Maintenance facts belong to the machine, not to the model's claims: show
    # the lane even when the answer does not cite it.
    final_sources = [*cited]
    seen_ids = {ref.source_id for ref in cited}
    for ref in maintenance_source_refs:
        if ref.source_id not in seen_ids:
            final_sources.append(ref)
            seen_ids.add(ref.source_id)
    labels = [s.citation_label() for s in final_sources]
    suggested_actions: list[dict[str, Any]] = []
    checks = [str(c).strip() for c in (cleaned_payload.get("recommended_checks") or []) if str(c).strip()]
    cited_ids = [s.source_id for s in cited]
    for index, check in enumerate(checks, start=1):
        suggested_actions.append(
            {
                "id": f"suggestion-{index}",
                "description": check,
                "source_ids": cited_ids,
                "status": "suggested",
            }
        )
    # Rebuild the Sources section from validated metadata only.
    body = cleaned_text
    if "\nSources\n" in body:
        body = body.split("\nSources\n", 1)[0].rstrip()
    if labels:
        body = f"{body}\n\nSources\n" + "\n".join(labels)

    status = decision.status if decision.status == "conflicting_evidence" else "answered"
    warnings = [*trace.warnings, *decision.warnings]
    if report.repaired:
        warnings.append("Invented page numbers were removed from the generated answer.")
    if report.regenerated or regenerated:
        warnings.append("The model output was regenerated after citation validation failed.")

    duration = int((time.perf_counter() - started) * 1000)
    return RagAnswer(
        status=status,  # type: ignore[arg-type]
        answer=body,
        confidence=_confidence(status, selected, extracted),  # type: ignore[arg-type]
        evidence_sufficient=True,
        query=_query_public(extracted),
        scope=_scope_public(scope),
        sources=[s.to_dict() for s in final_sources],
        retrieval=_retrieval_public(
            len(trace.exact),
            len(trace.semantic),
            len(selected),
            extra={
                "duration_ms": duration,
                "historical_matches": len(trace.historical),
                "maintenance_items": len(maintenance_evidence),
            },
        ),
        warnings=warnings,
        reason=decision.reason if status == "conflicting_evidence" else None,
        message=decision.message if status == "conflicting_evidence" else None,
        suggested_actions=suggested_actions,
        debug=_debug_payload(
            req,
            trace,
            prompt_meta=prompt_meta,
            citation={
                "valid": report.valid or report.repaired,
                "dropped": report.dropped,
                "page_mismatches": report.page_mismatches,
                "regenerated": report.regenerated or regenerated,
                "repaired": report.repaired,
            },
        )
        or None,
    )


class SettingsEmbedder:
    def __init__(self, client: OllamaEmbeddingClient) -> None:
        self.client = client

    async def ping(self) -> None:
        await self.client.ping()

    async def embed_query(self, text: str) -> list[float]:
        vectors = await self.client.embed([text], prefix=QUERY_PREFIX)
        return vectors[0]


async def build_deps(
    settings: Settings,
    *,
    store: ChunkStore | None = None,
    embedder: Embedder | None = None,
    vectors: VectorIndex | None = None,
    generator: ChatGenerator | None = None,
    close_store: bool = False,
) -> PipelineDeps:
    """Construct runtime dependencies. Callers may inject fakes in tests."""
    del close_store  # reserved; routers close Mongo stores they create
    config = rag_config_from_settings(settings)
    warnings: list[str] = []

    resolved_store = store
    if resolved_store is None and settings.MONGODB_URI:
        resolved_store = MongoChunkStore(settings)
    elif resolved_store is None:
        warnings.append("exact search unavailable: MongoDB is not configured")

    resolved_embedder = embedder
    resolved_vectors = vectors
    if resolved_embedder is None or resolved_vectors is None:
        try:
            if resolved_embedder is None:
                resolved_embedder = SettingsEmbedder(OllamaEmbeddingClient(settings))
            if resolved_vectors is None:
                wrapper = new_qdrant_client(settings)
                resolved_vectors = QdrantVectorIndex(
                    wrapper, settings.QDRANT_MANUAL_COLLECTION
                )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"semantic clients failed to initialise: {str(exc)[:120]}")
            resolved_embedder = embedder
            resolved_vectors = vectors

    resolved_generator = generator
    if resolved_generator is None:
        if settings.OLLAMA_CHAT_MODEL:
            resolved_generator = OllamaChatClient(settings)
        else:
            warnings.append("chat model is not configured")

    # Phase 6 incident memory: supplementary historical evidence. Failure to
    # initialise degrades gracefully (no historical evidence, manual RAG still
    # works).
    incident_store: IncidentStore | None = None
    incident_vectors: IncidentVectorIndex | None = None
    incident_memory_enabled = False
    if settings.MONGODB_URI:
        try:
            from app.incident_memory.store import MongoIncidentStore

            incident_store = MongoIncidentStore(settings)
            incident_memory_enabled = True
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"incident memory store unavailable: {str(exc)[:120]}")
    try:
        from app.incident_memory.indexing import IncidentVectorIndex as IncIndex

        incident_vectors = IncIndex(new_qdrant_client(settings), settings.QDRANT_INCIDENT_COLLECTION)
        incident_memory_enabled = incident_memory_enabled or True
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"incident memory vectors unavailable: {str(exc)[:120]}")

    return PipelineDeps(
        store=resolved_store,
        embedder=resolved_embedder,
        vectors=resolved_vectors,
        generator=resolved_generator,
        config=config,
        embedding_model=settings.OLLAMA_EMBEDDING_MODEL,
        warnings=warnings,
        incident_store=incident_store,
        incident_vectors=incident_vectors,
        incident_memory_enabled=incident_memory_enabled,
        incident_top_k=settings.INCIDENT_HISTORY_TOP_K,
        incident_max_context_chars=settings.INCIDENT_HISTORY_MAX_CONTEXT_CHARS,
    )
