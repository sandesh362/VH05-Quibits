"""Chunk stores: in-memory (tests) and MongoDB (runtime).

Mongo is the source of truth for chunk text. Qdrant is a derived index.
FastAPI is allowed to READ manuals/chunks; it still must not write business
collections (Express owns those).
"""

from __future__ import annotations

import re
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import Settings
from app.core.logging import get_logger
from app.rag.types import ChunkRecord, ManualRecord, ScopeFilter

log = get_logger()


def _oid(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, ObjectId):
        return str(value)
    return str(value)


def _as_object_id(value: str) -> Any:
    try:
        return ObjectId(value)
    except Exception:  # noqa: BLE001 - fall back to the raw string
        return value


class MemoryChunkStore:
    """Deterministic store used by unit tests and evaluation fixtures."""

    def __init__(
        self,
        manuals: list[ManualRecord] | None = None,
        chunks: list[ChunkRecord] | None = None,
    ) -> None:
        self.manuals = list(manuals or [])
        self.chunks = list(chunks or [])

    async def find_manuals(self, scope: ScopeFilter) -> list[ManualRecord]:
        out: list[ManualRecord] = []
        for manual in self.manuals:
            if manual.processing_status not in {"completed", "completed_with_warnings"}:
                continue
            if not scope.include_inactive and not manual.is_active:
                continue
            if scope.machine_model_id and manual.machine_model_id != scope.machine_model_id:
                continue
            if (
                scope.machine_id
                and manual.machine_id is not None
                and manual.machine_id != scope.machine_id
            ):
                # Machine-scoped manuals must match; model-scoped manuals (no
                # machine_id) still apply to every machine of the model.
                continue
            if scope.manual_id and manual.manual_id != scope.manual_id:
                continue
            if (
                scope.manual_id
                and scope.manual_version
                and manual.version
                and manual.version != scope.manual_version
            ):
                # Keep other versions visible so conflict detection can run,
                # unless the caller asked for a single manual id.
                continue
            if scope.manual_type and manual.manual_type and manual.manual_type != scope.manual_type:
                continue
            if (
                scope.manufacturer
                and manual.manufacturer
                and manual.manufacturer.casefold() != scope.manufacturer.casefold()
            ):
                continue
            out.append(manual)
        return out

    async def find_chunks(
        self,
        *,
        manual_ids: list[str],
        patterns: list[str],
        limit: int,
    ) -> list[ChunkRecord]:
        allowed = set(manual_ids)
        compiled = [re.compile(p, re.IGNORECASE) for p in patterns] if patterns else []
        matches: list[ChunkRecord] = []
        for chunk in self.chunks:
            if allowed and chunk.manual_id not in allowed:
                continue
            if compiled and not any(p.search(chunk.text) for p in compiled):
                continue
            matches.append(chunk)
            if len(matches) >= limit:
                break
        return matches

    async def get_chunks_by_ids(self, chunk_ids: list[str]) -> list[ChunkRecord]:
        wanted = set(chunk_ids)
        return [c for c in self.chunks if c.chunk_id in wanted or c.mongo_id in wanted]


