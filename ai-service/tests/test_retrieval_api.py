"""Internal HTTP contract for retrieval and RAG endpoints."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.rag.generate import ScriptedGenerator
from app.rag.pipeline import PipelineDeps
from app.rag.semantic import MemoryVectorIndex
from app.rag.store import MemoryChunkStore
from tests.helpers_rag import (
    MODEL_A,
    FakeEmbedder,
    chunk_vector,
    chunks,
    manuals,
    rag_runtime_config,
)

INTERNAL_TOKEN = "t" * 64

GOOD_JSON = json.dumps(
    {
        "summary": "Error E-104 indicates low hydraulic pressure during startup.",
        "likely_causes": ["clogged suction filter"],
        "recommended_checks": ["Check the suction strainer"],
        "safety_notes": ["Apply LOTO."],
        "when_to_escalate": "",
        "cited_source_ids": ["source-1"],
        "evidence_insufficient": False,
        "notes_on_conflicts": "",
    }
)


def _deps() -> PipelineDeps:
    corpus = chunks()
    return PipelineDeps(
        store=MemoryChunkStore(manuals=manuals(), chunks=corpus),
        embedder=FakeEmbedder(),
        vectors=MemoryVectorIndex([(c, chunk_vector(c)) for c in corpus], dimension=4),
        generator=ScriptedGenerator([GOOD_JSON]),
        config=rag_runtime_config(),
        embedding_model="nomic-embed-text",
    )


@pytest.fixture
def patched_deps(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_build(_settings: Any, **_kwargs: Any) -> PipelineDeps:
        return _deps()

    monkeypatch.setattr("app.routers.retrieval.build_deps", fake_build)
    monkeypatch.setattr("app.routers.rag.build_deps", fake_build)


class TestAuth:
    def test_search_requires_token(self, client: TestClient, api_prefix: str) -> None:
        resp = client.post(f"{api_prefix}/retrieval/search", json={"query": "E-104"})
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "UNAUTHENTICATED"

    def test_answer_requires_token(self, client: TestClient, api_prefix: str) -> None:
        resp = client.post(f"{api_prefix}/rag/answer", json={"query": "E-104"})
        assert resp.status_code == 401

    def test_health_requires_token(self, client: TestClient, api_prefix: str) -> None:
        resp = client.get(f"{api_prefix}/rag/health")
        assert resp.status_code == 401


class TestContracts:
    def test_search_returns_ranked_hits(
        self, client: TestClient, api_prefix: str, patched_deps: None
    ) -> None:
        resp = client.post(
            f"{api_prefix}/retrieval/search",
            json={"query": "Why is error E-104 appearing?", "machine_model_id": MODEL_A},
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["results"]
        assert all(h["machine_model_id"] == MODEL_A for h in data["results"])
        assert data["retrieval"]["exact_matches"] >= 1

    def test_answer_returns_grounded_response(
        self, client: TestClient, api_prefix: str, patched_deps: None
    ) -> None:
        resp = client.post(
            f"{api_prefix}/rag/answer",
            json={"query": "Why is error E-104 appearing during hydraulic startup?", "machine_model_id": MODEL_A},
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["status"] == "answered"
        assert data["evidence_sufficient"] is True
        assert data["sources"]
        assert "Hydraulic Service Manual" in json.dumps(data["sources"])

    def test_clarification_when_model_missing(
        self, client: TestClient, api_prefix: str, patched_deps: None
    ) -> None:
        resp = client.post(
            f"{api_prefix}/rag/answer",
            json={"query": "Why is error E-104 appearing during hydraulic startup?"},
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["status"] == "clarification_required"
        assert data["reason"] == "MACHINE_MODEL_REQUIRED"

    def test_empty_query_is_422(self, client: TestClient, api_prefix: str) -> None:
        resp = client.post(
            f"{api_prefix}/retrieval/search",
            json={"query": ""},
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
