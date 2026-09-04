"""Health, readiness and system-info endpoints for the RAG service."""

from __future__ import annotations

import platform
import sys
import time
from datetime import UTC, datetime

from fastapi import APIRouter, Request

from app.clients.health_checks import run_all_checks
from app.core.config import get_settings
from app.core.errors import (
    HealthPayload,
    ReadinessPayload,
    SystemInfoPayload,
    success_envelope,
)
from app.core.middleware import get_request_id

router = APIRouter(tags=["health"])

SERVICE_NAME = "rag-service"
SERVICE_VERSION = "0.1.0"
_STARTED_AT = datetime.now(UTC)

# Dependency -> capabilities it powers, for degraded reporting.
CAPABILITY_BY_DEPENDENCY: dict[str, list[str]] = {
    "qdrant": ["vector_search", "vector_indexing"],
    "ollama": ["embeddings", "rag_generation"],
    "mongodb": ["job_progress_reporting"],
}

# Phase 3: the ingestion pipeline (extraction -> OCR -> cleaning -> chunking ->
# embeddings -> Qdrant indexing) is implemented. Retrieval/search and RAG
# answers are Phase 4/5 and must remain False so the UI cannot claim them.
PHASE_3_FEATURES: dict[str, bool] = {
    "pdf_extraction": True,
    "ocr": True,
    "chunking": True,
    "embeddings": True,
    "vector_indexing": True,
    "retrieval": False,
    "rag_answers": False,
    "citation_validation": False,
}


def _uptime_seconds() -> int:
    return int((datetime.now(UTC) - _STARTED_AT).total_seconds())


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@router.get("/health", summary="Process liveness")
async def health(request: Request) -> dict:
    """Liveness only. Never touches a dependency, so it stays fast and is safe
    as a container healthcheck."""
    settings = get_settings()
    payload = HealthPayload(
        service=SERVICE_NAME,
        version=SERVICE_VERSION,
        environment=settings.PYTHON_ENV,
        uptimeSeconds=_uptime_seconds(),
        timestamp=_now_iso(),
    )
    return success_envelope(payload.model_dump(), get_request_id(request))


@router.get("/ready", summary="Dependency readiness")
async def ready(request: Request) -> dict:
    """Real dependency probes.

    In Phase 1 no dependency is REQUIRED: the service exposes only health
    endpoints, so it is genuinely usable while Qdrant and Ollama are down.
    Their absence is reported honestly as `degraded`.
    """
    settings = get_settings()
    started = time.perf_counter()

    checks = await run_all_checks(settings)

    required_down = any(c.required and c.status != "ok" for c in checks)
    impaired = any(c.status in ("down", "degraded") for c in checks)

    if required_down:
        status = "down"
    elif impaired:
        status = "degraded"
    else:
        status = "ok"

    degraded: list[str] = []
    for check in checks:
        if check.status in ("down", "degraded"):
            degraded.extend(CAPABILITY_BY_DEPENDENCY.get(check.name, []))

    payload = ReadinessPayload(
        status=status,  # type: ignore[arg-type]
        service=SERVICE_NAME,
        ready=not required_down,
        checks=checks,
        degradedCapabilities=sorted(set(degraded)),
        durationMs=int((time.perf_counter() - started) * 1000),
        timestamp=_now_iso(),
    )
    return success_envelope(payload.model_dump(), get_request_id(request))


@router.get("/system/info", summary="Service and build information")
async def system_info(request: Request) -> dict:
    """Non-sensitive build facts.

    Reports WHICH dependencies are configured, never WHERE they live.
    """
    settings = get_settings()

    payload = SystemInfoPayload(
        service=SERVICE_NAME,
        version=SERVICE_VERSION,
        environment=settings.PYTHON_ENV,
        apiPrefix=settings.RAG_API_PREFIX,
        pythonVersion=sys.version.split()[0],
        platform=f"{platform.system()} {platform.machine()}",
        phase="Phase 3 - Document Ingestion & Indexing",
        startedAt=_STARTED_AT.isoformat().replace("+00:00", "Z"),
        uptimeSeconds=_uptime_seconds(),
        features=PHASE_3_FEATURES,
        configuredDependencies=["qdrant", "ollama", "mongodb"],
    )
    return success_envelope(payload.model_dump(), get_request_id(request))
