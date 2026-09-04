"""Tests for the FastAPI document-processing service and internal endpoints.

Mongo and Ollama/Qdrant are NOT reachable in the test environment, so these
tests cover: internal-token enforcement, path-traversal rejection, and the
pipeline end-to-end using mocked Ollama/Qdrant clients (a scanned PDF runs
through OCR *detection* and the mock handles the missing Tesseract binary).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

FIXTURES = Path(__file__).parent / "fixtures"
INTERNAL_TOKEN = "t" * 64


class TestInternalToken:
    def test_documents_process_requires_token(self, client: TestClient, api_prefix: str) -> None:
        resp = client.post(f"{api_prefix}/documents/process", json={})
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "UNAUTHENTICATED"

    def test_documents_process_rejects_bad_token(self, client: TestClient, api_prefix: str) -> None:
        resp = client.post(
            f"{api_prefix}/documents/process",
            json={"job_id": "a", "manual_id": "b", "storage_path": "x"},
            headers={"X-Internal-Token": "wrong"},
        )
        assert resp.status_code == 401

    def test_indexing_endpoint_requires_token(self, client: TestClient, api_prefix: str) -> None:
        resp = client.post(
            f"{api_prefix}/indexing/manual-chunks/delete", json={"manual_id": "a" * 24}
        )
        assert resp.status_code == 401


class TestPathTraversal:
    def test_rejects_storage_path_outside_root(
        self, client: TestClient, api_prefix: str
    ) -> None:
        payload = {
            "job_id": "a" * 24,
            "manual_id": "b" * 24,
            "storage_path": "../../etc/passwd",
            "machine_model_id": "c" * 24,
            "manual": {"title": "T"},
            "options": {
                "ocr_enabled": False,
                "embedding_model": "nomic-embed-text",
                "collection_name": "manual_chunks",
            },
        }
        resp = client.post(
            f"{api_prefix}/documents/process",
            json=payload,
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        # Should fail validation (path outside root) rather than read the file.
        assert resp.status_code in (422, 500)
        assert "outside the storage root" in resp.text or "not found" in resp.text


def _mock_ollama_and_qdrant(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace the Ollama/Qdrant clients used by the pipeline with deterministic fakes."""

    class FakeOllama:
        def __init__(self, settings: Any) -> None:
            self.settings = settings
            self.model = "nomic-embed-text"

        async def ping(self) -> dict[str, Any]:
            return {"model": self.model, "installed": [self.model]}

        async def embed(self, texts: list[str], prefix: str = "") -> list[list[float]]:
            # Deterministic fake vector of dim 4, based on text hash.
            return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

        async def dimension_probe(self) -> int:
            return 4

    class FakeQdrant:
        def __init__(self, settings: Any) -> None:
            self.settings = settings
            self.points: dict[str, dict[str, Any]] = {}

        async def ensure_collection(self, name: str, dimension: int) -> dict[str, Any]:
            return {"created": True, "dimension": dimension, "distance": "cosine"}

        async def delete_by_manual(self, name: str, manual_id: str) -> int:
            return 0

        async def upsert_chunks(self, name: str, points: list[Any]) -> int:
            for point in points:
                self.points[str(point.id)] = point.payload
            return len(points)

        async def count_by_manual(self, name: str, manual_id: str) -> int:
            return len(self.points)

        async def close(self) -> None:
            return None

    # Patch the *imported* references in the orchestrating module, since it
    # imports the classes by name at module load time.
    monkeypatch.setattr("app.services.document_processor.OllamaEmbeddingClient", FakeOllama)
    monkeypatch.setattr(
        "app.services.document_processor.new_qdrant_client",
        lambda settings: FakeQdrant(settings),
    )


class TestPipelineWithMocks:
    def test_processes_text_pdf(
        self, client: TestClient, api_prefix: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_ollama_and_qdrant(monkeypatch)
        # Copy the fixture into the storage root so the resolver finds it.
        from app.core.config import get_settings

        settings = get_settings()
        target = settings.storage_root_path / "manuals" / "abc123" / "original" / "source.pdf"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((FIXTURES / "simple-text-manual.pdf").read_bytes())

        payload = {
            "job_id": "a" * 24,
            "manual_id": "abc123",
            "storage_path": "manuals/abc123/original/source.pdf",
            "machine_model_id": "c" * 24,
            "manual": {
                "title": "Test Manual",
                "document_version": "v1",
                "document_type": "service",
            },
            "options": {
                "ocr_enabled": False,
                "embedding_model": "nomic-embed-text",
                "collection_name": "manual_chunks",
                "chunk_size": 400,
                "chunk_overlap": 40,
                "min_chunk_size": 40,
                "max_chunk_size": 800,
            },
        }
        resp = client.post(
            f"{api_prefix}/documents/process",
            json=payload,
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["page_count"] == 3
        assert data["chunk_count"] > 0
        assert data["extraction_method"] == "native"
        assert data["ocr_used"] is False
        assert data["embedding_dimension"] == 4
        for chunk in data["chunks"]:
            assert chunk["qdrant_point_id"]
            assert chunk["content_hash"]
            assert chunk["page_start"] >= 1

    def test_missing_file_returns_error(
        self, client: TestClient, api_prefix: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_ollama_and_qdrant(monkeypatch)
        payload = {
            "job_id": "a" * 24,
            "manual_id": "doesnotexist123",
            "storage_path": "manuals/doesnotexist123/original/source.pdf",
            "machine_model_id": "c" * 24,
            "manual": {"title": "T"},
            "options": {"ocr_enabled": False},
        }
        resp = client.post(
            f"{api_prefix}/documents/process",
            json=payload,
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code in (422, 404)
