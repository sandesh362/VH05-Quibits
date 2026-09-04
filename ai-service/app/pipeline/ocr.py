"""OCR detection and local OCR (pytesseract) for text-poor/scanned PDF pages.

Design:
  - Detection is deterministic and heuristic: a page is an OCR candidate when it
    has fewer than `min_text_characters` of native text.
  - OCR renders the page to an image with PyMuPDF and runs Tesseract locally via
    pytesseract. No cloud provider is ever used.
  - If Tesseract is not installed the module raises a clear ServiceError with
    install instructions - the job fails loudly rather than silently producing
    unusable output. (Mocks/tests handle the unavailable tool case.)
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF

from app.core.errors import ServiceError
from app.core.logging import get_logger

log = get_logger()

# Render resolution for OCR. 200-300 dpi is the practical sweet spot for
# printed industrial manuals caught by a scan.
OCR_DPI = 240


@dataclass
class OcrPageResult:
    page_number: int
    text: str
    confidence: float | None


def tesseract_available() -> bool:
    """Return True when the Tesseract executable is on PATH."""
    return shutil.which("tesseract") is not None


def needs_ocr(pages: list[Any], min_characters: int) -> list[int]:
    """Return 1-based page numbers that should be OCR'd.

    A page is text-poor when it has fewer than `min_characters` of native text.
    We also treat a PDF as needing OCR when the *majority* of pages are empty.
    """
    poor = [p.page_number for p in pages if (p.character_count or 0) < min_characters]
    if poor and len(poor) == len(pages):
        return poor
    # Mixed manual: only OCR the genuinely poor pages, not the whole document.
    return poor


def render_page_to_image(pdf_path: str, page_number: int, dpi: int = OCR_DPI) -> bytes:
    """Render a single PDF page to PNG bytes (for OCR)."""
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:  # noqa: BLE001
        raise ServiceError(
            "VALIDATION_ERROR",
            "The PDF could not be opened for OCR rendering.",
            internal_context={"detail": str(exc)[:200]},
        ) from exc

    try:
        if page_number < 1 or page_number > doc.page_count:
            raise ServiceError(
                "VALIDATION_ERROR",
                f"Page {page_number} is out of range (1-{doc.page_count}).",
            )
        page = doc.load_page(page_number - 1)
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()


def ocr_page_image(image_bytes: bytes, language: str = "eng") -> tuple[str, float | None]:
    """Run Tesseract on a rendered page image and return (text, confidence).

    Raises ServiceError when Tesseract is not installed so the caller can fail
    the job with an actionable message rather than a nonsense empty result.
    """
    if not tesseract_available():
        raise ServiceError(
            "SERVICE_UNAVAILABLE",
            (
                "OCR is required for this PDF but Tesseract is not installed. "
                "Install it (apt-get install tesseract-ocr) or set OCR_ENABLED=false "
                "for text-based manuals."
            ),
        )

    import pytesseract
    from PIL import Image

    try:
        img = Image.open(__import__("io").BytesIO(image_bytes))
        data = pytesseract.image_to_data(img, lang=language, output_type=pytesseract.Output.DICT)
    except Exception as exc:  # noqa: BLE001 - pytesseract can raise on missing lang
        raise ServiceError(
            "SERVICE_UNAVAILABLE",
            f"OCR failed. This may be a missing language pack: {language}.",
            internal_context={"detail": str(exc)[:200]},
        ) from exc

    words = data.get("text", [])
    confs: list[int] = []
    for text, conf in zip(words, data.get("conf", []), strict=False):
        try:
            conf_int = int(conf)
        except (TypeError, ValueError):
            continue
        if text.strip():
            confs.append(conf_int)

    text = " ".join(w for w in words if w.strip())
    confidence = round(sum(confs) / len(confs), 2) if confs else None
    return text, confidence


def ocr_pages(
    pdf_path: str,
    pages: list[int],
    language: str = "eng",
) -> dict[int, OcrPageResult]:
    """OCR a set of pages. Returns a map of page_number -> result.

    A page-level failure does not kill the whole job: the page is recorded with
    empty text and a low-confidence marker, and processing continues. This is
    preferable to losing the whole manual over one bad page.
    """
    results: dict[int, OcrPageResult] = {}
    for page_number in pages:
        try:
            image = render_page_to_image(pdf_path, page_number)
            text, confidence = ocr_page_image(image, language)
            results[page_number] = OcrPageResult(page_number, text, confidence)
        except ServiceError as exc:
            log.warning("ocr_page_failed", page=page_number, error=exc.message)
            results[page_number] = OcrPageResult(page_number, "", None)
        except Exception as exc:  # noqa: BLE001
            log.warning("ocr_page_failed", page=page_number, error=str(exc)[:200])
            results[page_number] = OcrPageResult(page_number, "", None)
    return results


def save_ocr_artifacts(output_dir: Path, pages: list[Any]) -> None:
    """Persist OCR output for debugging in <storage>/manuals/<id>/ocr/."""
    try:
        (output_dir / "ocr").mkdir(parents=True, exist_ok=True)
        with (output_dir / "ocr" / "ocr-pages.json").open("w", encoding="utf-8") as fh:
            import json

            json.dump(
                [
                    {
                        "page_number": p.page_number,
                        "text": p.raw_text,
                        "confidence": p.ocr_confidence,
                    }
                    for p in pages
                ],
                fh,
                default=str,
            )
    except Exception as exc:  # noqa: BLE001 - artifacts are best-effort
        log.warning("ocr_artifact_write_failed", error=str(exc)[:200])
