"""Internal contracts for retrieval and RAG.

These structures are the single shape every retrieval arm, the ranker, the
context builder and the citation validator share. They are NOT the public
Express wire format — Express maps snake_case to camelCase at the boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

RagStatus = Literal[
    "answered",
    "clarification_required",
    "insufficient_evidence",
    "conflicting_evidence",
    "processing_unavailable",
    "generation_failed",
]

Confidence = Literal["high", "medium", "low"]

QueryKind = Literal[
    "error_code",
    "troubleshooting",
    "procedure",
    "general",
    "manual_reference",
]


@dataclass(frozen=True)
class RankingWeights:
    exact_match: float = 0.35
    technical_term: float = 0.15
    machine_scope: float = 0.10
    manual_scope: float = 0.10
    semantic: float = 0.45
    section: float = 0.05
    duplicate_penalty: float = 0.05


@dataclass(frozen=True)
class RagRuntimeConfig:
    """Tunable retrieval/generation knobs. Built from Settings."""

    top_k: int = 8
    min_context_chunks: int = 1
    min_semantic_score: float = 0.45
    min_final_score: float = 0.45
    require_source_metadata: bool = True
    allow_unsupported_answer: bool = False
    max_context_chars: int = 12_000
    max_prompt_chars: int = 24_000
    temperature: float = 0.1
    max_output_tokens: int = 1200
    request_timeout_ms: int = 120_000
    candidate_limit: int = 40
    near_duplicate_threshold: float = 0.92
    weights: RankingWeights = field(default_factory=RankingWeights)
    log_query_text: bool = False
    chat_model: str = "llama3.1"
    embedding_model: str = "nomic-embed-text"
    expected_embedding_dimension: int = 768
    prompt_version: str = "rag-p4-v1"


@dataclass
class ExtractedQuery:
    original: str
    normalized: str
    error_codes: list[str]
    error_code_variants: list[str]
    part_numbers: list[str]
    model_numbers: list[str]
    units: list[str]
    technical_terms: list[str]
    component_names: list[str]
    symptoms: list[str]
    actions_attempted: list[str]
    operating_conditions: list[str]
    kind: QueryKind
    requires_machine_scope: bool
    named_manual: str | None = None
    named_version: str | None = None


@dataclass
class ScopeFilter:
    machine_id: str | None = None
    machine_model_id: str | None = None
    manual_id: str | None = None
    manual_version: str | None = None
    manual_type: str | None = None
    manufacturer: str | None = None
    include_inactive: bool = False
    general: bool = False


@dataclass
class ManualRecord:
    manual_id: str
    title: str
    version: str | None
    manual_type: str | None
    manufacturer: str | None
    language: str | None
    machine_model_id: str | None
    machine_id: str | None
    is_current_version: bool = True
    is_active: bool = True
    processing_status: str = "completed"
    page_count: int | None = None


@dataclass
class ChunkRecord:
    """A chunk as stored in Mongo (authoritative) or reconstructed from Qdrant."""

    chunk_id: str
    mongo_id: str | None
    manual_id: str
    machine_model_id: str | None
    machine_id: str | None
    chunk_index: int
    page_start: int
    page_end: int
    section_title: str | None
    section_path: list[str]
    text: str
    content_hash: str
    indexing_status: str = "indexed"
    embedding_model: str | None = None
    embedding_dimension: int | None = None
    qdrant_point_id: str | None = None
    # Optional citation metadata copied from the Qdrant payload when Mongo is
    # not joined. Mongo remains authoritative when both are present.
    manual_title: str | None = None
    manual_version: str | None = None
    manual_type: str | None = None
    manufacturer: str | None = None
    is_current_version: bool = True
    language: str | None = None


@dataclass
class RetrievalHit:
    chunk_id: str
    manual_id: str
    machine_model_id: str | None
    manual_title: str
    manual_version: str | None
    manual_type: str | None
    manufacturer: str | None
    page_start: int
    page_end: int
    section_title: str | None
    section_path: list[str]
    text: str
    content_hash: str
    chunk_index: int
    exact_match: bool = False
    matched_terms: list[str] = field(default_factory=list)
    semantic_score: float | None = None
    final_score: float = 0.0
    retrieval_source: list[str] = field(default_factory=list)
    is_current_version: bool = True
    is_active: bool = True
    language: str | None = None
    source_id: str | None = None

    def to_public_dict(self, *, include_text: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chunk_id": self.chunk_id,
            "manual_id": self.manual_id,
            "machine_model_id": self.machine_model_id,
            "manual_title": self.manual_title,
            "manual_version": self.manual_version,
            "manual_type": self.manual_type,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "section_title": self.section_title,
            "section_path": self.section_path,
            "exact_match": self.exact_match,
            "matched_terms": self.matched_terms,
            "semantic_score": self.semantic_score,
            "final_score": round(self.final_score, 4),
            "retrieval_source": self.retrieval_source,
            "source_id": self.source_id,
        }
        if include_text:
            payload["text"] = self.text
        return payload


@dataclass
class SourceRef:
    source_id: str
    chunk_id: str
    manual_id: str
    manual_title: str
    manual_version: str | None
    page_start: int
    page_end: int
    section_title: str | None
    machine_model_id: str | None = None
    excerpt: str | None = None
    source_type: Literal["manual", "incident", "maintenance"] = "manual"
    # Incident-source fields (source_type == "incident")
    incident_number: str | None = None
    incident_resolved_at: str | None = None
    # Maintenance-source fields (source_type == "maintenance")
    maintenance_id: str | None = None
    days_before_incident: int | None = None
    correlation_strength: str | None = None
    causal_claim: bool = False
    noted_by_manual: bool = False
    noted_by_manual_source_id: str | None = None

    def citation_label(self) -> str:
        if self.source_type == "incident":
            label = f"HISTORICAL INCIDENT {self.incident_number or self.chunk_id}"
            if self.incident_resolved_at:
                label += f" ({self.incident_resolved_at[:10]})"
            return f"[{label} — historical context]"
        if self.source_type == "maintenance":
            when = f", {self.days_before_incident} days before" if self.days_before_incident is not None else ""
            return (
                f"[MAINTENANCE {self.section_title or self.chunk_id}{when}"
                " — non-causal context]"
            )
        version = f", version {self.manual_version}" if self.manual_version else ""
        if self.page_start == self.page_end:
            pages = f"p. {self.page_start}"
        else:
            pages = f"pp. {self.page_start}–{self.page_end}"
        section = f", {self.section_title}" if self.section_title else ""
        return f"[{self.manual_title}{version}, {pages}{section}]"

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "source_id": self.source_id,
            "chunk_id": self.chunk_id,
            "manual_id": self.manual_id,
            "manual_title": self.manual_title,
            "manual_version": self.manual_version,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "section_title": self.section_title,
            "machine_model_id": self.machine_model_id,
            "source_type": self.source_type,
        }
        if self.source_type == "incident":
            payload["incident_number"] = self.incident_number
            payload["incident_resolved_at"] = self.incident_resolved_at
        if self.source_type == "maintenance":
            payload["maintenance_id"] = self.maintenance_id
            payload["days_before_incident"] = self.days_before_incident
            payload["correlation_strength"] = self.correlation_strength
            payload["causal_claim"] = self.causal_claim
            payload["noted_by_manual"] = self.noted_by_manual
            payload["noted_by_manual_source_id"] = self.noted_by_manual_source_id
        if self.excerpt:
            payload["excerpt"] = self.excerpt
        return payload


@dataclass
class HistoricalIncident:
    """A past incident retrieved as SUPPLEMENTARY evidence. Never authoritative."""

    incident_id: str
    organization_id: str
    machine_id: str | None
    machine_model_id: str | None
    incident_number: str
    title: str
    status: str
    issue_status: str
    severity: str
    error_codes: list[str]
    symptoms: list[str]
    operating_conditions: list[str]
    root_cause_status: str
    confirmed_root_cause: str | None
    confirmed_fix: str | None
    resolution_summary: str | None
    resolved_at: str | None
    created_at: str
    qdrant_point_id: str | None = None

    @property
    def confirmed(self) -> bool:
        return bool(self.confirmed_root_cause and self.confirmed_fix)

    def to_public_dict(self, *, include_text: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "incident_id": self.incident_id,
            "organization_id": self.organization_id,
            "machine_id": self.machine_id,
            "machine_model_id": self.machine_model_id,
            "incident_number": self.incident_number,
            "title": self.title,
            "status": self.status,
            "issue_status": self.issue_status,
            "severity": self.severity,
            "error_codes": self.error_codes,
            "symptoms": self.symptoms,
            "root_cause_status": self.root_cause_status,
            "confirmed_root_cause": self.confirmed_root_cause,
            "confirmed_fix": self.confirmed_fix,
            "resolution_summary": self.resolution_summary,
            "resolved_at": self.resolved_at,
            "created_at": self.created_at,
            "confirmed": self.confirmed,
        }
        if include_text:
            payload["operating_conditions"] = self.operating_conditions
        return payload


@dataclass
class HistoricalIncidentHit:
    """A ranked historical incident with similarity reasons."""

    incident: HistoricalIncident
    score: float
    reasons: list[str]
    semantic_score: float | None = None
    exact_error_code: bool = False
    same_machine: bool = False
    same_model: bool = False

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "incident": self.incident.to_public_dict(),
            "score": round(self.score, 4),
            "reasons": self.reasons,
            "semantic_score": (
                round(self.semantic_score, 4) if self.semantic_score is not None else None
            ),
            "exact_error_code": self.exact_error_code,
            "same_machine": self.same_machine,
            "same_model": self.same_model,
            "confirmed": self.incident.confirmed,
        }


class IncidentStore(Protocol):
    """Read-only access to incident metadata (Mongo). Express owns writes."""

    async def find_incidents_by_ids(self, incident_ids: list[str]) -> list[HistoricalIncident]: ...

    async def find_exact_error_code_matches(
        self,
        *,
        organization_id: str,
        machine_model_id: str,
        error_codes: list[str],
        exclude_incident_id: str | None,
        limit: int,
    ) -> list[HistoricalIncident]: ...


class IncidentVectorIndex(Protocol):
    """Incident Qdrant operations (separate collection from manual chunks)."""

    async def ensure_collection(self, dimension: int) -> None: ...

    async def upsert_incident(
        self,
        incident: HistoricalIncident,
        vector: list[float],
        *,
        embedding_model: str,
    ) -> str: ...

    async def delete_incident(self, incident_id: str) -> bool: ...

    async def search(
        self,
        vector: list[float],
        *,
        organization_id: str,
        machine_model_id: str | None,
        exclude_incident_id: str | None,
        limit: int,
        embedding_model: str,
    ) -> list[tuple[HistoricalIncident, float]]: ...


@dataclass
class EvidenceDecision:
    sufficient: bool
    status: RagStatus
    reason: str | None
    message: str | None
    warnings: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    selected: list[RetrievalHit] = field(default_factory=list)


@dataclass
class CitationReport:
    valid: bool
    dropped: list[str] = field(default_factory=list)
    page_mismatches: list[str] = field(default_factory=list)
    regenerated: bool = False
    repaired: bool = False
    details: list[str] = field(default_factory=list)


@dataclass
class RagAnswer:
    status: RagStatus
    answer: str | None
    confidence: Confidence | None
    evidence_sufficient: bool
    query: dict[str, Any]
    scope: dict[str, Any]
    sources: list[dict[str, Any]]
    retrieval: dict[str, Any]
    warnings: list[str] = field(default_factory=list)
    reason: str | None = None
    message: str | None = None
    debug: dict[str, Any] | None = None
    suggested_actions: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "status": self.status,
            "answer": self.answer,
            "confidence": self.confidence,
            "evidence_sufficient": self.evidence_sufficient,
            "query": self.query,
            "scope": self.scope,
            "sources": self.sources,
            "retrieval": self.retrieval,
            "warnings": self.warnings,
            "suggested_actions": self.suggested_actions,
        }
        if self.reason:
            payload["reason"] = self.reason
        if self.message:
            payload["message"] = self.message
        if self.debug is not None:
            payload["debug"] = self.debug
        return payload


class ChunkStore(Protocol):
    """Read-only access to manuals + chunks (Mongo or an in-memory stand-in)."""

    async def find_manuals(self, scope: ScopeFilter) -> list[ManualRecord]: ...

    async def find_chunks(
        self,
        *,
        manual_ids: list[str],
        patterns: list[str],
        limit: int,
    ) -> list[ChunkRecord]: ...

    async def get_chunks_by_ids(self, chunk_ids: list[str]) -> list[ChunkRecord]: ...


class VectorIndex(Protocol):
    async def search(
        self,
        vector: list[float],
        *,
        scope: ScopeFilter,
        allowed_manual_ids: list[str] | None,
        limit: int,
        embedding_model: str,
    ) -> list[tuple[ChunkRecord, float]]: ...

    async def collection_dimension(self) -> int | None: ...


class Embedder(Protocol):
    async def embed_query(self, text: str) -> list[float]: ...

    async def ping(self) -> None: ...


class ChatGenerator(Protocol):
    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int,
        timeout_s: float,
        allowed_source_ids: list[str] | None = None,
    ) -> str: ...

    async def ensure_chat_model(self, model: str) -> None: ...
