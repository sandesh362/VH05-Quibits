"""Build a RagRuntimeConfig from the process Settings."""

from __future__ import annotations

from app.core.config import Settings
from app.rag.types import RagRuntimeConfig, RankingWeights

PROMPT_VERSION = "rag-p7-v1"

# nomic-embed-text produces 768-d vectors. Used as a sanity default when a
# live probe is unavailable; the query path still asserts against the actual
# vector and the Qdrant collection.
NOMIC_EMBED_DIMENSION = 768


def rag_config_from_settings(settings: Settings) -> RagRuntimeConfig:
    weights = RankingWeights(
        exact_match=settings.RAG_WEIGHT_EXACT_MATCH,
        technical_term=settings.RAG_WEIGHT_TECHNICAL_TERM,
        machine_scope=settings.RAG_WEIGHT_MACHINE_SCOPE,
        manual_scope=settings.RAG_WEIGHT_MANUAL_SCOPE,
        semantic=settings.RAG_WEIGHT_SEMANTIC,
        section=settings.RAG_WEIGHT_SECTION,
        duplicate_penalty=settings.RAG_DUPLICATE_PENALTY,
    )
    expected_dim = (
        settings.RAG_EXPECTED_EMBEDDING_DIMENSION
        if settings.RAG_EXPECTED_EMBEDDING_DIMENSION > 0
        else NOMIC_EMBED_DIMENSION
    )
    return RagRuntimeConfig(
        top_k=settings.RAG_TOP_K,
        min_context_chunks=settings.RAG_MIN_CONTEXT_CHUNKS,
        min_semantic_score=settings.RAG_MIN_SEMANTIC_SCORE,
        min_final_score=settings.RAG_MIN_FINAL_SCORE,
        require_source_metadata=settings.RAG_REQUIRE_SOURCE_METADATA,
        allow_unsupported_answer=settings.RAG_ALLOW_UNSUPPORTED_ANSWER,
        max_context_chars=settings.RAG_MAX_CONTEXT_CHARS,
        max_prompt_chars=settings.RAG_MAX_PROMPT_CHARS,
        temperature=settings.RAG_TEMPERATURE,
        max_output_tokens=settings.RAG_MAX_OUTPUT_TOKENS,
        request_timeout_ms=settings.RAG_REQUEST_TIMEOUT_MS,
        candidate_limit=settings.RAG_CANDIDATE_LIMIT,
        near_duplicate_threshold=settings.RAG_NEAR_DUPLICATE_THRESHOLD,
        weights=weights,
        log_query_text=settings.RAG_LOG_QUERY_TEXT,
        chat_model=settings.OLLAMA_CHAT_MODEL or "llama3.1",
        embedding_model=settings.OLLAMA_EMBEDDING_MODEL,
        expected_embedding_dimension=expected_dim,
        prompt_version=PROMPT_VERSION,
    )
