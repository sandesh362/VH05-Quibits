"""Qdrant semantic retrieval.

Uses the same embedding model and query prefix as Phase 3 indexing. Filters
are mandatory when a machine model is in scope. Qdrant being down is a
degraded state, not a crash — the caller continues with exact hits.
"""

from __future__ import annotations

from typing import Any

from qdrant_client import models

from app.clients.qdrant import QdrantClientWrapper
from app.core.errors import ServiceError
from app.core.logging import get_logger
from app.rag.exact import hit_from_chunk
from app.rag.store import chunk_from_qdrant_payload
from app.rag.types import (
    ExtractedQuery,
    ManualRecord,
    RetrievalHit,
    ScopeFilter,
    VectorIndex,
)

log = get_logger()


def build_qdrant_filter(
    scope: ScopeFilter,
    *,
    allowed_manual_ids: list[str] | None,
    embedding_model: str,
) -> models.Filter | None:
    must: list[models.FieldCondition] = [
        models.FieldCondition(key="is_deleted", match=models.MatchValue(value=False)),
    ]
    if scope.machine_model_id:
        must.append(
            models.FieldCondition(
                key="machine_model_id",
                match=models.MatchValue(value=scope.machine_model_id),
            )
        )
    if scope.manual_id:
        must.append(
            models.FieldCondition(
                key="manual_id", match=models.MatchValue(value=scope.manual_id)
            )
        )
    if scope.manual_version:
        must.append(
            models.FieldCondition(
                key="document_version",
                match=models.MatchValue(value=scope.manual_version),
            )
        )
    if scope.manual_type:
        must.append(
            models.FieldCondition(
                key="document_type", match=models.MatchValue(value=scope.manual_type)
            )
        )
    if scope.manufacturer:
        must.append(
            models.FieldCondition(
                key="manufacturer", match=models.MatchValue(value=scope.manufacturer)
            )
        )
    if embedding_model:
        must.append(
            models.FieldCondition(
                key="embedding_model", match=models.MatchValue(value=embedding_model)
            )
        )
    if allowed_manual_ids:
        must.append(
            models.FieldCondition(
                key="manual_id", match=models.MatchAny(any=allowed_manual_ids)
            )
        )
    return models.Filter(must=must)


class QdrantVectorIndex:
    def __init__(self, wrapper: QdrantClientWrapper, collection: str) -> None:
        self.wrapper = wrapper
        self.collection = collection

    async def collection_dimension(self) -> int | None:
        try:
            info = await self.wrapper.client.get_collection(self.collection)
        except Exception:  # noqa: BLE001
            return None
        vectors = info.config.params.vectors
        if isinstance(vectors, dict):
            vectors = next(iter(vectors.values()), None)
        return getattr(vectors, "size", None)

    async def search(
        self,
        vector: list[float],
        *,
        scope: ScopeFilter,
        allowed_manual_ids: list[str] | None,
        limit: int,
        embedding_model: str,
    ) -> list[tuple[Any, float]]:
        query_filter = build_qdrant_filter(
            scope, allowed_manual_ids=allowed_manual_ids, embedding_model=embedding_model
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
                "Qdrant semantic search failed.",
                internal_context={"detail": str(exc)[:200]},
            ) from exc

        out: list[tuple[Any, float]] = []
        for point in points:
            payload = point.payload or {}
            chunk = chunk_from_qdrant_payload(payload, str(point.id))
            out.append((chunk, float(point.score)))
        return out


class MemoryVectorIndex:
    """In-memory cosine search used by tests. Vectors are caller-supplied."""

    def __init__(
        self,
        entries: list[tuple[Any, list[float]]] | None = None,
        dimension: int | None = None,
    ) -> None:
        self.entries = list(entries or [])
        self.dimension = dimension

    async def collection_dimension(self) -> int | None:
        if self.dimension is not None:
            return self.dimension
        if self.entries:
            return len(self.entries[0][1])
        return None

    async def search(
        self,
        vector: list[float],
        *,
        scope: ScopeFilter,
        allowed_manual_ids: list[str] | None,
        limit: int,
        embedding_model: str,
    ) -> list[tuple[Any, float]]:
        scored: list[tuple[Any, float]] = []
        for chunk, vec in self.entries:
            if (
                scope.machine_model_id
                and chunk.machine_model_id
                and chunk.machine_model_id != scope.machine_model_id
            ):
                continue
            if allowed_manual_ids and chunk.manual_id not in allowed_manual_ids:
                continue
            if scope.manual_id and chunk.manual_id != scope.manual_id:
                continue
            score = _cosine(vector, vec)
            scored.append((chunk, score))
        scored.sort(key=lambda item: item[1], reverse=True)
        return scored[:limit]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def assert_no_model_leak(
    hits: list[RetrievalHit], machine_model_id: str | None
) -> list[RetrievalHit]:
    if not machine_model_id:
        return hits
    clean: list[RetrievalHit] = []
    for hit in hits:
        if hit.machine_model_id and hit.machine_model_id != machine_model_id:
            log.warning(
                "machine_model_contamination_dropped",
                chunk_id=hit.chunk_id,
                expected=machine_model_id,
                actual=hit.machine_model_id,
            )
            continue
        clean.append(hit)
    return clean


async def semantic_search(
    index: VectorIndex,
    vector: list[float],
    extracted: ExtractedQuery,
    scope: ScopeFilter,
    manuals: list[ManualRecord],
    *,
    limit: int,
    embedding_model: str,
) -> list[RetrievalHit]:
    allowed = [m.manual_id for m in manuals] if manuals else None
    # When a model is selected we must never search the whole corpus.
    if scope.machine_model_id and not allowed:
        return []
    by_id = {m.manual_id: m for m in manuals}
    raw = await index.search(
        vector,
        scope=scope,
        allowed_manual_ids=allowed,
        limit=limit,
        embedding_model=embedding_model,
    )
    hits: list[RetrievalHit] = []
    for chunk, score in raw:
        manual = by_id.get(chunk.manual_id)
        hit = hit_from_chunk(
            chunk, manual, extracted, source="semantic", semantic_score=score
        )
        hits.append(hit)
    return assert_no_model_leak(hits, scope.machine_model_id)
