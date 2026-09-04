"""Minimal MongoDB client for the FastAPI service.

The architecture allows FastAPI to write ONLY to `manual_processing_jobs` (job
progress). It never writes to business collections - Express owns those and
performs the terminal `completed`/`failed` transition after verifying the result.

When MONGODB_URI is empty (e.g. in tests, or when Mongo is not used), progress
writes are silently skipped so the pipeline still runs without a database.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import Settings
from app.core.logging import get_logger

log = get_logger()

JOB_COLLECTION = "manual_processing_jobs"


class JobProgressWriter:
    """Best-effort progress reporter for a single processing job."""

    def __init__(self, settings: Settings, job_id: str) -> None:
        self.settings = settings
        self.job_id = job_id
        self._client: AsyncIOMotorClient | None = None
        self._disabled = not settings.MONGODB_URI

    def _collection(self):
        if self._client is None:
            self._client = AsyncIOMotorClient(
                self.settings.MONGODB_URI,
                serverSelectionTimeoutMS=3000,
                connectTimeoutMS=3000,
            )
        return self._client[self.settings.MONGO_DB_NAME][JOB_COLLECTION]

    async def update(self, **fields: Any) -> None:
        """Set fields on the job document. Errors are logged, never raised."""
        if self._disabled:
            return
        try:
            await self._collection().update_one(
                {"_id": self._as_object_id(self.job_id)},
                {"$set": {"updated_at": datetime.now(UTC), **fields}},
            )
        except Exception as exc:  # noqa: BLE001 - progress is best-effort
            log.warning("job_progress_write_failed", error=str(exc)[:200])

    @staticmethod
    def _as_object_id(value: str) -> Any:
        try:
            return ObjectId(value)
        except Exception:  # noqa: BLE001
            return value

    async def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None


def new_progress_writer(settings: Settings, job_id: str) -> JobProgressWriter:
    return JobProgressWriter(settings, job_id)
