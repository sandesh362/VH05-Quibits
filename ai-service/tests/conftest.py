"""Pytest configuration for the RAG service.

Sets a valid, self-contained environment BEFORE the application is imported.
Dependency URLs point at an unroutable port so probes fail fast and
deterministically instead of hitting a real service.
"""

from __future__ import annotations

import os

# Must run before `app.*` is imported - settings are read at import time.
os.environ["PYTHON_ENV"] = "test"
os.environ["LOG_LEVEL"] = "CRITICAL"
os.environ["RAG_API_PREFIX"] = "/internal/v1"

# 64-char test secret. Not a real credential.
os.environ["INTERNAL_SERVICE_TOKEN"] = "t" * 64

# Port 1 is never bound - probes fail quickly and predictably.
os.environ["QDRANT_URL"] = "http://127.0.0.1:1"
os.environ["OLLAMA_BASE_URL"] = "http://127.0.0.1:1"
os.environ["MONGODB_URI"] = ""  # RAG service does not use Mongo in Phase 1
os.environ["HEALTH_CHECK_TIMEOUT_MS"] = "1000"
os.environ["OLLAMA_TIMEOUT_MS"] = "1000"
os.environ["RAG_CORS_ORIGIN"] = ""
os.environ["STORAGE_ROOT"] = "./storage"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="session")
def client() -> TestClient:
    """Test client with lifespan events executed."""
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def api_prefix() -> str:
    return "/internal/v1"
