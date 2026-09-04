"""Internal retrieval endpoint (Express → FastAPI)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.core.auth import require_internal_token
from app.core.config import get_settings
from app.core.errors import success_envelope
from app.core.middleware import get_request_id
from app.rag.pipeline import PipelineRequest, build_deps, run_search
from app.rag.store import MongoChunkStore

router = APIRouter(tags=["retrieval"])


class RetrievalRequestModel(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    machine_id: str | None = None
    machine_model_id: str | None = None
    manual_id: str | None = None
    manual_version: str | None = None
    manual_type: str | None = None
    manufacturer: str | None = None
    include_inactive: bool = False
    conversation_id: str | None = None
    debug: bool = False
    top_k: int | None = Field(default=None, ge=1, le=50)


@router.post("/retrieval/search")
async def retrieval_search(
    payload: RetrievalRequestModel,
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    settings = get_settings()
    deps = await build_deps(settings)
    try:
        result = await run_search(
            PipelineRequest(**payload.model_dump()),
            deps,
        )
    finally:
        store = deps.store
        if isinstance(store, MongoChunkStore):
            await store.close()
    return success_envelope(result, get_request_id(request))
