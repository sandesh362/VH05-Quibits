"""Ollama embedding client.

Embeddings are the ONLY Ollama capability authorised in Phase 3. The chat model
is never used here. This module centralises the model name, the document/query
prefix convention, and the sanity checks (reachable, model present, non-empty
vector, correct dimension) so the indexing path cannot drift from the query path.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core.config import Settings
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

    async def ping(self, model: str | None = None) -> dict[str, Any]:
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
        wanted = model or self.settings.embedding_model

        def present(name: str) -> bool:
            base = name.split(":")[0]
            return any(n == name or n.split(":")[0] == base for n in installed)

        if not present(wanted):
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                f"Embedding model '{wanted}' is not pulled. Run: ollama pull {wanted}",
            )

        return {"model": wanted, "installed": installed}

    async def embed(
        self,
        texts: list[str],
        prefix: str = DOCUMENT_PREFIX,
        model: str | None = None,
    ) -> list[list[float]]:
        """Embed a batch of texts with the given prefix.

        Validates: a non-empty response, one vector per input, and a non-empty
        vector. Dimension consistency is enforced by the caller via Qdrant.
        Raises ServiceError on any anomaly.
        """
        if not texts:
            return []

        prefixed = [f"{prefix}{t}" for t in texts]
        selected_model = model or self.settings.embedding_model
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/api/embed",
                    json={"model": selected_model, "input": prefixed},
                )
        except Exception as exc:  # noqa: BLE001
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Ollama embedding request failed.",
                internal_context={"detail": str(exc)},
            ) from exc

        if response.status_code >= 400:
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                f"Ollama embedding failed (HTTP {response.status_code}).",
                internal_context={"status": response.status_code},
            )

        payload = response.json()
        embeddings = payload.get("embeddings") or payload.get("data")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise ServiceError(
                "INTERNAL_SERVER_ERROR",
                "Ollama returned an unexpected embedding response.",
                internal_context={
                    "count": len(embeddings) if isinstance(embeddings, list) else None
                },
            )

        vectors: list[list[float]] = []
        for vector in embeddings:
            if not isinstance(vector, list) or len(vector) == 0:
                raise ServiceError(
                    "INTERNAL_SERVER_ERROR",
                    "Ollama returned an empty embedding vector.",
                )
            if any(not isinstance(v, (int | float)) for v in vector):
                raise ServiceError(
                    "INTERNAL_SERVER_ERROR",
                    "Ollama returned a malformed embedding vector.",
                )
            vectors.append([float(v) for v in vector])

        return vectors

    async def dimension_probe(self, model: str | None = None) -> int:
        """Embed a probe string and return its vector dimension.

        Called at pipeline start and compared against the Qdrant collection's
        configured dimension. A mismatch is a fatal, explicit error.
        """
        vectors = await self.embed(["dimension probe"], prefix=DOCUMENT_PREFIX, model=model)
        return len(vectors[0])


def new_embedding_client(settings: Settings) -> OllamaEmbeddingClient:
    return OllamaEmbeddingClient(settings)
