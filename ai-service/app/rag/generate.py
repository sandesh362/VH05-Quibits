"""Ollama chat generation for RAG answers.

Low temperature, JSON-shaped output, no model auto-download. Failures become
structured statuses, never speculative prose.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.clients.ollama import OllamaEmbeddingClient
from app.core.config import Settings
from app.core.errors import ServiceError
from app.core.logging import get_logger
from app.rag.citations import parse_model_json

log = get_logger()


def _answer_schema(allowed_source_ids: list[str]) -> dict[str, Any]:
    """Constrain Ollama to the answer contract and retrieved source IDs only."""
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "likely_causes": {"type": "array", "items": {"type": "string"}},
            "recommended_checks": {"type": "array", "items": {"type": "string"}},
            "safety_notes": {"type": "array", "items": {"type": "string"}},
            "when_to_escalate": {"type": "string"},
            "cited_source_ids": {
                "type": "array",
                "items": {"type": "string", "enum": allowed_source_ids},
            },
            "evidence_insufficient": {"type": "boolean"},
            "notes_on_conflicts": {"type": "string"},
        },
        "required": [
            "summary", "likely_causes", "recommended_checks", "safety_notes",
            "when_to_escalate", "cited_source_ids", "evidence_insufficient",
            "notes_on_conflicts",
        ],
        "additionalProperties": False,
    }


class OllamaChatClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.base_url = settings.OLLAMA_BASE_URL
        self.embed = OllamaEmbeddingClient(settings)

    async def ensure_chat_model(self, model: str) -> None:
        if not model:
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "No chat model is configured. Set OLLAMA_CHAT_MODEL and pull it with ollama pull.",
            )
        try:
            async with httpx.AsyncClient(timeout=self.settings.ollama_timeout_seconds) as client:
                response = await client.get(f"{self.base_url}/api/tags")
        except Exception as exc:  # noqa: BLE001
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

        def present(name: str) -> bool:
            base = name.split(":")[0]
            return any(n == name or n.split(":")[0] == base for n in installed)

        if not present(model):
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                f"Chat model '{model}' is not pulled. Run: ollama pull {model}",
            )

    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int,
        timeout_s: float,
        model: str | None = None,
        allowed_source_ids: list[str] | None = None,
    ) -> str:
        chat_model = model or self.settings.OLLAMA_CHAT_MODEL
        if not chat_model:
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "No chat model is configured. Set OLLAMA_CHAT_MODEL.",
            )
        payload: dict[str, Any] = {
            "model": chat_model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }
        if allowed_source_ids:
            payload["format"] = _answer_schema(allowed_source_ids)
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
        except httpx.TimeoutException as exc:
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Ollama generation timed out.",
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                "Ollama generation request failed.",
                internal_context={"detail": str(exc)[:200]},
            ) from exc

        if response.status_code >= 400:
            raise ServiceError(
                "SERVICE_UNAVAILABLE",
                f"Ollama generation failed (HTTP {response.status_code}).",
            )

        body = response.json()
        message = body.get("message") or {}
        content = message.get("content") if isinstance(message, dict) else None
        if not content:
            content = body.get("response")
        if not isinstance(content, str) or not content.strip():
            raise ServiceError(
                "INTERNAL_SERVER_ERROR",
                "Ollama returned an empty generation.",
            )
        return content


class ScriptedGenerator:
    """Test double that returns queued responses."""

    def __init__(self, outputs: list[str] | None = None, error: Exception | None = None) -> None:
        self.outputs = list(outputs or [])
        self.error = error
        self.calls: list[list[dict[str, str]]] = []

    async def ensure_chat_model(self, model: str) -> None:
        if self.error:
            raise self.error

    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int,
        timeout_s: float,
        model: str | None = None,
        allowed_source_ids: list[str] | None = None,
    ) -> str:
        self.calls.append(messages)
        if self.error:
            raise self.error
        if not self.outputs:
            return ""
        return self.outputs.pop(0)


def require_parsed_json(raw: str) -> dict[str, Any]:
    parsed = parse_model_json(raw)
    if parsed is None:
        raise ServiceError("INTERNAL_SERVER_ERROR", "Model output was not valid JSON.")
    return parsed
