"""Qdrant client for manual chunk vectors.

Qdrant is a DERIVED index: it is always rebuildable from MongoDB + `storage/`,
and Mongo remains authoritative. This module owns collection bootstrap (with
dimension + distance assertion), deterministic point IDs, payload metadata, and
idempotent upsert/delete-by-manual.

Design rules (see docs/QDRANT_DESIGN.md):
  - Deterministic point IDs -> a retry overwrites instead of duplicating.
  - Payload carries everything needed to render a citation without a second
    Mongo round trip.
  - Filters are per-manual / per-model; payload indexes are created at bootstrap.
"""

from __future__ import annotations

import uuid
from typing import Any

from qdrant_client import AsyncQdrantClient, models

from app.core.config import Settings
from app.core.errors import ServiceError
from app.core.logging import get_logger

log = get_logger()

# Fixed namespace for deterministic manual-chunk point IDs.
MANUAL_CHUNK_NAMESPACE = uuid.UUID("f3f9c3ba-2c2e-4c6b-8b6b-9b7d7d1a0a01")


def manual_chunk_point_id(manual_id: str, chunk_index: int, embedding_version: str) -> str:
    """Deterministic point id: uuid5(namespace, f"{manual_id}:{chunk_index}:{version}").

    Including the embedding version means a re-index with a new model/version
    produces DIFFERENT point ids, so blue/green re-indexing can coexist without
    a gap. Reprocessing a manual with the same version overwrites in place.
    """
    seed = f"{manual_id}:{chunk_index}:{embedding_version}"
    return str(uuid.uuid5(MANUAL_CHUNK_NAMESPACE, seed))


class QdrantClientWrapper:
    """Async wrapper around Qdrant with collection bootstrap and idempotent ops."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = AsyncQdrantClient(
            url=settings.QDRANT_URL,
            api_key=settings.QDRANT_API_KEY or None,
            timeout=int(settings.health_timeout_seconds),
        )

    async def ensure_collection(self, name: str, dimension: int) -> dict[str, Any]:
        """Create the collection if missing; ASSERT dimension/distance if present.

        A dimension mismatch is a fatal error (never silently index into a
        wrong-dimension collection). Distance is cosine, per QDRANT_DESIGN.
        """
        try:
            info = await self.client.get_collection(name)
        except Exception:  # noqa: BLE001 - likely collection not found
            # Collection absent -> create it.
            await self.client.create_collection(
                collection_name=name,
                vectors_config=models.VectorParams(size=dimension, distance=models.Distance.COSINE),
            )
            await self._ensure_payload_indexes(name)
            log.info("qdrant_collection_created", collection=name, dimension=dimension)
            return {"created": True, "dimension": dimension, "distance": "cosine"}

        vectors = info.config.params.vectors
        if isinstance(vectors, dict):
            # Named vectors not used here; take the first.
            vectors = next(iter(vectors.values()), None)
        existing_dim = getattr(vectors, "size", None)
        if existing_dim != dimension:
            raise ServiceError(
                "INTERNAL_SERVER_ERROR",
                (
                    f"Qdrant collection '{name}' has dimension {existing_dim} but the "
                    f"configured embedding model produces {dimension}. Refusing to index."
                ),
            )
        await self._ensure_payload_indexes(name)
        return {"created": False, "dimension": existing_dim, "distance": "cosine"}

    async def _ensure_payload_indexes(self, name: str) -> None:
        """Create the payload indexes required by future filtered retrieval."""
        indexes = [
            ("machine_model_id", models.PayloadSchemaType.KEYWORD),
            ("manual_id", models.PayloadSchemaType.KEYWORD),
            ("document_type", models.PayloadSchemaType.KEYWORD),
            ("embedding_model", models.PayloadSchemaType.KEYWORD),
            ("embedding_version", models.PayloadSchemaType.KEYWORD),
            ("chunk_index", models.PayloadSchemaType.INTEGER),
            ("page_number", models.PayloadSchemaType.INTEGER),
            ("page_end", models.PayloadSchemaType.INTEGER),
        ]
        for field, schema in indexes:
            try:
                await self.client.create_payload_index(
                    collection_name=name,
                    field_name=field,
                    field_schema=schema,
                )
            except Exception as exc:  # noqa: BLE001 - already exists is fine
                log.debug("payload_index_ensure", field=field, error=str(exc))

        try:
            await self.client.create_payload_index(
                collection_name=name,
                field_name="text",
                field_schema=models.TextIndexParams(
                    type=models.TextIndexType.TEXT,
                    tokenizer=models.TokenizerType.WORD,
                    lowercase=True,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("text_index_ensure", field="text", error=str(exc))

    async def upsert_chunks(
        self,
        name: str,
        points: list[models.PointStruct],
    ) -> int:
        """Upsert a batch of chunk vectors (idempotent via deterministic ids)."""
        if not points:
            return 0
        await self.client.upsert(collection_name=name, points=points, wait=True)
        return len(points)

    async def delete_by_manual(self, name: str, manual_id: str) -> int:
        """Delete every point in the collection belonging to a manual."""
        filter_ = models.Filter(
            must=[models.FieldCondition(key="manual_id", match=models.MatchValue(value=manual_id))]
        )
        points = await self.client.delete(
            collection_name=name,
            points_selector=models.FilterSelector(filter=filter_),
            wait=True,
        )
        return points

    async def count_by_manual(self, name: str, manual_id: str) -> int:
        filter_ = models.Filter(
            must=[models.FieldCondition(key="manual_id", match=models.MatchValue(value=manual_id))]
        )
        result = await self.client.count(collection_name=name, count_filter=filter_)
        return result.count

    async def ping(self) -> None:
        """Ensure Qdrant is reachable (raises ServiceError when down)."""
        try:
            await self.client.get_collections()
        except ServiceError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Qdrant is unreachable. Is the vector database running?",
            ) from exc

    async def close(self) -> None:
        await self.client.close()


def new_qdrant_client(settings: Settings) -> QdrantClientWrapper:
    return QdrantClientWrapper(settings)


def build_chunk_payload(
    *,
    manual_id: str,
    manual_title: str,
    manual_version: str | None,
    manufacturer: str | None,
    manual_type: str,
    language: str,
    machine_model_id: str,
    chunk: dict[str, Any],
    embedding_model: str,
    embedding_version: str,
) -> dict[str, Any]:
    """Assemble the full payload for one chunk point.

    The payload carries every field the future citation renderer and the
    retrieval filters need, so a search result never needs a Mongo round trip
    to be displayable.
    """
    return {
        "chunk_id": f"{manual_id}:{chunk['chunk_index']}",
        "manual_id": manual_id,
        "machine_model_id": machine_model_id,
        "manual_title": manual_title,
        "manual_version": manual_version,
        "manufacturer": manufacturer,
        "manual_type": manual_type,
        "document_type": manual_type,
        "document_version": manual_version,
        "language": language,
        "chunk_index": chunk["chunk_index"],
        "page_number": chunk["page_start"],
        "page_end": chunk["page_end"],
        "section_title": chunk.get("section_title"),
        "section_path": chunk.get("section_path") or [],
        "content_hash": chunk["content_hash"],
        "embedding_model": embedding_model,
        "embedding_version": embedding_version,
        "text": chunk["text"],
        "text_len": len(chunk["text"]),
        "is_deleted": False,
    }
