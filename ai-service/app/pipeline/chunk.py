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
    return paragraphs


def _split_long_paragraph(paragraph: str, max_size: int) -> list[str]:
    """Split a paragraph that exceeds max_size at sentence boundaries."""
    sentences = [s.strip() for s in _SENTENCE_SPLIT.split(paragraph) if s.strip()]
    pieces: list[str] = []
    current = ""
    for sentence in sentences:
        if len(current) + len(sentence) + 1 <= max_size:
            current = f"{current} {sentence}".strip()
        else:
            if current:
                pieces.append(current)
            if len(sentence) > max_size:
                # A single sentence still too big: split at word boundaries.
                words = sentence.split(" ")
                word_buf = ""
                for word in words:
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
    return pieces


def _first_heading(units: list[dict[str, Any]]) -> dict[str, Any] | None:
    for u in units:
        if u.get("heading"):
            return u["heading"]
    return None


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

    # Build a flat list of units, each tagged with page + nearest heading.
    units: list[dict[str, Any]] = []
    for page in pages:
        cleaned = getattr(page, "cleaned_text", None) or getattr(page, "raw_text", "")
        headings = detect_headings(cleaned)
        for start_line, paragraph_text in _split_paragraphs(cleaned):
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
        chunk = {
            "page_start": min(pages_in),
            "page_end": max(pages_in),
            "section_title": heading["title"] if heading else None,
            "section_path": heading["path"] if heading else None,
            "text": text,
            "normalized_text": normalized,
            "character_count": len(normalized),
            "word_count": len(normalized.split(" ")),
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
                chunks.append(
                    {
                        **unit,
                        "text": piece,
                        "normalized_text": normalized,
                        "page_start": unit["page_number"],
                        "page_end": unit["page_number"],
                        "section_title": unit["heading"]["title"] if unit["heading"] else None,
                        "section_path": unit["heading"]["path"] if unit["heading"] else None,
                        "character_count": len(normalized),
                        "word_count": len(normalized.split(" ")),
                        "content_hash": _sha256(normalized),
                    }
                )
            continue

        if current_len + unit_len > chunk_size and current:
            c = close()
            if c:
                chunks.append(c)
            # Overlap: seed the next chunk from trailing units within `overlap` chars.
            carry: list[dict[str, Any]] = []
            carry_len = 0
            for prev in reversed(history):
                carry.insert(0, prev)
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
            merged[-1]["word_count"] = len(merged[-1]["normalized_text"].split(" "))
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
        raise ServiceError(
            "VALIDATION_ERROR",
            "No meaningful text could be extracted from this PDF.",
        )

    return result
