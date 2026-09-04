"""Page-aware, technically meaningful chunking.

Goal: keep error codes with their explanations, keep procedures whole where
possible, preserve page references, and produce chunks no larger than
`MAX_CHUNK_SIZE` and no smaller than `MIN_CHUNK_SIZE`.

Method (deterministic, no LLM):
  1. Split each page's cleaned text into paragraphs (blank-line separated).
  2. Attach the nearest preceding heading (if any) to each paragraph.
  3. Greedily accumulate paragraphs into a chunk until `CHUNK_SIZE` chars.
  4. Carry `CHUNK_OVERLAP` chars of context from the previous chunk into the next.
  5. A single paragraph larger than `MAX_CHUNK_SIZE` is split at sentence
     boundaries rather than cut mid-word.

Chunks are never empty; below-MIN trailing chunks are merged into the previous.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from app.core.errors import ServiceError

# Sentence boundary splitter. Keeps error codes/units intact because it only
# splits on terminal punctuation + whitespace.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WS_RUN = re.compile(r"\s+")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _split_paragraphs(text: str) -> list[tuple[int, str]]:
    """Split cleaned text into paragraphs. Returns (start_line, paragraph_text)."""
    if not text:
        return []
    # Some PDFs (especially compressed ones) may have no blank lines at all;
    # the whole page is a single logical paragraph.  The blank-line splitter
    # would then return one huge paragraph that later gets split by the
    # long-paragraph handler – that's fine.
    lines = text.split("\n")
    paragraphs: list[tuple[int, str]] = []
    buffer: list[str] = []
    start_line: int | None = None

    for idx, line in enumerate(lines):
        if line.strip():
            if start_line is None:
                start_line = idx
            buffer.append(line.strip())
        else:
            if buffer and start_line is not None:
                paragraphs.append((start_line, " ".join(buffer)))
                buffer = []
                start_line = None
    if buffer and start_line is not None:
        paragraphs.append((start_line, " ".join(buffer)))
    # Fallback: if line-based splitting produced nothing but the text is
    # non-empty (e.g. a single very long line without newlines), treat the
    # whole text as one paragraph so the document is not considered empty.
    if not paragraphs and text.strip():
        return [(0, re.sub(r"\s+", " ", text).strip())]
    return paragraphs


def _split_long_paragraph(paragraph: str, max_size: int) -> list[str]:
    """Split a paragraph that exceeds max_size at sentence boundaries."""
    if not paragraph:
        return []
    sentences = [s.strip() for s in _SENTENCE_SPLIT.split(paragraph) if s.strip()]
    # If no sentence boundaries were found, treat the whole paragraph as one
    # sentence so the word-boundary or fixed-width fallback can handle it.
    if not sentences:
        sentences = [paragraph.strip()]
    pieces: list[str] = []
    current = ""
    for sentence in sentences:
        if len(current) + len(sentence) + 1 <= max_size:
            current = f"{current} {sentence}".strip()
        else:
            if current:
                pieces.append(current)
                current = ""
            if len(sentence) > max_size:
                # A single sentence still too big: split at word boundaries.
                words = sentence.split(" ")
                # Remove empty tokens from consecutive spaces.
                words = [w for w in words if w]
                word_buf = ""
                for word in words:
                    # If a single word is still longer than max_size (e.g. a
                    # base64-like token from a compressed stream), split it
                    # at fixed width so we always make progress.
                    if len(word) > max_size:
                        if word_buf:
                            pieces.append(word_buf)
                            word_buf = ""
                        for i in range(0, len(word), max_size):
                            pieces.append(word[i : i + max_size])
                        continue
                    if len(word_buf) + len(word) + 1 <= max_size:
                        word_buf = f"{word_buf} {word}".strip()
                    else:
                        if word_buf:
                            pieces.append(word_buf)
                        word_buf = word
                if word_buf:
                    pieces.append(word_buf)
            else:
                current = sentence
    if current:
        pieces.append(current)
    # Final fallback: if we still have nothing (e.g. paragraph was all
    # whitespace), return the stripped paragraph as a single piece.
    if not pieces and paragraph.strip():
        return [paragraph.strip()[:max_size]]
    return pieces


def _first_heading(units: list[dict[str, Any]]) -> dict[str, Any] | None:
    for u in units:
        if u.get("heading"):
            return u["heading"]
    return None


def _sanitize_params(
    chunk_size: int, overlap: int, min_size: int, max_size: int
) -> tuple[int, int, int, int]:
    """Ensure chunk params are sane; auto-correct common misconfigurations."""
    # Clamp to positive values.
    chunk_size = max(100, int(chunk_size))
    max_size = max(chunk_size, int(max_size))
    min_size = max(1, min(int(min_size), chunk_size))
    # Overlap must be < chunk_size otherwise every chunk would re-include the
    # entire previous chunk; cap it.
    overlap = max(0, min(int(overlap), chunk_size - 1)) if chunk_size > 1 else 0
    return chunk_size, overlap, min_size, max_size


def chunk_document(
    pages: list[Any],
    *,
    chunk_size: int,
    overlap: int,
    min_size: int,
    max_size: int,
) -> list[dict[str, Any]]:
    """Chunk a list of page extractions into page-tagged, section-tagged chunks."""
    from app.pipeline.clean import detect_headings, nearest_heading_before

    chunk_size, overlap, min_size, max_size = _sanitize_params(
        chunk_size, overlap, min_size, max_size
    )

    # Build a flat list of units, each tagged with page + nearest heading.
    units: list[dict[str, Any]] = []
    for page in pages:
        # Use cleaned_text if present and non-empty after stripping; otherwise
        # fall back to raw_text so cleaning never silently discards a page.
        raw = getattr(page, "raw_text", "") or ""
        cleaned = getattr(page, "cleaned_text", None)
        if cleaned is not None and isinstance(cleaned, str) and cleaned.strip():
            text_for_units = cleaned
        elif raw.strip():
            text_for_units = raw
        else:
            text_for_units = ""
        if not text_for_units.strip():
            continue
        headings = detect_headings(text_for_units)
        paras = _split_paragraphs(text_for_units)
        # Defensive: if paragraph splitter still yields nothing but text is
        # non-empty, create a single unit from the normalised text.
        if not paras and text_for_units.strip():
            paras = [(0, re.sub(r"\s+", " ", text_for_units).strip())]
        for start_line, paragraph_text in paras:
            if not paragraph_text.strip():
                continue
            heading = nearest_heading_before(headings, start_line)
            units.append(
                {
                    "page_number": getattr(page, "page_number", 0),
                    "paragraph_text": paragraph_text,
                    "heading": {
                        "title": heading.title,
                        "path": heading.path,
                        "level": heading.level,
                    }
                    if heading
                    else None,
                }
            )

    # Last-resort fallback: if we still have no units but there is any text
    # across pages, create chunks by directly windowing the concatenated text.
    # This handles PDFs with unusual structure (e.g. tables without newlines)
    # where paragraph detection fails but text is present.
    if not units:
        combined = " ".join(
            (getattr(p, "cleaned_text", None) or getattr(p, "raw_text", "") or "").strip()
            for p in pages
        )
        combined = _WS_RUN.sub(" ", combined).strip()
        if combined:
            # Split combined into max_size windows with overlap.
            start = 0
            idx = 0
            fallback_chunks: list[dict[str, Any]] = []
            # Use first page number for all fallback chunks.
            first_page = getattr(pages[0], "page_number", 1) if pages else 1
            while start < len(combined):
                end = min(start + chunk_size, len(combined))
                window = combined[start:end].strip()
                if not window:
                    break
                fallback_chunks.append(
                    {
                        "page_start": first_page,
                        "page_end": first_page,
                        "section_title": None,
                        "section_path": None,
                        "text": window,
                        "normalized_text": _WS_RUN.sub(" ", window).strip(),
                        "character_count": len(window),
                        "word_count": len(window.split()),
                        "content_hash": _sha256(window),
                        "chunk_index": idx,
                    }
                )
                idx += 1
                if end >= len(combined):
                    break
                start = max(0, end - overlap)
            if fallback_chunks:
                return fallback_chunks

    chunks: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    current_len = 0
    history: list[dict[str, Any]] = []

    def close() -> dict[str, Any] | None:
        nonlocal current, current_len
        text = " ".join(u["paragraph_text"] for u in current).strip()
        if not text:
            current = []
            current_len = 0
            return None
        pages_in = [u["page_number"] for u in current]
        heading = _first_heading(current)
        normalized = _WS_RUN.sub(" ", text).strip()
        if not normalized:
            current = []
            current_len = 0
            return None
        chunk = {
            "page_start": min(pages_in),
            "page_end": max(pages_in),
            "section_title": heading["title"] if heading else None,
            "section_path": heading["path"] if heading else None,
            "text": text,
            "normalized_text": normalized,
            "character_count": len(normalized),
            "word_count": len(normalized.split()),
            "content_hash": _sha256(normalized),
        }
        current = []
        current_len = 0
        return chunk

    for unit in units:
        unit_text = unit["paragraph_text"]
        unit_len = len(unit_text)

        # Oversized single paragraph -> its own chunks.
        if unit_len > max_size:
            if current:
                c = close()
                if c:
                    chunks.append(c)
            for piece in _split_long_paragraph(unit_text, max_size):
                normalized = _WS_RUN.sub(" ", piece).strip()
                if not normalized:
                    continue
                chunks.append(
                    {
                        "page_number": unit["page_number"],
                        "paragraph_text": piece,
                        "heading": unit["heading"],
                        "text": piece,
                        "normalized_text": normalized,
                        "page_start": unit["page_number"],
                        "page_end": unit["page_number"],
                        "section_title": unit["heading"]["title"] if unit["heading"] else None,
                        "section_path": unit["heading"]["path"] if unit["heading"] else None,
                        "character_count": len(normalized),
                        "word_count": len(normalized.split()),
                        "content_hash": _sha256(normalized),
                    }
                )
                # Also feed the split pieces into history for overlap, using
                # the original unit's paragraph_text length semantics.
                history.append({"paragraph_text": piece, "page_number": unit["page_number"], "heading": unit["heading"]})
            continue

        if current_len + unit_len > chunk_size and current:
            c = close()
            if c:
                chunks.append(c)
            # Overlap: seed the next chunk from trailing units within `overlap` chars.
            carry: list[dict[str, Any]] = []
            carry_len = 0
            for prev in reversed(history):
                # Copy the dict to avoid aliasing issues.
                carry.insert(0, dict(prev))
                carry_len += len(prev["paragraph_text"])
                if carry_len >= overlap:
                    break
            current = carry
            current_len = carry_len

        current.append(unit)
        history.append(unit)
        current_len += unit_len

    if current:
        c = close()
        if c:
            chunks.append(c)

    # Merge below-min trailing chunks; drop empty/meaningless.
    merged: list[dict[str, Any]] = []
    for chunk in chunks:
        if len(chunk["normalized_text"]) < min_size and merged:
            merged[-1]["text"] = f"{merged[-1]['text']} {chunk['text']}".strip()
            merged[-1]["normalized_text"] = _WS_RUN.sub(" ", merged[-1]["text"]).strip()
            merged[-1]["page_end"] = max(merged[-1]["page_end"], chunk["page_end"])
            merged[-1]["character_count"] = len(merged[-1]["normalized_text"])
            merged[-1]["word_count"] = len(merged[-1]["normalized_text"].split())
            merged[-1]["content_hash"] = _sha256(merged[-1]["normalized_text"])
        elif chunk["normalized_text"]:
            merged.append(chunk)

    # Assign sequential indices, drop empty.
    result: list[dict[str, Any]] = []
    for idx, chunk in enumerate(merged):
        if not chunk["normalized_text"]:
            continue
        chunk["chunk_index"] = idx
        result.append(chunk)

    if not result:
        # Provide a more actionable message that includes diagnostic counts.
        total_raw = sum(len(getattr(p, "raw_text", "") or "") for p in pages)
        total_cleaned = sum(len(getattr(p, "cleaned_text", "") or "") for p in pages)
        raise ServiceError(
            "VALIDATION_ERROR",
            "No meaningful text could be extracted from this PDF. "
            f"(pages={len(pages)}, raw_chars={total_raw}, cleaned_chars={total_cleaned}). "
            "If this is a scanned or image-based manual, ensure OCR is enabled "
            "and Tesseract is installed; otherwise the PDF may be blank.",
        )

    return result
