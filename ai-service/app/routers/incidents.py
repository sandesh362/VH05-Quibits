"""Internal incident-memory endpoints (Express -> FastAPI).

Express owns incident data and authorization; these endpoints own incident
embedding, Qdrant indexing/deletion, and similar-incident retrieval. All
requests carry the internal service token. The organization id passed by
Express is a hard filter in every Mongo and Qdrant query - it is never
guessed or defaulted.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.clients.ollama import DOCUMENT_PREFIX, QUERY_PREFIX, OllamaEmbeddingClient
from app.clients.qdrant import new_qdrant_client
from app.core.auth import require_internal_token
from app.core.config import get_settings
from app.core.errors import ServiceError, success_envelope
from app.core.logging import get_logger
from app.core.middleware import get_request_id
from app.incident_memory.indexing import IncidentVectorIndex
from app.incident_memory.qdrant_helpers import build_incident_embedding_text
from app.incident_memory.similar import retrieve_similar_incidents
from app.incident_memory.store import MongoIncidentStore
from app.rag.types import HistoricalIncident

router = APIRouter(tags=["incidents"])
log = get_logger()


class IncidentIndexRequestModel(BaseModel):
    incident_id: str = Field(min_length=24, max_length=24)
    organization_id: str = Field(min_length=24, max_length=24)
    machine_id: str = Field(min_length=24, max_length=24)
    machine_model_id: str = Field(min_length=24, max_length=24)
    incident_number: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    source: str = Field(default="other")
    status: str = Field(default="open")
    issue_status: str = Field(default="unknown")
    severity: str = Field(default="medium")
    priority: str = Field(default="medium")
    error_codes: list[str] = Field(default_factory=list)
    symptoms: list[str] = Field(default_factory=list)
    operating_conditions: list[str] = Field(default_factory=list)
    root_cause_status: str = Field(default="unknown")
    confirmed_root_cause: str | None = None
    confirmed_fix: str | None = None
    resolution_summary: str | None = None
    resolved_at: str | None = None
    created_at: str | None = None
    tags: list[str] = Field(default_factory=list)


class IncidentDeleteRequestModel(BaseModel):
    incident_id: str = Field(min_length=24, max_length=24)


class IncidentSimilarRequestModel(BaseModel):
    incident: dict[str, Any]
    organization_id: str = Field(min_length=24, max_length=24)
    limit: int = Field(default=10, ge=1, le=25)


def _to_historical(payload: IncidentIndexRequestModel) -> HistoricalIncident:
    return HistoricalIncident(
        incident_id=payload.incident_id,
        organization_id=payload.organization_id,
        machine_id=payload.machine_id,
        machine_model_id=payload.machine_model_id,
        incident_number=payload.incident_number,
        title=payload.title,
        status=payload.status,
        issue_status=payload.issue_status,
        severity=payload.severity,
        error_codes=payload.error_codes,
        symptoms=payload.symptoms,
        operating_conditions=payload.operating_conditions,
        root_cause_status=payload.root_cause_status,
        confirmed_root_cause=payload.confirmed_root_cause,
        confirmed_fix=payload.confirmed_fix,
        resolution_summary=payload.resolution_summary,
        resolved_at=payload.resolved_at,
        created_at=payload.created_at or "",
    )


@router.post("/incidents/index")
async def index_incident(
    payload: IncidentIndexRequestModel,
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Embed one incident and upsert it into the incident_memory collection."""
    settings = get_settings()
    embedder = OllamaEmbeddingClient(settings)
    index = IncidentVectorIndex(new_qdrant_client(settings), settings.QDRANT_INCIDENT_COLLECTION)

    try:
        embedding_text = build_incident_embedding_text(
            {
                "incident_number": payload.incident_number,
                "title": payload.title,
                "error_codes": payload.error_codes,
                "symptoms": payload.symptoms,
                "operating_conditions": payload.operating_conditions,
                "confirmed_root_cause": payload.confirmed_root_cause,
                "confirmed_fix": payload.confirmed_fix,
                "resolution_summary": payload.resolution_summary,
            }
        )
        if not embedding_text:
            # Nothing factual to embed - refuse rather than fabricate.
            raise ServiceError(
                "VALIDATION_ERROR",
                "The incident has no embeddable factual content.",
            )

        vectors = await embedder.embed([embedding_text], prefix=DOCUMENT_PREFIX)
        vector = vectors[0]
        await index.ensure_collection(len(vector))
        point_id = await index.upsert_incident(
            _to_historical(payload),
            vector,
            embedding_model=settings.OLLAMA_EMBEDDING_MODEL,
        )
        return success_envelope(
            {
                "qdrant_point_id": point_id,
                "embedding_model": settings.OLLAMA_EMBEDDING_MODEL,
                "status": "indexed",
            },
            get_request_id(request),
        )
    finally:
        await index.wrapper.close()


@router.post("/incidents/delete")
async def delete_incident_vectors(
    payload: IncidentDeleteRequestModel,
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Delete an incident's Qdrant point (idempotent)."""
    settings = get_settings()
    index = IncidentVectorIndex(new_qdrant_client(settings), settings.QDRANT_INCIDENT_COLLECTION)
    try:
        deleted = await index.delete_incident(payload.incident_id)
        return success_envelope({"deleted": deleted}, get_request_id(request))
    finally:
        await index.wrapper.close()


@router.post("/incidents/similar")
async def similar_incidents(
    payload: IncidentSimilarRequestModel,
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Retrieve and rank similar historical incidents for one incident."""
    settings = get_settings()
    store: MongoIncidentStore | None = None
    if settings.MONGODB_URI:
        store = MongoIncidentStore(settings)

    vectors: IncidentVectorIndex | None = None
    embedder: OllamaEmbeddingClient | None = None
    try:
        vectors = IncidentVectorIndex(
            new_qdrant_client(settings), settings.QDRANT_INCIDENT_COLLECTION
        )
        embedder = OllamaEmbeddingClient(settings)
    except Exception as exc:  # noqa: BLE001
        log.warning("incident_similar_qdrant_unavailable", error=str(exc)[:120])

    async def embed_query(text: str) -> list[float]:
        if embedder is None:
            raise ServiceError("SERVICE_UNAVAILABLE", "Embedding unavailable.")
        vectors_out = await embedder.embed([text], prefix=QUERY_PREFIX)
        return vectors_out[0]

    try:
        ranked, warnings = await retrieve_similar_incidents(
            store=store,
            vectors=vectors,
            embed_query=embed_query if embedder is not None else None,
            query=payload.incident,
            organization_id=payload.organization_id,
            machine_model_id=payload.incident.get("machine_model_id"),
            exclude_incident_id=str(payload.incident.get("incident_id") or ""),
            limit=payload.limit,
            embedding_model=settings.OLLAMA_EMBEDDING_MODEL,
        )
        return success_envelope(
            {
                "similar": [
                    {
                        "incident_id": hit.incident.incident_id,
                        "qdrant_point_id": hit.incident.qdrant_point_id,
                        "similarity_score": hit.score,
                        "reasons": hit.reasons,
                        "confirmed": hit.incident.confirmed,
                    }
                    for hit in ranked
                ],
                "warnings": warnings,
            },
            get_request_id(request),
        )
    finally:
        if store is not None:
            await store.close()
        if vectors is not None:
            await vectors.wrapper.close()
