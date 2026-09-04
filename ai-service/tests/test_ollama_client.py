"""Diagnostics emitted by the Ollama embedding client."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.clients.ollama import OllamaEmbeddingClient
from app.core.config import get_settings
from app.core.errors import ServiceError


class MockAsyncClient:
    """Minimal async HTTPX stand-in returning a configured result."""

    result: httpx.Response | Exception

    def __init__(self, *, timeout: float) -> None:
        self.timeout = timeout

    async def __aenter__(self) -> MockAsyncClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def post(self, *args: Any, **kwargs: Any) -> httpx.Response:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.mark.asyncio
async def test_embedding_http_failure_keeps_actionable_safe_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    MockAsyncClient.result = httpx.Response(500, text="model requires more memory")
    monkeypatch.setattr("app.clients.ollama.httpx.AsyncClient", MockAsyncClient)

    with pytest.raises(ServiceError) as raised:
        await OllamaEmbeddingClient(get_settings()).embed(["private manual text"])

    error = raised.value
    assert error.message == "Ollama embedding failed (HTTP 500)."
    assert error.internal_context["http_status"] == 500
    assert error.internal_context["response_excerpt"] == "model requires more memory"
    assert error.internal_context["input_count"] == 1
    assert error.internal_context["input_characters"] == len("private manual text")
    assert "private manual text" not in error.internal_context.values()


@pytest.mark.asyncio
async def test_embedding_timeout_includes_transport_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    MockAsyncClient.result = httpx.ReadTimeout("upstream timed out")
    monkeypatch.setattr("app.clients.ollama.httpx.AsyncClient", MockAsyncClient)

    with pytest.raises(ServiceError) as raised:
        await OllamaEmbeddingClient(get_settings()).embed(["private manual text"])

    error = raised.value
    assert error.message == "Ollama embedding request timed out."
    assert error.internal_context["exception_type"] == "ReadTimeout"
    assert error.internal_context["exception_detail"] == "upstream timed out"
    assert error.internal_context["elapsed_ms"] >= 0
