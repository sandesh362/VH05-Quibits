"""Environment configuration and validation for the RAG service.

Mirrors the Express validation strategy: fail loudly at import time on a
missing or placeholder secret rather than defaulting to something insecure.
See docs/SECURITY_AND_RELIABILITY.md 19.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# ai-service/app/core/config.py -> ai-service/app/core -> app -> ai-service -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]

# Placeholders shipped in .env.example. Surviving into a real boot means the
# operator never generated secrets.
PLACEHOLDER_VALUES: frozenset[str] = frozenset(
    {
        "change_me_generate_with_openssl_rand_hex_32",
        "change_me_use_a_different_openssl_rand_hex_32",
        "changeme",
        "change_me",
        "secret",
        "your-secret-here",
    }
)


class ConfigValidationError(RuntimeError):
    """Raised when the environment is not usable."""


class Settings(BaseSettings):
    """Validated service configuration.

    Values are read from the environment, falling back to the repo-root .env.
    Real environment variables (e.g. from Docker Compose) always win.
    """

    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # -- Application ---------------------------------------------------------
    PYTHON_ENV: str = Field(default="development")
    APP_NAME: str = Field(default="industrial-troubleshooting-platform")
    RAG_SERVICE_PORT: int = Field(default=8000, ge=1, le=65535)
    RAG_API_PREFIX: str = Field(default="/internal/v1")
    LOG_LEVEL: str = Field(default="INFO")

    # -- Security ------------------------------------------------------------
    # Shared secret for Express -> FastAPI calls. Required.
    INTERNAL_SERVICE_TOKEN: str = Field(...)

    # -- MongoDB -------------------------------------------------------------
    # Optional here: in Phase 1 the RAG service performs no database work.
    # It probes Mongo for the readiness report only.
    MONGODB_URI: str = Field(default="")
    MONGO_DB_NAME: str = Field(default="itp")

    # -- Qdrant --------------------------------------------------------------
    QDRANT_URL: str = Field(default="http://localhost:6333")
    QDRANT_API_KEY: str = Field(default="")

    # -- Ollama --------------------------------------------------------------
    OLLAMA_BASE_URL: str = Field(default="http://localhost:11434")
    # Empty until an operator pulls a model. Never assume one is installed.
    OLLAMA_CHAT_MODEL: str = Field(default="llama3.1:3b")
    OLLAMA_EMBEDDING_MODEL: str = Field(default="all-minilm")
    OLLAMA_TIMEOUT_MS: int = Field(default=120_000, ge=100, le=120_000)

    # -- Retrieval / RAG (Phase 4) -------------------------------------------
    RAG_TEMPERATURE: float = Field(default=0.1, ge=0.0, le=1.0)
    RAG_MAX_OUTPUT_TOKENS: int = Field(default=1200, ge=32, le=8192)
    RAG_REQUEST_TIMEOUT_MS: int = Field(default=120_000, ge=1000, le=300_000)
    RAG_TOP_K: int = Field(default=8, ge=1, le=50)
    RAG_MIN_CONTEXT_CHUNKS: int = Field(default=1, ge=1, le=20)
    RAG_MIN_SEMANTIC_SCORE: float = Field(default=0.45, ge=0.0, le=1.0)
    RAG_MIN_FINAL_SCORE: float = Field(default=0.45, ge=0.0, le=1.0)
    RAG_REQUIRE_SOURCE_METADATA: bool = Field(default=True)
    RAG_ALLOW_UNSUPPORTED_ANSWER: bool = Field(default=False)
    RAG_MAX_CONTEXT_CHARS: int = Field(default=12_000, ge=500, le=200_000)
    RAG_MAX_PROMPT_CHARS: int = Field(default=24_000, ge=1000, le=400_000)
    RAG_CANDIDATE_LIMIT: int = Field(default=40, ge=5, le=200)
    RAG_NEAR_DUPLICATE_THRESHOLD: float = Field(default=0.92, ge=0.5, le=1.0)
    RAG_WEIGHT_EXACT_MATCH: float = Field(default=0.35, ge=0.0, le=1.0)
    RAG_WEIGHT_TECHNICAL_TERM: float = Field(default=0.15, ge=0.0, le=1.0)
    RAG_WEIGHT_MACHINE_SCOPE: float = Field(default=0.10, ge=0.0, le=1.0)
    RAG_WEIGHT_MANUAL_SCOPE: float = Field(default=0.10, ge=0.0, le=1.0)
    RAG_WEIGHT_SEMANTIC: float = Field(default=0.45, ge=0.0, le=1.0)
    RAG_WEIGHT_SECTION: float = Field(default=0.05, ge=0.0, le=1.0)
    RAG_DUPLICATE_PENALTY: float = Field(default=0.05, ge=0.0, le=1.0)
    RAG_EXPECTED_EMBEDDING_DIMENSION: int = Field(default=384, ge=0, le=4096)
    RAG_LOG_QUERY_TEXT: bool = Field(default=False)

    # -- Storage -------------------------------------------------------------
    STORAGE_ROOT: str = Field(default="./storage")

    # -- Manual document processing (Phase 3) ---------------------------------
    # Whether OCR is automatically applied to text-poor pages.
    OCR_ENABLED: bool = Field(default=True)
    OCR_LANGUAGE: str = Field(default="eng")
    # A page with fewer extractable characters than this is considered text-poor
    # and routed to OCR (when enabled).
    OCR_MIN_TEXT_CHARACTERS_PER_PAGE: int = Field(default=50, ge=1, le=100_000)

    # Chunking settings (characters). CHUNK_SIZE is the target; CHUNK_OVERLAP
    # is the amount shared between consecutive chunks.
    CHUNK_SIZE: int = Field(default=1200, ge=100, le=100_000)
    CHUNK_OVERLAP: int = Field(default=200, ge=0, le=50_000)
    MIN_CHUNK_SIZE: int = Field(default=200, ge=1, le=100_000)
    MAX_CHUNK_SIZE: int = Field(default=1800, ge=100, le=200_000)

    CHUNKING_VERSION: str = Field(default="cv1")

    # Qdrant collection holding manual chunk vectors.
    QDRANT_MANUAL_COLLECTION: str = Field(default="manual_chunks")

    # -- Incident memory (Phase 6) -------------------------------------------
    # Separate Qdrant collection: incident vectors never mix with manual chunks.
    QDRANT_INCIDENT_COLLECTION: str = Field(default="incident_memory")
    INCIDENT_HISTORY_TOP_K: int = Field(default=4, ge=1, le=10)
    INCIDENT_HISTORY_MIN_SEMANTIC_SCORE: float = Field(default=0.5, ge=0.0, le=1.0)
    INCIDENT_HISTORY_MAX_CONTEXT_CHARS: int = Field(default=2_500, ge=200, le=20_000)

    # Hard wall-clock cap for a single processing job.
    MANUAL_PROCESSING_TIMEOUT_MS: int = Field(default=1_800_000, ge=10_000, le=10_800_000)

    # -- Health probes -------------------------------------------------------
    HEALTH_CHECK_TIMEOUT_MS: int = Field(default=10_000, ge=100, le=60_000)

    # -- CORS ----------------------------------------------------------------
    # Empty by default: this service is internal-only and must not be reachable
    # from a browser. A value is accepted purely for local debugging.
    RAG_CORS_ORIGIN: str = Field(default="")

    # ------------------------------------------------------------------ #
    # Validators
    # ------------------------------------------------------------------ #

    @field_validator("PYTHON_ENV")
    @classmethod
    def _valid_environment(cls, value: str) -> str:
        allowed = {"development", "test", "production"}
        if value not in allowed:
            raise ValueError(f"PYTHON_ENV must be one of {sorted(allowed)}, got {value!r}")
        return value

    @field_validator("LOG_LEVEL")
    @classmethod
    def _valid_log_level(cls, value: str) -> str:
        allowed = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}
        upper = value.upper()
        if upper not in allowed:
            raise ValueError(f"LOG_LEVEL must be one of {sorted(allowed)}, got {value!r}")
        return upper

    @field_validator("INTERNAL_SERVICE_TOKEN")
    @classmethod
    def _valid_internal_token(cls, value: str) -> str:
        if value.strip().lower() in PLACEHOLDER_VALUES:
            raise ValueError(
                "INTERNAL_SERVICE_TOKEN is still the .env.example placeholder. "
                "Generate a real value: openssl rand -hex 32"
            )
        if len(value) < 32:
            raise ValueError(
                "INTERNAL_SERVICE_TOKEN must be at least 32 characters "
                "(generate: openssl rand -hex 32)"
            )
        return value

    @field_validator("MONGODB_URI")
    @classmethod
    def _local_mongo_only(cls, value: str) -> str:
        if value and "mongodb.net" in value:
            raise ValueError(
                "MongoDB Atlas (mongodb.net) is not permitted. "
                "This platform must run fully locally."
            )
        if value and not value.startswith(("mongodb://", "mongodb+srv://")):
            raise ValueError("MONGODB_URI must start with mongodb:// or mongodb+srv://")
        return value

    @field_validator("QDRANT_URL", "OLLAMA_BASE_URL")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError(f"URL must start with http:// or https://, got {value!r}")
        return value.rstrip("/")

    @field_validator("RAG_API_PREFIX")
    @classmethod
    def _valid_prefix(cls, value: str) -> str:
        if not value.startswith("/"):
            raise ValueError('RAG_API_PREFIX must start with "/"')
        return value.rstrip("/")

    @model_validator(mode="after")
    def _forbid_hosted_ai(self) -> Settings:
        """Guardrail: this platform must never depend on a hosted AI service."""
        forbidden = ("openai.com", "anthropic.com", "googleapis.com", "pinecone.io")
        for host in forbidden:
            if host in self.OLLAMA_BASE_URL or host in self.QDRANT_URL:
                raise ValueError(
                    f"Hosted AI/vector service detected ({host}). "
                    "All AI processing must run locally."
                )
        return self

    # ------------------------------------------------------------------ #
    # Derived helpers
    # ------------------------------------------------------------------ #

    @property
    def is_production(self) -> bool:
        return self.PYTHON_ENV == "production"

    @property
    def is_test(self) -> bool:
        return self.PYTHON_ENV == "test"

    @property
    def ollama_timeout_seconds(self) -> float:
        return self.OLLAMA_TIMEOUT_MS / 1000

    @property
    def health_timeout_seconds(self) -> float:
        return self.HEALTH_CHECK_TIMEOUT_MS / 1000

    @property
    def cors_origins(self) -> list[str]:
        if not self.RAG_CORS_ORIGIN:
            return []
        return [o.strip() for o in self.RAG_CORS_ORIGIN.split(",") if o.strip()]

    @property
    def storage_root_path(self) -> Path:
        root = Path(self.STORAGE_ROOT)
        return root if root.is_absolute() else (REPO_ROOT / root).resolve()

    @property
    def manual_storage_root(self) -> Path:
        """Root directory for manual artifacts: <storage>/manuals."""
        return self.storage_root_path / "manuals"

    @property
    def embedding_model(self) -> str:
        """The Ollama embedding model used for all manual chunk vectors."""
        return self.OLLAMA_EMBEDDING_MODEL

    @property
    def manual_timeout_seconds(self) -> float:
        return self.MANUAL_PROCESSING_TIMEOUT_MS / 1000


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the memoised settings, raising a readable error on failure."""
    try:
        return Settings()  # type: ignore[call-arg]
    except Exception as exc:  # noqa: BLE001 - re-raised with actionable context
        raise ConfigValidationError(
            "Invalid environment configuration for the RAG service.\n"
            f"{exc}\n\n"
            "Fix: copy .env.example to .env and set the required values.\n"
            "Generate secrets with: openssl rand -hex 32"
        ) from exc


def redact_uri(uri: str) -> str:
    """Strip credentials from a URI before logging: //user:pass@ -> //***:***@"""
    import re

    return re.sub(r"//[^@/]+@", "//***:***@", uri)
