"""FastAPI internal vector-index maintenance endpoints.

These are INTERNAL ONLY. They let Express delete/verify the derived Qdrant
index for a manual without exposing Qdrant directly to the browser.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.clients.qdrant import new_qdrant_client
from app.core.auth import require_internal_token
from app.core.config import get_settings
from app.core.errors import success_envelope
from app.core.middleware import get_request_id

router = APIRouter(tags=["indexing"])


class DeleteRequest(BaseModel):
    manual_id: str


@router.post("/indexing/manual-chunks/delete")
async def delete_manual_chunks(
    payload: DeleteRequest,
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Delete every Qdrant point belonging to a manual. Idempotent."""
    settings = get_settings()
    qdrant = new_qdrant_client(settings)
    try:
        deleted = await qdrant.delete_by_manual(
            settings.QDRANT_MANUAL_COLLECTION, payload.manual_id
        )
    except Exception as exc:  # noqa: BLE001 - report as dependency unavailable
        raise HTTPException(
            status_code=503,
            detail=f"Qdrant is unavailable: {str(exc)[:200]}",
        ) from exc
    finally:
        await qdrant.close()
    return success_envelope(
        {"deleted": deleted, "collection": settings.QDRANT_MANUAL_COLLECTION},
        get_request_id(request),
    )


@router.get("/indexing/collections/stats")
async def collections_stats(
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Report per-collection point counts and the configured dimension."""
    settings = get_settings()
    qdrant = new_qdrant_client(settings)
    try:
        info = await qdrant.client.get_collection(settings.QDRANT_MANUAL_COLLECTION)
        count = await qdrant.client.count(settings.QDRANT_MANUAL_COLLECTION)
        vectors = info.config.params.vectors
        if isinstance(vectors, dict):
            vectors = next(iter(vectors.values()), None)
        result = {
            "collection": settings.QDRANT_MANUAL_COLLECTION,
            "points": count.count,
            "dimension": getattr(vectors, "size", None),
            "distance": getattr(vectors, "distance", None),
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503, detail=f"Qdrant is unavailable: {str(exc)[:200]}"
        ) from exc
    finally:
        await qdrant.close()
    return success_envelope(result, get_request_id(request))
