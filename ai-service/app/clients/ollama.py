"""Ollama embedding client.

Embeddings are the ONLY Ollama capability authorised in Phase 3. The chat model
is never used here. This module centralises the model name, the document/query
prefix convention, and the sanity checks (reachable, model present, non-empty
vector, correct dimension) so the indexing path cannot drift from the query path.
"""

from __future__ import annotations

from typing import Any
from time import perf_counter

import httpx

from app.core.config import Settings, redact_uri
from app.core.errors import ServiceError
from app.core.logging import get_logger

log = get_logger()

# Asymmetric prefixes used by nomic-embed-text and similar models. The SAME
# convention must be used at index time (`search_document:`) and at query time
# (`search_query:`) for retrieval to work.
DOCUMENT_PREFIX = "search_document: "
QUERY_PREFIX = "search_query: "


class OllamaEmbeddingClient:
    """Thin client around Ollama's `/api/embed` endpoint."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.base_url = settings.OLLAMA_BASE_URL
        self.timeout = settings.ollama_timeout_seconds

    def _embedding_context(self, texts: list[str], prefix: str) -> dict[str, Any]:
        """Return diagnostic metadata without retaining manual or query content."""
        lengths = [len(text) for text in texts]
        return {
            "operation": "embedding",
            "ollama_url": redact_uri(f"{self.base_url.rstrip('/')}/api/embed"),
            "embedding_model": self.settings.embedding_model,
            "timeout_seconds": self.timeout,
            "input_count": len(texts),
            "input_characters": sum(lengths),
            "largest_input_characters": max(lengths, default=0),
            "prefix": "document" if prefix == DOCUMENT_PREFIX else "query",
        }

    async def ping(self) -> dict[str, Any]:
        """Verify Ollama is reachable and the configured embedding model is present.

        Returns the model info on success. Raises ServiceError (SERVICE_UNAVAILABLE)
        when unreachable or when the model has not been pulled.
        """
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(f"{self.base_url}/api/tags")
        except Exception as exc:  # noqa: BLE001 - wrap as a dependency error
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Ollama is unreachable. Is `ollama serve` running?",
                internal_context={"detail": str(exc)},
            ) from exc

        if response.status_code >= 400:
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                f"Ollama responded with HTTP {response.status_code}.",
            )

        installed = [m.get("name", "") for m in response.json().get("models", [])]
        wanted = self.settings.embedding_model

        def present(name: str) -> bool:
            base = name.split(":")[0]
            return any(n == name or n.split(":")[0] == base for n in installed)

        if not present(wanted):
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                f"Embedding model '{wanted}' is not pulled. Run: ollama pull {wanted}",
            )

        return {"model": wanted, "installed": installed}

    async def embed(self, texts: list[str], prefix: str = DOCUMENT_PREFIX) -> list[list[float]]:
        """Embed a batch of texts with the given prefix.

        Validates: a non-empty response, one vector per input, and a non-empty
        vector. Dimension consistency is enforced by the caller via Qdrant.
        Raises ServiceError on any anomaly.
        """
        if not texts:
            return []

        prefixed = [f"{prefix}{t}" for t in texts]
        context = self._embedding_context(texts, prefix)
        started_at = perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/api/embed",
                    json={"model": self.settings.embedding_model, "input": prefixed},
                )
        except httpx.TimeoutException as exc:
            context.update(
                exception_type=exc.__class__.__name__,
                exception_detail=str(exc)[:300],
                elapsed_ms=round((perf_counter() - started_at) * 1000),
            )
            log.exception("ollama_embedding_timeout", **context)
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Ollama embedding request timed out.",
                internal_context=context,
            ) from exc
        except Exception as exc:  # noqa: BLE001
            context.update(
                exception_type=exc.__class__.__name__,
                exception_detail=str(exc)[:300],
                elapsed_ms=round((perf_counter() - started_at) * 1000),
            )
            log.exception("ollama_embedding_transport_error", **context)
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Ollama embedding request failed.",
                internal_context=context,
            ) from exc

        if response.status_code >= 400:
            context.update(
                http_status=response.status_code,
                response_excerpt=response.text[:500],
                elapsed_ms=round((perf_counter() - started_at) * 1000),
            )
            log.error("ollama_embedding_http_error", **context)
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                f"Ollama embedding failed (HTTP {response.status_code}).",
                internal_context=context,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            context.update(
                http_status=response.status_code,
                response_excerpt=response.text[:500],
                exception_type=exc.__class__.__name__,
                exception_detail=str(exc)[:300],
                elapsed_ms=round((perf_counter() - started_at) * 1000),
            )
            log.exception("ollama_embedding_invalid_json", **context)
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Ollama returned an invalid embedding response.",
                internal_context=context,
            ) from exc

        embeddings = payload.get("embeddings") or payload.get("data")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            context.update(
                http_status=response.status_code,
                returned_embedding_count=len(embeddings) if isinstance(embeddings, list) else None,
                response_keys=sorted(payload.keys()) if isinstance(payload, dict) else None,
                elapsed_ms=round((perf_counter() - started_at) * 1000),
            )
            log.error("ollama_embedding_unexpected_response", **context)
            raise ServiceError(
                "INTERNAL_SERVER_ERROR",
                "Ollama returned an unexpected embedding response.",
                internal_context=context,
            )

        vectors: list[list[float]] = []
        for vector in embeddings:
            if not isinstance(vector, list) or len(vector) == 0:
                context.update(vector_dimension=len(vector) if isinstance(vector, list) else None)
                log.error("ollama_embedding_empty_vector", **context)
                raise ServiceError(
                    "INTERNAL_SERVER_ERROR",
                    "Ollama returned an empty embedding vector.",
                    internal_context=context,
                )
            if any(not isinstance(v, (int | float)) for v in vector):
                context.update(vector_dimension=len(vector))
                log.error("ollama_embedding_malformed_vector", **context)
                raise ServiceError(
                    "INTERNAL_SERVER_ERROR",
                    "Ollama returned a malformed embedding vector.",
                    internal_context=context,
                )
            vectors.append([float(v) for v in vector])

        log.info(
            "ollama_embedding_completed",
            **context,
            http_status=response.status_code,
            vector_dimension=len(vectors[0]),
            elapsed_ms=round((perf_counter() - started_at) * 1000),
        )
        return vectors

    async def dimension_probe(self) -> int:
        """Embed a probe string and return its vector dimension.

        Called at pipeline start and compared against the Qdrant collection's
        configured dimension. A mismatch is a fatal, explicit error.
        """
        vectors = await self.embed(["dimension probe"], prefix=DOCUMENT_PREFIX)
        return len(vectors[0])


def new_embedding_client(settings: Settings) -> OllamaEmbeddingClient:
    return OllamaEmbeddingClient(settings)
