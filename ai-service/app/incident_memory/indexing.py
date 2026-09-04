"""Incident vector index: the `incident_memory` Qdrant collection.

A SEPARATE collection from `manual_chunks` (docs/QDRANT_DESIGN.md). Mongo
remains authoritative for incident data; this collection is a derived,
rebuildable index. Point ids are deterministic so a retry overwrites instead
of duplicating, and stale points are removed on incident cancellation/deletion.
"""

from __future__ import annotations

import logging
from typing import Any

from qdrant_client import models

from app.clients.qdrant import QdrantClientWrapper
from app.core.errors import ServiceError
from app.core.logging import get_logger
from app.incident_memory.qdrant_helpers import (
    INCIDENT_PAYLOAD_INDEX_FIELDS,
    build_incident_payload,
    incident_filter,
    incident_point_id,
)
from app.rag.types import HistoricalIncident

log = get_logger()

EMBEDDING_VERSION_PREFIX = "inc-v1"


def embedding_version_for(model_name: str) -> str:
    """Embedding version string used in point ids and payloads."""
    return f"{EMBEDDING_VERSION_PREFIX}:{model_name}"


class IncidentVectorIndex:
    def __init__(self, wrapper: QdrantClientWrapper, collection: str) -> None:
        self.wrapper = wrapper
        self.collection = collection

    async def ensure_collection(self, dimension: int) -> None:
        """Create the collection if missing; assert dimension if present."""
        try:
            info = await self.wrapper.client.get_collection(self.collection)
        except Exception:  # noqa: BLE001 - collection likely absent
            await self.wrapper.client.create_collection(
                collection_name=self.collection,
                vectors_config=models.VectorParams(
                    size=dimension, distance=models.Distance.COSINE
                ),
            )
            await self._ensure_payload_indexes()
            log.info(
                "incident_collection_created",
                collection=self.collection,
                dimension=dimension,
            )
            return

        vectors = info.config.params.vectors
        if isinstance(vectors, dict):
            vectors = next(iter(vectors.values()), None)
        existing_dim = getattr(vectors, "size", None)
        if existing_dim != dimension:
            raise ServiceError(
                "INTERNAL_SERVER_ERROR",
                (
                    f"Qdrant incident collection '{self.collection}' has dimension "
                    f"{existing_dim} but the embedding model produces {dimension}. "
                    "Refusing to index."
                ),
            )
        await self._ensure_payload_indexes()

    async def _ensure_payload_indexes(self) -> None:
        for field, schema in INCIDENT_PAYLOAD_INDEX_FIELDS:
            try:
                await self.wrapper.client.create_payload_index(
                    collection_name=self.collection,
                    field_name=field,
                    field_schema=schema,
                )
            except Exception as exc:  # noqa: BLE001 - already exists is fine
                log.debug(
                    "incident_payload_index_ensure", field=field, error=str(exc)
                )

    async def upsert_incident(
        self,
        incident: HistoricalIncident,
        vector: list[float],
        *,
        embedding_model: str,
    ) -> str:
        """Idempotent upsert via a deterministic point id."""
        version = embedding_version_for(embedding_model)
        point_id = incident_point_id(incident.incident_id, version)
        payload = build_incident_payload(
            incident.to_public_dict(include_text=True),
            embedding_model=embedding_model,
            embedding_version=version,
        )
        await self.wrapper.client.upsert(
            collection_name=self.collection,
            points=[
                models.PointStruct(id=point_id, vector=vector, payload=payload)
            ],
            wait=True,
        )
        return point_id

    async def delete_incident(self, incident_id: str) -> bool:
        """Delete every point belonging to an incident (idempotent)."""
        filter_ = models.Filter(
            must=[
                models.FieldCondition(
                    key="incident_id", match=models.MatchValue(value=incident_id)
                )
            ]
        )
        result = await self.wrapper.client.delete(
            collection_name=self.collection,
            points_selector=models.FilterSelector(filter=filter_),
            wait=True,
        )
        status = getattr(result, "status", None)
        if status is not None:
            return str(status) in {"completed", "acknowledged"}
        return True

    async def search(
        self,
        vector: list[float],
        *,
        organization_id: str,
        machine_model_id: str | None,
        exclude_incident_id: str | None,
        limit: int,
        embedding_model: str,
    ) -> list[tuple[HistoricalIncident, float]]:
        """Semantic search over the incident_memory collection.

        Organization is a mandatory filter; the machine-model filter applies
        when a model is in scope.
        """
        query_filter = incident_filter(
            organization_id=organization_id,
            machine_model_id=machine_model_id,
            exclude_incident_id=exclude_incident_id,
            embedding_model=embedding_model,
        )
        try:
            points = await self.wrapper.client.search(
                collection_name=self.collection,
                query_vector=vector,
                query_filter=query_filter,
                limit=limit,
                with_payload=True,
                with_vectors=False,
            )
        except Exception as exc:  # noqa: BLE001
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Qdrant incident-memory semantic search failed.",
                internal_context={"detail": str(exc)[:200]},
            ) from exc

        out: list[tuple[HistoricalIncident, float]] = []
        for point in points:
            payload = point.payload or {}
            out.append((incident_from_payload(payload, str(point.id)), float(point.score)))
        return out


def incident_from_payload(payload: dict[str, Any], point_id: str | None = None) -> HistoricalIncident:
    return HistoricalIncident(
        incident_id=str(payload.get("incident_id") or ""),
        organization_id=str(payload.get("organization_id") or ""),
        machine_id=payload.get("machine_id") or None,
        machine_model_id=payload.get("machine_model_id") or None,
        incident_number=str(payload.get("incident_number") or ""),
        title=str(payload.get("title") or ""),
        status=str(payload.get("status") or "open"),
        issue_status=str(payload.get("issue_status") or "unknown"),
        severity=str(payload.get("severity") or "medium"),
        error_codes=[str(c) for c in (payload.get("error_codes") or [])],
        symptoms=[str(s) for s in (payload.get("symptoms") or [])],
        operating_conditions=[str(c) for c in (payload.get("operating_conditions") or [])],
        root_cause_status=str(payload.get("root_cause_status") or "unknown"),
        confirmed_root_cause=payload.get("confirmed_root_cause") or None,
        confirmed_fix=payload.get("confirmed_fix") or None,
        resolution_summary=payload.get("resolution_summary") or None,
        resolved_at=payload.get("resolved_at") or None,
        created_at=str(payload.get("created_at") or ""),
        qdrant_point_id=point_id,
    )
