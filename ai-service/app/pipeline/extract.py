"""Page-aware PDF text extraction using PyMuPDF (fitz).

Extraction is the foundation: every later stage (OCR, cleaning, chunking)
depends on page boundaries being preserved. Page numbers ALWAYS reflect the
actual PDF page index (1-based). If extraction is impossible (corrupt or
encrypted PDF) this module raises a clear, safe ServiceError instead of
silently producing an empty result.
"""

from __future__ import annotations

from dataclasses import dataclass

import fitz  # PyMuPDF

from app.core.errors import ServiceError
from app.core.logging import get_logger

log = get_logger()

# Token-ish white-space run that we collapse later; kept here for stats.
_WS = "\t\r\n\x0c\x0b "


@dataclass
class PageExtraction:
    """One extracted PDF page."""

    page_number: int
    raw_text: str
    extraction_method: str = "native"
    character_count: int = 0
    word_count: int = 0
    has_text: bool = False
    ocr_used: bool = False
    ocr_confidence: float | None = None


def _count_words(text: str) -> int:
    return len([w for w in text.replace("\n", " ").split(" ") if w.strip()])


def _page_stats(text: str) -> dict[str, int | bool]:
    chars = len(text)
    words = _count_words(text)
    return {
        "character_count": chars,
        "word_count": words,
        "has_text": chars > 0,
    }


def extract_pdf_pages(file_path: str) -> list[PageExtraction]:
    """Extract text from every page of a PDF, preserving page boundaries.

    Raises ServiceError(VALIDATION_ERROR) for a corrupt/encrypted PDF so the
    job fails clearly rather than producing a seemingly-processed empty result.
    """
    try:
        doc = fitz.open(file_path)
    except Exception as exc:  # noqa: BLE001
        raise ServiceError(
            "VALIDATION_ERROR",
            "The file could not be opened as a PDF. It may be corrupted.",
            internal_context={"detail": str(exc)[:200]},
        ) from exc

    try:
        if doc.needs_pass:
            raise ServiceError(
                "VALIDATION_ERROR",
                "The PDF is password-protected. Encrypted manuals cannot be processed.",
            )

        pages: list[PageExtraction] = []
        for index in range(doc.page_count):
            page = doc.load_page(index)
            raw = page.get_text("text") or ""
            stats = _page_stats(raw)
            pages.append(
                PageExtraction(
                    page_number=index + 1,
                    raw_text=raw,
                    **stats,  # type: ignore[arg-type]
                )
            )

        log.info("pdf_extracted", page_count=len(pages))
        return pages
    finally:
        doc.close()


def detect_text_poor_pages(pages: list[PageExtraction], min_characters: int) -> list[int]:
    """Return the 1-based page numbers that are text-poor (OCR candidates).

    A page is text-poor when it has fewer than `min_characters` of extractable
    text. This is the primary OCR trigger heuristic.
    """
    return [p.page_number for p in pages if p.character_count < min_characters]
