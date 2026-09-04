"""Unit tests for deterministic query preprocessing."""

from __future__ import annotations

from app.rag.normalize import (
    canonicalize_error_code,
    error_code_variants,
    identifier_regex,
    normalize_query,
)


class TestErrorCodes:
    def test_extracts_e104_variants(self) -> None:
        for raw in ("E-104", "e104", "E 104", "error E-104"):
            extracted = normalize_query(f"Why is {raw} appearing during hydraulic startup?")
            assert "E-104" in extracted.error_codes

    def test_extracts_err_204(self) -> None:
        extracted = normalize_query("Alarm ERR_204 on the hydraulic pump")
        assert any(c.startswith("ERR") for c in extracted.error_codes)

    def test_does_not_confuse_similar_codes(self) -> None:
        text = "E-104 versus E-140 versus E-014"
        extracted = normalize_query(text)
        assert "E-104" in extracted.error_codes
        assert "E-140" in extracted.error_codes
        pattern = identifier_regex("E-104")
        assert pattern.search("E-104")
        assert pattern.search("E104")
        assert not pattern.search("E-140")
        assert not pattern.search("E-014")
        assert not pattern.search("E-1040")

    def test_variants_do_not_invent_neighbours(self) -> None:
        variants = error_code_variants("E-104")
        assert "E-104" in variants
        assert "E104" in variants
        assert "E-140" not in variants
        assert "E-014" not in variants


class TestTechnicalExtraction:
    def test_extracts_units_and_fasteners(self) -> None:
        extracted = normalize_query("Torque the M12 x 1.5 fitting at 24 VDC and 3.5 bar")
        assert any("M12" in p.upper() for p in extracted.part_numbers)
        assert any("24 VDC" in u or "24VDC" in u.replace(" ", "") for u in extracted.units)

    def test_extracts_plc_point(self) -> None:
        extracted = normalize_query("PLC input X1-14 is not coming on")
        assert any("X1-14" in n.upper() for n in extracted.component_names)

    def test_extracts_hydraulic_terms(self) -> None:
        extracted = normalize_query("hydraulic pressure drops during startup")
        assert "hydraulic" in extracted.technical_terms or "hydraulic pressure" in extracted.technical_terms
        assert "startup" in extracted.technical_terms or extracted.operating_conditions

    def test_preserves_original_query(self) -> None:
        original = "  Why is error E-104 appearing?  "
        extracted = normalize_query(original)
        assert extracted.original == original
        assert extracted.normalized != original
        assert "E-104" in extracted.normalized


class TestClassification:
    def test_error_code_requires_scope(self) -> None:
        extracted = normalize_query("Why is error E-104 appearing during hydraulic startup?")
        assert extracted.kind == "error_code"
        assert extracted.requires_machine_scope is True

    def test_general_question_does_not_require_scope(self) -> None:
        extracted = normalize_query("What does 24 VDC mean on a nameplate?")
        assert extracted.kind == "general"
        assert extracted.requires_machine_scope is False

    def test_troubleshooting_requires_scope(self) -> None:
        extracted = normalize_query("Why is the hydraulic pump overheating after twenty minutes?")
        assert extracted.kind == "troubleshooting"
        assert extracted.requires_machine_scope is True

    def test_canonicalise(self) -> None:
        assert canonicalize_error_code("e104") == "E-104"
        assert canonicalize_error_code("ERR_204") == "ERR_204"
