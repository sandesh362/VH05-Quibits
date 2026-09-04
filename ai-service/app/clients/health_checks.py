"""Real dependency probes for the RAG service readiness endpoint.

Every function performs an ACTUAL network operation. No hardcoded "healthy"
responses. Errors are sanitised so credentials never reach a response body.
"""

from __future__ import annotations

import re
import time
from typing import Any

import httpx

from app.core.config import Settings
from app.core.errors import DependencyCheckModel

_CREDENTIALS_IN_URI = re.compile(r"//[^@\s/]+@")
_SECRET_QUERY_PARAM = re.compile(r"(api[_-]?key|token|password)=[^\s&]+", re.IGNORECASE)


def _sanitise(error: Exception) -> str:
    """Reduce an exception to a short, credential-free summary."""
    raw = str(error) or error.__class__.__name__
    cleaned = _CREDENTIALS_IN_URI.sub("//***:***@", raw)
    cleaned = _SECRET_QUERY_PARAM.sub(r"\1=***", cleaned)
    return cleaned[:200]


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


async def check_qdrant(settings: Settings) -> DependencyCheckModel:
    """Probe Qdrant via GET /readyz, falling back to the root endpoint.

    Not required for readiness in Phase 1: no collections exist yet, so the
    service is fully usable without it.
    """
    started = time.perf_counter()
    headers: dict[str, str] = {}
    if settings.QDRANT_API_KEY:
        headers["api-key"] = settings.QDRANT_API_KEY

    try:
        async with httpx.AsyncClient(timeout=settings.health_timeout_seconds) as client:
            response = await client.get(f"{settings.QDRANT_URL}/readyz", headers=headers)
            if response.status_code == 404:
                response = await client.get(f"{settings.QDRANT_URL}/", headers=headers)

        if response.status_code >= 400:
            return DependencyCheckModel(
                name="qdrant",
                status="down",
                latencyMs=_elapsed_ms(started),
                error=f"HTTP {response.status_code}",
                required=False,
                impact="Vector indexing and search unavailable (not used in Phase 1).",
            )

        return DependencyCheckModel(
            name="qdrant",
            status="ok",
            latencyMs=_elapsed_ms(started),
            detail="Vector database reachable. No collections created yet (Phase 4).",
            required=False,
        )
    except Exception as exc:  # noqa: BLE001 - probe must never raise
        return DependencyCheckModel(
            name="qdrant",
            status="down",
            latencyMs=_elapsed_ms(started),
            error=_sanitise(exc),
            required=False,
            impact="Vector indexing and search unavailable (not used in Phase 1).",
        )


async def check_ollama(settings: Settings) -> DependencyCheckModel:
    """Probe Ollama via GET /api/tags and verify configured models are pulled.

    Reachable but model-missing is reported as `degraded`, never `ok` - a green
    light with no usable model would be a fake health response.
    """
    started = time.perf_counter()

    try:
        async with httpx.AsyncClient(timeout=settings.ollama_timeout_seconds) as client:
            response = await client.get(f"{settings.OLLAMA_BASE_URL}/api/tags")

        if response.status_code >= 400:
            return DependencyCheckModel(
                name="ollama",
                status="down",
                latencyMs=_elapsed_ms(started),
                error=f"HTTP {response.status_code}",
                required=False,
                impact="Embeddings and AI answers unavailable.",
            )

        payload: dict[str, Any] = response.json()
        installed = [m.get("name", "") for m in payload.get("models", []) if m.get("name")]

        def has_model(wanted: str) -> bool:
            # Ollama reports "nomic-embed-text:latest" for "nomic-embed-text".
            base = wanted.split(":")[0]
            return any(name == wanted or name.split(":")[0] == base for name in installed)

        missing: list[str] = []
        if settings.OLLAMA_EMBEDDING_MODEL and not has_model(settings.OLLAMA_EMBEDDING_MODEL):
            missing.append(settings.OLLAMA_EMBEDDING_MODEL)
        if settings.OLLAMA_CHAT_MODEL and not has_model(settings.OLLAMA_CHAT_MODEL):
            missing.append(settings.OLLAMA_CHAT_MODEL)

        if missing:
            return DependencyCheckModel(
                name="ollama",
                status="degraded",
                latencyMs=_elapsed_ms(started),
                detail=f"Reachable with {len(installed)} model(s) installed",
                error=(
                    f"Configured model(s) not pulled: {', '.join(missing)}. "
                    f"Run: ollama pull {missing[0]}"
                ),
                required=False,
                impact="Embeddings and AI answers will fail until the model is pulled.",
            )

        chat_note = (
            f"chat={settings.OLLAMA_CHAT_MODEL}"
            if settings.OLLAMA_CHAT_MODEL
            else "chat model not configured (expected in Phase 1)"
        )
        return DependencyCheckModel(
            name="ollama",
            status="ok",
            latencyMs=_elapsed_ms(started),
            detail=f"Reachable. {len(installed)} model(s) installed. {chat_note}",
            required=False,
        )
    except Exception as exc:  # noqa: BLE001
        return DependencyCheckModel(
            name="ollama",
            status="down",
            latencyMs=_elapsed_ms(started),
            error=_sanitise(exc),
            required=False,
            impact="Embeddings and AI answers unavailable. Is `ollama serve` running on the host?",
        )


async def check_mongodb(settings: Settings) -> DependencyCheckModel:
    """Probe MongoDB with a real `ping` command.

    Reported as `disabled` when MONGODB_URI is unset: the RAG service performs
    no database work in Phase 1, so an absent URI is a valid configuration
    rather than a failure.
    """
    if not settings.MONGODB_URI:
        return DependencyCheckModel(
            name="mongodb",
            status="disabled",
            latencyMs=None,
            detail="MONGODB_URI not configured. The RAG service does not use MongoDB in Phase 1.",
            required=False,
        )

    started = time.perf_counter()
    client = None
    try:
        from motor.motor_asyncio import AsyncIOMotorClient

        client = AsyncIOMotorClient(
            settings.MONGODB_URI,
            serverSelectionTimeoutMS=settings.HEALTH_CHECK_TIMEOUT_MS,
            connectTimeoutMS=settings.HEALTH_CHECK_TIMEOUT_MS,
        )
        await client.admin.command("ping")

        return DependencyCheckModel(
            name="mongodb",
            status="ok",
            latencyMs=_elapsed_ms(started),
            detail=f'Database "{settings.MONGO_DB_NAME}" reachable',
            required=False,
        )
    except Exception as exc:  # noqa: BLE001
        return DependencyCheckModel(
            name="mongodb",
            status="down",
            latencyMs=_elapsed_ms(started),
            error=_sanitise(exc),
            required=False,
            impact="Job progress reporting unavailable (not used in Phase 1).",
        )
    finally:
        if client is not None:
            client.close()


async def run_all_checks(settings: Settings) -> list[DependencyCheckModel]:
    """Run every probe concurrently. Total time is the slowest probe."""
    import asyncio

    return list(
        await asyncio.gather(
            check_qdrant(settings),
            check_ollama(settings),
            check_mongodb(settings),
        )
    )
