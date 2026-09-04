"""Document processing pipeline orchestrator (FastAPI).

Owns the ORDER of operations and the consistency guarantees:
  extract -> (OCR? ) -> clean -> chunk -> embed -> index Qdrant -> persist artifacts
and is where the embeddings are generated and vectors upserted. It writes job
PROGRESS to `manual_processing_jobs` (the single permitted FastAPI->Mongo write)
and returns the structured result that Express persists to Mongo.

It does NOT write pages/chunks to Mongo business collections and does NOT set
the job's terminal status - Express owns both.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from qdrant_client.models import PointStruct

from app.clients.mongo import JobProgressWriter, new_progress_writer
from app.clients.ollama import OllamaEmbeddingClient
from app.clients.qdrant import (
    build_chunk_payload,
    manual_chunk_point_id,
    new_qdrant_client,
)
from app.core.config import Settings
from app.core.errors import ServiceError
from app.core.logging import get_logger
from app.pipeline.chunk import chunk_document
from app.pipeline.clean import clean_text
from app.pipeline.extract import PageExtraction, detect_text_poor_pages, extract_pdf_pages
from app.pipeline.ocr import ocr_pages, save_ocr_artifacts

log = get_logger()

# Embedding-version slug recorded in every payload. Bump when the model or the
# chunking format changes so vectors are never silently cross-contaminated.
EMBEDDING_VERSION = "ev1"

# Batch size for embedding calls (Ollama serialises anyway; moderate batch).
EMBED_BATCH = 32


class ProcessRequest:
    """Validated processing request (values come from the router's model)."""

    def __init__(self, **kwargs: Any) -> None:
        self.job_id: str = kwargs["job_id"]
        self.manual_id: str = kwargs["manual_id"]
        self.storage_path: str = kwargs["storage_path"]
        self.machine_model_id: str = kwargs.get("machine_model_id", "") or ""
        self.machine_id: str | None = kwargs.get("machine_id") or None
        self.manual: dict[str, Any] = kwargs.get("manual", {}) or {}
        self.options: dict[str, Any] = kwargs.get("options", {}) or {}


def _resolve_pdf(settings: Settings, storage_path: str) -> Path:
    """Resolve the PDF path under the storage root, rejecting traversal."""
    root = settings.storage_root_path.resolve()
    candidate = (root / storage_path).resolve()
    if root not in candidate.parents and candidate != root:
        raise ServiceError(
            "VALIDATION_ERROR",
            "The requested storage path is outside the storage root.",
        )
    if not candidate.exists() or not candidate.is_file():
        raise ServiceError(
            "VALIDATION_ERROR",
            "The PDF file for this manual was not found on disk.",
        )
    return candidate


def _extraction_method(any_ocr: bool, ocr_count: int, page_count: int) -> str:
    if not any_ocr:
        return "native"
    if ocr_count >= page_count:
        return "ocr"
    return "mixed"


async def process_manual(req: ProcessRequest, settings: Settings) -> dict[str, Any]:
    """Run the full pipeline and return the structured result for Express."""
    opts = req.options
    writer: JobProgressWriter = new_progress_writer(settings, req.job_id)
    pdf_path = _resolve_pdf(settings, req.storage_path)

    ocr_enabled = bool(opts.get("ocr_enabled", settings.OCR_ENABLED)) or bool(
        opts.get("force_ocr", False)
    )
    ocr_language = opts.get("ocr_language", settings.OCR_LANGUAGE)
    min_chars = int(
        opts.get("ocr_min_text_characters_per_page", settings.OCR_MIN_TEXT_CHARACTERS_PER_PAGE)
    )

    try:
        # ---- 1. Extract -------------------------------------------------------
        await writer.update(current_stage="extracting_text", progress_percent=10)
        pages = extract_pdf_pages(str(pdf_path))
        page_count = len(pages)

        # ---- 2. OCR (if enabled and text-poor pages exist) ---------------------
        poor_pages = detect_text_poor_pages(pages, min_chars) if ocr_enabled else []
        ocr_used = False
        ocr_count = 0
        if poor_pages:
            await writer.update(current_stage="ocr_processing", progress_percent=25)
            ocr_results = await ocr_pages(
                str(pdf_path), poor_pages, ocr_language, settings.TESSERACT_CMD
            )
            for page in pages:
                if page.page_number in ocr_results:
                    ocr_entry = ocr_results[page.page_number]
                    if ocr_entry.text.strip():
                        page.raw_text = ocr_entry.text
                        page.extraction_method = "ocr"
                        page.ocr_used = True
                        page.ocr_confidence = ocr_entry.confidence
                        ocr_count += 1
                        ocr_used = True
                    else:
                        page.ocr_used = True
                        page.ocr_confidence = ocr_entry.confidence

            save_ocr_artifacts(settings.manual_storage_root / req.manual_id, pages)

        # ---- 3. Clean ----------------------------------------------------------
        await writer.update(current_stage="text_cleaning", progress_percent=45)
        for page in pages:
            cleaned = clean_text(page.raw_text)
            page.cleaned_text = cleaned
            page.character_count = len(cleaned)
            page.word_count = len(cleaned.split(" "))
            page.has_text = len(cleaned) > 0

        # ---- 4. Chunk ----------------------------------------------------------
        await writer.update(current_stage="chunking", progress_percent=55)
        chunks = chunk_document(
            pages,
            chunk_size=int(opts.get("chunk_size", settings.CHUNK_SIZE)),
            overlap=int(opts.get("chunk_overlap", settings.CHUNK_OVERLAP)),
            min_size=int(opts.get("min_chunk_size", settings.MIN_CHUNK_SIZE)),
            max_size=int(opts.get("max_chunk_size", settings.MAX_CHUNK_SIZE)),
        )

        # ---- 5. Embeddings -----------------------------------------------------
        await writer.update(current_stage="embedding", progress_percent=65)
        embedding_model = opts.get("embedding_model", settings.embedding_model)
        if embedding_model != settings.embedding_model:
            raise ServiceError(
                "VALIDATION_ERROR",
                "The requested embedding model does not match the configured Ollama embedding model.",
            )
        ollama = OllamaEmbeddingClient(settings)
        await ollama.ping()
        qdrant = new_qdrant_client(settings)

        # Probe dimension and ensure the collection matches it.
        dimension = await ollama.dimension_probe()
        collection = opts.get("collection_name", settings.QDRANT_MANUAL_COLLECTION)
        await qdrant.ensure_collection(collection, dimension)

        if bool(opts.get("delete_existing", True)):
            await writer.update(current_stage="indexing", progress_percent=80)
            await qdrant.delete_by_manual(collection, req.manual_id)

        # Embed in batches, building Qdrant points.
        points: list[Any] = []
        embedded_chunks: list[dict[str, Any]] = []
        texts = [c["normalized_text"] for c in chunks]
        for start in range(0, len(texts), EMBED_BATCH):
            batch = texts[start : start + EMBED_BATCH]
            vectors = await ollama.embed(batch)
            for chunk, vector in zip(chunks[start : start + EMBED_BATCH], vectors, strict=False):
                if len(vector) != dimension:
                    raise ServiceError(
                        "INTERNAL_SERVER_ERROR",
                        "Embedding dimension mismatch detected during indexing.",
                    )
                point_id = manual_chunk_point_id(
                    req.manual_id, chunk["chunk_index"], EMBEDDING_VERSION
                )
                chunk["embedding_model"] = embedding_model
                chunk["embedding_dimension"] = dimension
                chunk["qdrant_point_id"] = point_id
                chunk["indexing_status"] = "indexed"
                payload = build_chunk_payload(
                    manual_id=req.manual_id,
                    manual_title=req.manual.get("title", ""),
                    manual_version=req.manual.get("document_version") or None,
                    manufacturer=req.manual.get("manufacturer") or None,
                    manual_type=req.manual.get("document_type", ""),
                    language=req.manual.get("language", "en"),
                    machine_model_id=req.machine_model_id,
                    chunk=chunk,
                    embedding_model=embedding_model,
                    embedding_version=EMBEDDING_VERSION,
                )
                points.append(PointStruct(id=point_id, vector=vector, payload=payload))
                embedded_chunks.append(chunk)

        await qdrant.upsert_chunks(collection, points)
        indexed_count = await qdrant.count_by_manual(collection, req.manual_id)

        await writer.update(
            current_stage="indexing",
            progress_percent=95,
            total_pages=page_count,
            processed_pages=page_count,
            total_chunks=len(chunks),
            processed_chunks=len(chunks),
            embedding_model=embedding_model,
            embedding_dimension=dimension,
        )

        # ---- 6. Persist artifacts (debugging / reprocessing) -------------------
        _write_artifacts(settings, req.manual_id, pages, chunks, indexed_count)

        # ---- 7. Build the result ----------------------------------------------
        result = {
            "job_id": req.job_id,
            "manual_id": req.manual_id,
            "page_count": page_count,
            "chunk_count": len(chunks),
            "pages": [_page_view(p) for p in pages],
            "chunks": embedded_chunks,
            "extraction_method": _extraction_method(ocr_used, ocr_count, page_count),
            "ocr_used": ocr_used,
            "embedding_model": embedding_model,
            "embedding_dimension": dimension,
            "qdrant_collection": collection,
            "qdrant_indexed_points": indexed_count,
            "processing_version": (
                f"{opts.get('chunking_version', settings.CHUNKING_VERSION)}-{EMBEDDING_VERSION}"
            ),
        }

        await writer.update(progress_percent=100)
        return result
    finally:
        if "qdrant" in locals():
            await qdrant.close()
        await writer.close()


def _page_view(page: PageExtraction) -> dict[str, Any]:
    return {
        "page_number": page.page_number,
        "raw_text": page.raw_text,
        "cleaned_text": getattr(page, "cleaned_text", ""),
        "character_count": page.character_count,
        "word_count": page.word_count,
        "has_text": page.has_text,
        "extraction_method": page.extraction_method,
        "ocr_used": page.ocr_used,
        "ocr_confidence": page.ocr_confidence if hasattr(page, "ocr_confidence") else None,
    }


def _write_artifacts(
    settings: Settings,
    manual_id: str,
    pages: list[PageExtraction],
    chunks: list[dict[str, Any]],
    indexed_count: int,
) -> None:
    """Persist extraction/chunk output under <storage>/manuals/<id>/ for debugging."""
    base = settings.manual_storage_root / manual_id
    try:
        (base / "extracted").mkdir(parents=True, exist_ok=True)
        (base / "chunks").mkdir(parents=True, exist_ok=True)
        (base / "logs").mkdir(parents=True, exist_ok=True)
        with (base / "extracted" / "pages.json").open("w", encoding="utf-8") as fh:
            json.dump([_page_view(p) for p in pages], fh, ensure_ascii=False, default=str)
        with (base / "extracted" / "full-text.txt").open("w", encoding="utf-8") as fh:
            for page in pages:
                fh.write(f"\n===== PAGE {page.page_number} =====\n")
                fh.write(page.raw_text)
        with (base / "chunks" / "chunks.json").open("w", encoding="utf-8") as fh:
            json.dump(chunks, fh, ensure_ascii=False, default=str)
        with (base / "logs" / "processing.log").open("w", encoding="utf-8") as fh:
            fh.write(f"indexed_points={indexed_count}\nchunks={len(chunks)}\n")
    except Exception as exc:  # noqa: BLE001 - artifacts are best-effort
        log.warning("artifact_write_failed", error=str(exc)[:200])
