"""FastAPI internal document-processing endpoints.

These are INTERNAL ONLY - reachable only by the Express API over the internal
Docker network. Every route requires the shared `X-Internal-Token`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.core.errors import success_envelope
from app.core.logging import get_logger
from app.core.middleware import get_request_id
from app.services.document_processor import ProcessRequest, process_manual

log = get_logger()
router = APIRouter(tags=["documents"])


class ManualMeta(BaseModel):
    title: str = ""
    document_version: str | None = None
    document_type: str = ""
    manufacturer: str | None = None
    language: str = "en"


class ProcessOptions(BaseModel):
    force_ocr: bool = False
    ocr_enabled: bool = True
    ocr_language: str = "eng"
    ocr_min_text_characters_per_page: int = 50
    chunk_size: int = 1200
    chunk_overlap: int = 200
    min_chunk_size: int = 200
    max_chunk_size: int = 1800
    chunking_version: str = "cv1"
    embedding_model: str = "nomic-embed-text"
    collection_name: str = "manual_chunks"
    delete_existing: bool = True


class ProcessRequestModel(BaseModel):
    job_id: str = Field(min_length=1)
    manual_id: str = Field(min_length=1)
    storage_path: str = Field(min_length=1)
    machine_model_id: str = ""
    machine_id: str | None = None
    manual: ManualMeta = Field(default_factory=ManualMeta)
    options: ProcessOptions = Field(default_factory=ProcessOptions)


def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    """Reject any caller that does not present the shared internal token."""
    if not x_internal_token or x_internal_token != get_settings().INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Missing or invalid internal token.")


@router.post("/documents/process")
async def documents_process(
    payload: ProcessRequestModel,
    request: Request,
    _auth: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Run the full document pipeline for one manual (synchronous).

    The caller (Express) runs this inside a background worker, so the upload
    request is never held open. Express persists the returned pages/chunks and
    performs the terminal job transition.
    """
    settings = get_settings()
    proc_request = ProcessRequest(
        job_id=payload.job_id,
        manual_id=payload.manual_id,
        storage_path=payload.storage_path,
        machine_model_id=payload.machine_model_id,
        machine_id=payload.machine_id,
        manual=payload.manual.model_dump(),
        options=payload.options.model_dump(),
    )
    result = await process_manual(proc_request, settings)
    return success_envelope(result, get_request_id(request))
