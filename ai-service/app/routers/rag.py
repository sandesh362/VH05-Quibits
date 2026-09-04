"""Internal RAG answer + health endpoints (Express → FastAPI)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.core.auth import require_internal_token
from app.core.config import get_settings
from app.core.errors import success_envelope
from app.core.middleware import get_request_id
from app.rag.pipeline import PipelineRequest, build_deps, run_answer
from app.rag.store import MongoChunkStore

router = APIRouter(tags=["rag"])


class RagAnswerRequestModel(BaseModel):
    query: str = Field(min_length=1, max_length=5000)
    machine_id: str | None = None
    machine_model_id: str | None = None
    manual_id: str | None = None
    manual_version: str | None = None
    manual_type: str | None = None
    manufacturer: str | None = None
    include_inactive: bool = False
    conversation_id: str | None = None
    conversation_context: dict[str, Any] | None = None
    debug: bool = False
    top_k: int | None = Field(default=None, ge=1, le=50)


@router.post("/rag/answer")
async def rag_answer(
    payload: RagAnswerRequestModel,
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    settings = get_settings()
    deps = await build_deps(settings)
    try:
        result = await run_answer(PipelineRequest(**payload.model_dump()), deps)
    finally:
        store = deps.store
        if isinstance(store, MongoChunkStore):
            await store.close()
    return success_envelope(result.to_dict(), get_request_id(request))


@router.get("/rag/health")
async def rag_health(
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Readiness of the retrieval/generation path. Never leaks hostnames."""
    settings = get_settings()
    from app.clients.health_checks import check_mongodb, check_ollama, check_qdrant

    qdrant = await check_qdrant(settings)
    ollama = await check_ollama(settings)
    mongo = await check_mongodb(settings)
    payload = {
        "status": (
            "ok"
            if qdrant.status == "ok"
            and ollama.status in {"ok", "degraded"}
            and mongo.status in {"ok", "disabled"}
            else "degraded"
        ),
        "chat_model_configured": bool(settings.OLLAMA_CHAT_MODEL),
        "embedding_model": settings.OLLAMA_EMBEDDING_MODEL,
        "collection": settings.QDRANT_MANUAL_COLLECTION,
        "dependencies": {
            "qdrant": qdrant.status,
            "ollama": ollama.status,
            "mongodb": mongo.status,
        },
    }
    return success_envelope(payload, get_request_id(request))
