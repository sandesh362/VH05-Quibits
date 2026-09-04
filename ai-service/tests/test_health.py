"""HTTP contract tests for the Phase 1 RAG service surface.

Dependencies are deliberately unreachable, which proves the readiness endpoint
reports REAL state rather than a hardcoded "healthy" response.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


class TestHealthEndpoint:
    def test_returns_200_with_success_envelope(self, client: TestClient, api_prefix: str) -> None:
        response = client.get(f"{api_prefix}/health")

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["status"] == "ok"
        assert body["data"]["service"] == "rag-service"
        assert "requestId" in body["meta"]
        assert "timestamp" in body["meta"]

    def test_reports_uptime(self, client: TestClient, api_prefix: str) -> None:
        body = client.get(f"{api_prefix}/health").json()
        assert isinstance(body["data"]["uptimeSeconds"], int)
        assert body["data"]["uptimeSeconds"] >= 0

    def test_does_not_probe_dependencies(self, client: TestClient, api_prefix: str) -> None:
        """Liveness must stay fast; probes would add ~1s of timeout."""
        import time

        started = time.perf_counter()
        client.get(f"{api_prefix}/health")
        assert (time.perf_counter() - started) < 0.5

    def test_unversioned_alias_works(self, client: TestClient) -> None:
        response = client.get("/healthz")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestReadinessEndpoint:
    def test_reports_real_dependency_state(self, client: TestClient, api_prefix: str) -> None:
        response = client.get(f"{api_prefix}/ready")

        assert response.status_code == 200  # nothing is REQUIRED in Phase 1
        data = response.json()["data"]

        # Unreachable dependencies must be reported as down, never as ok.
        qdrant = next(c for c in data["checks"] if c["name"] == "qdrant")
        assert qdrant["status"] == "down"
        assert qdrant["error"]

        ollama = next(c for c in data["checks"] if c["name"] == "ollama")
        assert ollama["status"] == "down"

    def test_probes_all_dependencies(self, client: TestClient, api_prefix: str) -> None:
        data = client.get(f"{api_prefix}/ready").json()["data"]
        names = sorted(c["name"] for c in data["checks"])
        assert names == ["mongodb", "ollama", "qdrant"]

    def test_mongodb_reported_disabled_when_unconfigured(
        self, client: TestClient, api_prefix: str
    ) -> None:
        """An unset MONGODB_URI is a valid Phase 1 configuration, not a failure."""
        data = client.get(f"{api_prefix}/ready").json()["data"]
        mongo = next(c for c in data["checks"] if c["name"] == "mongodb")
        assert mongo["status"] == "disabled"
        assert mongo["required"] is False

    def test_status_is_degraded_not_down(self, client: TestClient, api_prefix: str) -> None:
        """No dependency is required in Phase 1, so the service stays usable."""
        data = client.get(f"{api_prefix}/ready").json()["data"]
        assert data["ready"] is True
        assert data["status"] == "degraded"

    def test_lists_degraded_capabilities(self, client: TestClient, api_prefix: str) -> None:
        data = client.get(f"{api_prefix}/ready").json()["data"]
        assert "vector_search" in data["degradedCapabilities"]
        assert "embeddings" in data["degradedCapabilities"]

    def test_reports_probe_duration(self, client: TestClient, api_prefix: str) -> None:
        data = client.get(f"{api_prefix}/ready").json()["data"]
        assert isinstance(data["durationMs"], int)
        assert data["durationMs"] >= 0

    def test_no_credentials_in_response(self, client: TestClient, api_prefix: str) -> None:
        raw = client.get(f"{api_prefix}/ready").text
        assert "://" not in raw or "@" not in raw.split("://")[-1][:60]


class TestSystemInfoEndpoint:
    def test_returns_build_information(self, client: TestClient, api_prefix: str) -> None:
        response = client.get(f"{api_prefix}/system/info")

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["service"] == "rag-service"
        assert "Phase 5" in data["phase"]
        assert data["pythonVersion"]

    def test_phase_5_conversation_context_enabled(
        self, client: TestClient, api_prefix: str
    ) -> None:
        """Phase 5 ships conversation-aware RAG on top of retrieval."""
        data = client.get(f"{api_prefix}/system/info").json()["data"]
        features = data["features"]
        assert features["pdf_extraction"] is True
        assert features["ocr"] is True
        assert features["chunking"] is True
        assert features["embeddings"] is True
        assert features["vector_indexing"] is True
        assert features["retrieval"] is True
        assert features["rag_answers"] is True
        assert features["citation_validation"] is True
        assert features["conversation_context"] is True

    def test_does_not_leak_urls_or_credentials(
        self, client: TestClient, api_prefix: str
    ) -> None:
        raw = client.get(f"{api_prefix}/system/info").text
        assert "qdrant" in raw  # the NAME is fine
        assert "127.0.0.1" not in raw  # the LOCATION is not
        assert "6333" not in raw
        assert "11434" not in raw


class TestErrorHandling:
    def test_unknown_route_returns_failure_envelope(
        self, client: TestClient, api_prefix: str
    ) -> None:
        response = client.get(f"{api_prefix}/does-not-exist")

        assert response.status_code == 404
        body = response.json()
        assert body["success"] is False
        assert body["error"]["code"] == "NOT_FOUND"
        assert "requestId" in body["error"]

    def test_unknown_root_route(self, client: TestClient) -> None:
        body = client.get("/nope").json()
        assert body["success"] is False
        assert body["error"]["code"] == "NOT_FOUND"

    def test_wrong_method_returns_405(self, client: TestClient, api_prefix: str) -> None:
        response = client.post(f"{api_prefix}/health")
        assert response.status_code == 405
        assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"

    def test_error_shape_is_consistent(self, client: TestClient, api_prefix: str) -> None:
        body = client.get(f"{api_prefix}/missing").json()
        assert sorted(body.keys()) == ["error", "success"]
        assert body["error"]["code"].isupper()

    def test_no_stack_trace_in_response(self, client: TestClient, api_prefix: str) -> None:
        raw = client.get(f"{api_prefix}/missing").text
        assert "Traceback" not in raw
        assert ".py" not in raw


class TestRequestCorrelation:
    def test_generates_request_id(self, client: TestClient, api_prefix: str) -> None:
        response = client.get(f"{api_prefix}/health")
        assert response.headers.get("x-request-id")
        assert response.json()["meta"]["requestId"] == response.headers["x-request-id"]

    def test_propagates_safe_client_id(self, client: TestClient, api_prefix: str) -> None:
        response = client.get(
            f"{api_prefix}/health", headers={"X-Request-Id": "client-trace-12345"}
        )
        assert response.headers["x-request-id"] == "client-trace-12345"

    def test_rejects_unsafe_client_id(self, client: TestClient, api_prefix: str) -> None:
        response = client.get(
            f"{api_prefix}/health", headers={"X-Request-Id": "<script>alert(1)</script>"}
        )
        assert "<script>" not in response.headers["x-request-id"]
        assert response.headers["x-request-id"].startswith("req_")

    def test_unique_id_per_request(self, client: TestClient, api_prefix: str) -> None:
        first = client.get(f"{api_prefix}/health").json()["meta"]["requestId"]
        second = client.get(f"{api_prefix}/health").json()["meta"]["requestId"]
        assert first != second


class TestCorsDisabledByDefault:
    def test_no_cors_headers_on_internal_service(
        self, client: TestClient, api_prefix: str
    ) -> None:
        """The RAG service is internal-only; a browser must not be able to call it."""
        response = client.get(
            f"{api_prefix}/health", headers={"Origin": "http://evil.example.com"}
        )
        assert "access-control-allow-origin" not in {k.lower() for k in response.headers}
