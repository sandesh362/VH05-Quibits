"""Read-only Mongo access for incident memory.

Express owns incident writes; this store only READS incident metadata for
similar-incident retrieval and historical RAG evidence. All queries are
organization-scoped: the organization id is a mandatory filter, so one
organization's history can never leak into another's retrieval.
"""

from __future__ import annotations

from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import Settings
from app.core.logging import get_logger
from app.rag.types import HistoricalIncident

log = get_logger()


def _str(value: Any) -> str | None:
    return str(value) if value is not None else None


def incident_from_doc(doc: dict[str, Any]) -> HistoricalIncident:
    root_cause = doc.get("root_cause") or {}
    permanent_fix = doc.get("permanent_fix") or {}
    temporary_fix = doc.get("temporary_fix") or {}
    confirmed_fix = None
    if permanent_fix.get("status") == "confirmed":
        confirmed_fix = permanent_fix.get("description") or None
    elif temporary_fix.get("status") == "confirmed":
        confirmed_fix = temporary_fix.get("description") or None

    confirmed_root_cause = None
    if root_cause.get("status") == "confirmed":
        confirmed_root_cause = root_cause.get("text") or None

    return HistoricalIncident(
        incident_id=str(doc["_id"]),
        organization_id=_str(doc.get("organization_id")) or "",
        machine_id=_str(doc.get("machine_id")),
        machine_model_id=_str(doc.get("machine_model_id")),
        incident_number=str(doc.get("incident_number") or ""),
        title=str(doc.get("title") or ""),
        status=str(doc.get("status") or "open"),
        issue_status=str(doc.get("issue_status") or "unknown"),
        severity=str(doc.get("severity") or "medium"),
        error_codes=[str(c) for c in (doc.get("error_codes") or [])],
        symptoms=[str(s) for s in (doc.get("symptoms") or [])],
        operating_conditions=[str(c) for c in (doc.get("operating_conditions") or [])],
        root_cause_status=str(root_cause.get("status") or "unknown"),
        confirmed_root_cause=confirmed_root_cause,
        confirmed_fix=confirmed_fix,
        resolution_summary=doc.get("resolution_summary") or None,
        resolved_at=doc.get("resolved_at").isoformat() if doc.get("resolved_at") else None,
        created_at=doc.get("created_at").isoformat() if doc.get("created_at") else "",
    )


class MongoIncidentStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: AsyncIOMotorClient | None = AsyncIOMotorClient(
            settings.MONGODB_URI,
            serverSelectionTimeoutMS=settings.HEALTH_CHECK_TIMEOUT_MS,
        )
        self._db: AsyncIOMotorDatabase = self._client[settings.MONGO_DB_NAME]

    @property
    def db(self) -> AsyncIOMotorDatabase:
        return self._db

    async def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    async def find_incidents_by_ids(self, incident_ids: list[str]) -> list[HistoricalIncident]:
        if not incident_ids:
            return []
        from bson import ObjectId

        oids = [ObjectId(i) for i in incident_ids if ObjectId.is_valid(i)]
        if not oids:
            return []
        docs = await self._db["incidents"].find(
            {"_id": {"$in": oids}, "is_deleted": {"$ne": True}}
        ).to_list(length=len(oids))
        return [incident_from_doc(doc) for doc in docs]

    async def find_exact_error_code_matches(
        self,
        *,
        organization_id: str,
        machine_model_id: str,
        error_codes: list[str],
        exclude_incident_id: str | None,
        limit: int,
    ) -> list[HistoricalIncident]:
        """Structured Mongo lookup: same org, same error code.

        Machine-model scoping is a soft preference here (same model ranks
        higher in the ranking step); the ORGANIZATION filter is hard.
        """
        from bson import ObjectId

        query: dict[str, Any] = {
            "organization_id": ObjectId(organization_id),
            "error_codes": {"$in": list(error_codes)},
            "is_deleted": {"$ne": True},
        }
        if exclude_incident_id:
            query["_id"] = {"$ne": ObjectId(exclude_incident_id)}
        docs = await self._db["incidents"].find(query).sort("resolved_at", -1).to_list(
            length=limit
        )
        out = [incident_from_doc(doc) for doc in docs]
        if machine_model_id:
            # Same-model incidents first (deterministic ordering preserved).
            out.sort(key=lambda i: (i.machine_model_id != machine_model_id, -(i.resolved_at is not None)))
        return out