class MongoChunkStore:
    """Read manuals + chunks from MongoDB."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: AsyncIOMotorClient | None = AsyncIOMotorClient(
            settings.MONGODB_URI,
            serverSelectionTimeoutMS=settings.HEALTH_CHECK_TIMEOUT_MS,
            connectTimeoutMS=settings.HEALTH_CHECK_TIMEOUT_MS,
        )
        self._db: AsyncIOMotorDatabase = self._client[settings.MONGO_DB_NAME]

    async def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    async def find_manuals(self, scope: ScopeFilter) -> list[ManualRecord]:
        query: dict[str, Any] = {
            "is_deleted": False,
            "processing_status": {"$in": ["completed", "completed_with_warnings"]},
        }
        if not scope.include_inactive:
            query["is_active"] = True
        if scope.machine_model_id:
            query["machine_model_id"] = _as_object_id(scope.machine_model_id)
        if scope.manual_id:
            query["_id"] = _as_object_id(scope.manual_id)
        if scope.manual_type:
            query["document_type"] = scope.manual_type
        if scope.manufacturer:
            query["manufacturer"] = {
                "$regex": f"^{re.escape(scope.manufacturer)}$",
                "$options": "i",
            }
        if scope.machine_id:
            # Model-wide manuals (machine_id missing/null) plus this machine.
            query["$or"] = [
                {"machine_id": _as_object_id(scope.machine_id)},
                {"machine_id": None},
                {"machine_id": {"$exists": False}},
            ]

        cursor = self._db["manuals"].find(query).limit(200)
        records: list[ManualRecord] = []
        async for doc in cursor:
            version = doc.get("document_version")
            if scope.manual_version and scope.manual_id and version != scope.manual_version:
                continue
            records.append(
                ManualRecord(
                    manual_id=str(doc["_id"]),
                    title=doc.get("title") or "Untitled manual",
                    version=version,
                    manual_type=doc.get("document_type"),
                    manufacturer=doc.get("manufacturer"),
                    language=doc.get("language"),
                    machine_model_id=_oid(doc.get("machine_model_id")),
                    machine_id=_oid(doc.get("machine_id")),
                    is_current_version=bool(doc.get("is_current_version", True)),
                    is_active=bool(doc.get("is_active", True)),
                    processing_status=doc.get("processing_status") or "completed",
                    page_count=doc.get("page_count"),
                )
            )
        return records

    async def find_chunks(
        self,
        *,
        manual_ids: list[str],
        patterns: list[str],
        limit: int,
    ) -> list[ChunkRecord]:
        if not manual_ids:
            return []
        query: dict[str, Any] = {
            "manual_id": {"$in": [_as_object_id(mid) for mid in manual_ids]},
            "indexing_status": {"$in": ["indexed", "embedded"]},
        }
        if patterns:
            query["$or"] = [
                {"normalized_text": {"$regex": p, "$options": "i"}}
                for p in patterns
            ] + [
                {"text": {"$regex": p, "$options": "i"}}
                for p in patterns
            ]
        cursor = self._db["manual_chunks"].find(query).limit(limit)
        chunks: list[ChunkRecord] = []
        async for doc in cursor:
            chunks.append(_chunk_from_mongo(doc))
        return chunks

    async def get_chunks_by_ids(self, chunk_ids: list[str]) -> list[ChunkRecord]:
        if not chunk_ids:
            return []
        or_clause: list[dict[str, Any]] = []
        oids = []
        for cid in chunk_ids:
            if re.fullmatch(r"[a-fA-F0-9]{24}", cid):
                oids.append(_as_object_id(cid))
            if ":" in cid:
                manual_id, _, index = cid.partition(":")
                try:
                    or_clause.append(
                        {
                            "manual_id": _as_object_id(manual_id),
                            "chunk_index": int(index),
                        }
                    )
                except ValueError:
                    continue
        query: dict[str, Any] = {}
        clauses: list[dict[str, Any]] = []
        if oids:
            clauses.append({"_id": {"$in": oids}})
        clauses.extend(or_clause)
        if not clauses:
            return []
        query["$or"] = clauses
        cursor = self._db["manual_chunks"].find(query).limit(200)
        chunks: list[ChunkRecord] = []
        async for doc in cursor:
            chunks.append(_chunk_from_mongo(doc))
        return chunks


def _chunk_from_mongo(doc: dict[str, Any]) -> ChunkRecord:
    manual_id = _oid(doc.get("manual_id")) or ""
    index = int(doc.get("chunk_index") or 0)
    return ChunkRecord(
        chunk_id=f"{manual_id}:{index}",
        mongo_id=_oid(doc.get("_id")),
        manual_id=manual_id,
        machine_model_id=_oid(doc.get("machine_model_id")),
        machine_id=_oid(doc.get("machine_id")),
        chunk_index=index,
        page_start=int(doc.get("page_start") or 0),
        page_end=int(doc.get("page_end") or doc.get("page_start") or 0),
        section_title=doc.get("section_title"),
        section_path=list(doc.get("section_path") or []),
        text=doc.get("normalized_text") or doc.get("text") or "",
        content_hash=doc.get("content_hash") or "",
        indexing_status=doc.get("indexing_status") or "indexed",
        embedding_model=doc.get("embedding_model"),
        embedding_dimension=doc.get("embedding_dimension"),
        qdrant_point_id=doc.get("qdrant_point_id"),
    )


def chunk_from_qdrant_payload(payload: dict[str, Any], fallback_id: str) -> ChunkRecord:
    manual_id = str(payload.get("manual_id") or "")
    index = int(payload.get("chunk_index") or 0)
    chunk_id = str(payload.get("chunk_id") or f"{manual_id}:{index}" or fallback_id)
    return ChunkRecord(
        chunk_id=chunk_id,
        mongo_id=None,
        manual_id=manual_id,
        machine_model_id=str(payload["machine_model_id"])
        if payload.get("machine_model_id")
        else None,
        machine_id=str(payload["machine_id"]) if payload.get("machine_id") else None,
        chunk_index=index,
        page_start=int(payload.get("page_number") or payload.get("page_start") or 0),
        page_end=int(payload.get("page_end") or payload.get("page_number") or 0),
        section_title=payload.get("section_title"),
        section_path=list(payload.get("section_path") or []),
        text=payload.get("text") or "",
        content_hash=payload.get("content_hash") or "",
        indexing_status="indexed",
        embedding_model=payload.get("embedding_model"),
        embedding_dimension=None,
        qdrant_point_id=fallback_id,
        manual_title=payload.get("manual_title"),
        manual_version=payload.get("manual_version") or payload.get("document_version"),
        manual_type=payload.get("manual_type") or payload.get("document_type"),
        manufacturer=payload.get("manufacturer"),
        is_current_version=bool(payload.get("is_current_version", True)),
        language=payload.get("language"),
    )
