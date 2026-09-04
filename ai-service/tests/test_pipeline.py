"""Unit tests for the Phase 3 ingestion pipeline stages.

These tests are dependency-free: they exercise extraction, cleaning, heading
detection, OCR detection, and chunking against the small PDF fixtures. OCR
itself is not run (Tesseract may be absent); the OCR *detection* and the
mock-OCR path are covered instead.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.pipeline.chunk import chunk_document
from app.pipeline.clean import clean_text, detect_headings
from app.pipeline.extract import PageExtraction, detect_text_poor_pages, extract_pdf_pages

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return str(FIXTURES / name)


class TestExtraction:
    def test_extracts_pages_with_preserved_numbers(self) -> None:
        pages = extract_pdf_pages(fixture("simple-text-manual.pdf"))
        assert len(pages) == 3
        assert [p.page_number for p in pages] == [1, 2, 3]

    def test_preserves_error_codes_and_units(self) -> None:
        pages = extract_pdf_pages(fixture("simple-text-manual.pdf"))
        text = "\n".join(p.raw_text for p in pages)
        # Critical technical tokens must survive intact.
        for token in ("E-104", "ERR_204", "24 VDC", "3.5 bar", "M12 x 1.5", "PLC I/O", "X1-14"):
            assert token in text, f"expected {token!r} in extracted text"

    def test_corrupt_pdf_raises_service_error(self) -> None:
        from app.core.errors import ServiceError

        with pytest.raises(ServiceError):
            extract_pdf_pages(fixture("corrupted.pdf"))

    def test_pages_have_text_stats(self) -> None:
        pages = extract_pdf_pages(fixture("multi-page-manual.pdf"))
        for page in pages:
            assert page.character_count > 0
            assert page.word_count > 0
            assert page.has_text is True


class TestOcrDetection:
    def test_text_pages_are_not_ocr_candidates(self) -> None:
        pages = extract_pdf_pages(fixture("simple-text-manual.pdf"))
        poor = detect_text_poor_pages(pages, min_characters=20)
        # Every page has > 20 chars of text, so none should be flagged.
        assert poor == []

    def test_scanned_pdf_is_detected_as_text_poor(self) -> None:
        pages = extract_pdf_pages(fixture("scanned-manual.pdf"))
        assert all(p.character_count == 0 for p in pages)
        poor = detect_text_poor_pages(pages, min_characters=20)
        assert len(poor) == 3

    def test_mixed_manual_flags_only_poor_pages(self) -> None:
        pages = [
            PageExtraction(
                page_number=1, raw_text="a" * 200, character_count=200, word_count=20, has_text=True
            ),
            PageExtraction(
                page_number=2, raw_text="", character_count=0, word_count=0, has_text=False
            ),
            PageExtraction(
                page_number=3, raw_text="b" * 100, character_count=100, word_count=10, has_text=True
            ),
        ]
        poor = detect_text_poor_pages(pages, min_characters=120)
        # Page 1 (200 chars) is above threshold; pages 2 (0) and 3 (100) are below.
        assert poor == [2, 3]


class TestCleaning:
    def test_normalises_line_endings_and_whitespace(self) -> None:
        raw = "line1\r\n\r\n\r\n  line2\t\t x  \r\n"
        cleaned = clean_text(raw)
        assert cleaned == "line1\n\nline2 x"

    def test_preserves_technical_tokens(self) -> None:
        raw = "Check E-104 at 24 VDC and 3.5 bar.\nERR_204 at M12 x 1.5."
        cleaned = clean_text(raw)
        for token in ("E-104", "24 VDC", "3.5 bar", "ERR_204", "M12 x 1.5"):
            assert token in cleaned

    def test_does_not_merge_unrelated_paragraphs(self) -> None:
        raw = "Paragraph one.\n\nParagraph two."
        cleaned = clean_text(raw)
        assert "Paragraph two." in cleaned
        assert "\n\n" in cleaned


class TestHeadingDetection:
    def test_detects_uppercase_heading(self) -> None:
        headings = detect_headings("SERVICE MANUAL\n\ndescription text")
        assert any(h.title == "SERVICE MANUAL" for h in headings)

    def test_detects_numbered_section(self) -> None:
        headings = detect_headings("3.2 Hydraulic Pressure Check\n\nSome content follows here.")
        assert any(h.title == "3.2 Hydraulic Pressure Check" for h in headings)

    def test_detects_keyword_section(self) -> None:
        headings = detect_headings("Troubleshooting\n\nError E-104 means servo overload.")
        assert any(h.title == "Troubleshooting" for h in headings)


class TestChunking:
    def test_chunks_preserve_page_numbers(self) -> None:
        pages = extract_pdf_pages(fixture("multi-page-manual.pdf"))
        chunks = chunk_document(pages, chunk_size=1200, overlap=200, min_size=50, max_size=1800)
        assert len(chunks) > 1
        for chunk in chunks:
            assert chunk["page_start"] >= 1
            assert chunk["page_end"] >= chunk["page_start"]
            # Page references must be within the PDF's page count.
            assert chunk["page_end"] <= 8

    def test_chunks_are_within_size_bounds(self) -> None:
        pages = extract_pdf_pages(fixture("multi-page-manual.pdf"))
        chunks = chunk_document(pages, chunk_size=500, overlap=50, min_size=20, max_size=800)
        assert chunks
        for chunk in chunks:
            assert len(chunk["normalized_text"]) <= 1800
            assert chunk["normalized_text"]  # not empty

    def test_empty_chunks_are_rejected(self) -> None:
        from app.core.errors import ServiceError

        pages = [PageExtraction(page_number=1, raw_text="")]
        with pytest.raises(ServiceError):
            chunk_document(pages, chunk_size=100, overlap=0, min_size=10, max_size=200)

    def test_chunk_overlap_creates_context_never_duplicates(self) -> None:
        pages = extract_pdf_pages(fixture("multi-page-manual.pdf"))
        chunks = chunk_document(pages, chunk_size=300, overlap=60, min_size=20, max_size=900)
        assert chunks
        # Consecutive chunks should not be identical.
        for a, b in zip(chunks, chunks[1:], strict=False):
            assert a["content_hash"] != b["content_hash"]

    def test_chunks_have_content_hash_and_metadata(self) -> None:
        pages = extract_pdf_pages(fixture("simple-text-manual.pdf"))
        chunks = chunk_document(pages, chunk_size=300, overlap=30, min_size=20, max_size=900)
        for chunk in chunks:
            assert chunk["content_hash"]
            assert chunk["chunk_index"] >= 0
            assert chunk["character_count"] > 0
