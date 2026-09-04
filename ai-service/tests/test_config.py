"""Environment validation tests for the RAG service.

The promise "the service refuses to boot with a placeholder secret" is only
real if it is tested.
"""

from __future__ import annotations

import pytest

from app.core.config import Settings, redact_uri


def valid_env(**overrides: str) -> dict[str, str]:
    """Minimal environment that must always validate."""
    base = {
        "PYTHON_ENV": "test",
        "INTERNAL_SERVICE_TOKEN": "a" * 64,
        "QDRANT_URL": "http://localhost:6333",
        "OLLAMA_BASE_URL": "http://localhost:11434",
    }
    base.update(overrides)
    return base


def build(**overrides: str) -> Settings:
    """Construct Settings from an explicit dict, bypassing the .env file."""
    return Settings(_env_file=None, **valid_env(**overrides))  # type: ignore[arg-type]


class TestValidConfiguration:
    def test_accepts_valid_environment(self) -> None:
        settings = build()
        assert settings.PYTHON_ENV == "test"
        assert settings.RAG_SERVICE_PORT == 8000
        assert settings.RAG_API_PREFIX == "/internal/v1"

    def test_applies_documented_defaults(self) -> None:
        settings = build()
        assert settings.OLLAMA_EMBEDDING_MODEL == "nomic-embed-text"
        assert settings.MONGO_DB_NAME == "itp"
        # Chat model stays empty until an operator pulls one.
        assert settings.OLLAMA_CHAT_MODEL == ""

    def test_strips_trailing_slashes(self) -> None:
        settings = build(QDRANT_URL="http://localhost:6333/")
        assert settings.QDRANT_URL == "http://localhost:6333"

    def test_derives_timeout_seconds(self) -> None:
        settings = build(OLLAMA_TIMEOUT_MS="2500")
        assert settings.ollama_timeout_seconds == 2.5

    def test_cors_disabled_by_default(self) -> None:
        assert build().cors_origins == []

    def test_parses_cors_allowlist(self) -> None:
        settings = build(RAG_CORS_ORIGIN="http://localhost:5173, http://localhost:3000")
        assert settings.cors_origins == ["http://localhost:5173", "http://localhost:3000"]


class TestSecretValidation:
    def test_rejects_placeholder_token(self) -> None:
        with pytest.raises(ValueError, match="placeholder"):
            build(INTERNAL_SERVICE_TOKEN="change_me_generate_with_openssl_rand_hex_32")

    def test_rejects_short_token(self) -> None:
        with pytest.raises(ValueError, match="at least 32 characters"):
            build(INTERNAL_SERVICE_TOKEN="tooshort")

    def test_rejects_missing_token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # conftest exports INTERNAL_SERVICE_TOKEN for the app fixture; remove it
        # so this test genuinely exercises the "absent variable" path.
        monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
        with pytest.raises(ValueError, match="INTERNAL_SERVICE_TOKEN"):
            Settings(_env_file=None, PYTHON_ENV="test")  # type: ignore[call-arg]


class TestLocalOnlyEnforcement:
    def test_rejects_mongodb_atlas(self) -> None:
        with pytest.raises(ValueError, match="must run fully locally"):
            build(MONGODB_URI="mongodb+srv://u:p@cluster0.mongodb.net/db")

    def test_rejects_malformed_mongo_uri(self) -> None:
        with pytest.raises(ValueError, match="must start with mongodb"):
            build(MONGODB_URI="postgres://localhost/db")

    def test_accepts_empty_mongo_uri(self) -> None:
        """The RAG service does not need MongoDB in Phase 1."""
        assert build(MONGODB_URI="").MONGODB_URI == ""

    def test_rejects_hosted_ai_endpoint(self) -> None:
        with pytest.raises(ValueError, match="must run locally"):
            build(OLLAMA_BASE_URL="https://api.openai.com")

    def test_rejects_hosted_vector_service(self) -> None:
        with pytest.raises(ValueError, match="must run locally"):
            build(QDRANT_URL="https://my-index.pinecone.io")


class TestFieldValidation:
    def test_rejects_invalid_environment(self) -> None:
        with pytest.raises(ValueError, match="PYTHON_ENV"):
            build(PYTHON_ENV="staging")

    def test_rejects_invalid_log_level(self) -> None:
        with pytest.raises(ValueError, match="LOG_LEVEL"):
            build(LOG_LEVEL="verbose")

    def test_normalises_log_level_case(self) -> None:
        assert build(LOG_LEVEL="debug").LOG_LEVEL == "DEBUG"

    def test_rejects_out_of_range_port(self) -> None:
        with pytest.raises(ValueError):
            build(RAG_SERVICE_PORT="99999")

    def test_rejects_url_without_scheme(self) -> None:
        with pytest.raises(ValueError, match="must start with http"):
            build(QDRANT_URL="localhost:6333")

    def test_rejects_prefix_without_leading_slash(self) -> None:
        with pytest.raises(ValueError, match="must start with"):
            build(RAG_API_PREFIX="internal/v1")


class TestRedactUri:
    def test_removes_credentials(self) -> None:
        assert (
            redact_uri("mongodb://user:secret@localhost:27017/itp")
            == "mongodb://***:***@localhost:27017/itp"
        )

    def test_leaves_clean_uri_unchanged(self) -> None:
        assert redact_uri("mongodb://localhost:27017/itp") == "mongodb://localhost:27017/itp"

    def test_never_leaks_password(self) -> None:
        assert "hunter2" not in redact_uri("mongodb://admin:hunter2@host/db")
