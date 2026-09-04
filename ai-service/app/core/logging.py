"""Structured logging (structlog) with request-id binding.

Log records carry: timestamp, level, service name, request id, event.
Never logged: secrets, tokens, document content, full user messages.
See docs/SECURITY_AND_RELIABILITY.md 15.
"""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from typing import Any

import structlog

# Request id for the in-flight request, set by the correlation middleware.
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

# Keys scrubbed from every log record.
SENSITIVE_KEYS: frozenset[str] = frozenset(
    {
        "password",
        "password_hash",
        "token",
        "access_token",
        "refresh_token",
        "authorization",
        "api_key",
        "apikey",
        "secret",
        "internal_service_token",
        "jwt_secret",
        "qdrant_api_key",
        "mongo_root_password",
        "cookie",
        "set-cookie",
    }
)


def _redact_sensitive(
    _logger: Any, _method: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    """Replace sensitive values with [REDACTED] before they reach a sink."""
    for key in list(event_dict.keys()):
        if key.lower() in SENSITIVE_KEYS:
            event_dict[key] = "[REDACTED]"
    return event_dict


def _add_request_id(
    _logger: Any, _method: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    """Attach the current request id to every record."""
    event_dict.setdefault("request_id", request_id_var.get())
    return event_dict


def configure_logging(level: str = "INFO", *, json_output: bool = True) -> None:
    """Configure structlog and route stdlib logging through it."""
    numeric_level = getattr(logging, level.upper(), logging.INFO)

    # Windows PowerShell/cmd may expose stdout as a legacy code page (for
    # example cp1252). Ollama error bodies and PDF metadata are valid Unicode;
    # logging either must handle them or it can mask the original processing
    # failure with a ``charmap codec can't encode`` exception.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="backslashreplace")

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=numeric_level,
        force=True,
    )

    # Uvicorn has its own handlers; let structlog own the formatting.
    for noisy in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(noisy).handlers.clear()
        logging.getLogger(noisy).propagate = True

    # pymongo emits a topology/heartbeat event every ~500 ms per server. When
    # MongoDB is unreachable that is several lines per second of pure noise
    # that buries real log entries. The dependency probe already reports the
    # connection state accurately, so raise pymongo's floor to WARNING.
    for chatty in (
        "pymongo",
        "pymongo.topology",
        "pymongo.serverSelection",
        "pymongo.heartbeat",
        "pymongo.connection",
        "pymongo.command",
    ):
        logging.getLogger(chatty).setLevel(logging.WARNING)

    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        _add_request_id,
        _redact_sensitive,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    processors.append(
        structlog.processors.JSONRenderer()
        if json_output
        else structlog.dev.ConsoleRenderer(colors=True)
    )

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(numeric_level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "rag-service") -> structlog.stdlib.BoundLogger:
    """Return a bound logger tagged with the service name."""
    return structlog.get_logger(name).bind(service="rag-service")
