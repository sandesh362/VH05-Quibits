"""Request correlation and access logging middleware."""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import get_logger, request_id_var

REQUEST_ID_HEADER = "x-request-id"

# Only echo a client-supplied id when it is safe to place in a header.
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,128}$")

# Health probes fire every few seconds; keep them at debug level.
_LOW_NOISE_SUFFIXES = ("/health", "/ready", "/healthz")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assign or propagate X-Request-Id and log request completion.

    Request bodies are never logged: later phases carry user questions and
    document content (docs/SECURITY_AND_RELIABILITY.md 15).
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get(REQUEST_ID_HEADER)
        request_id = (
            incoming if incoming and _SAFE_REQUEST_ID.match(incoming) else f"req_{uuid.uuid4()}"
        )

        token = request_id_var.set(request_id)
        request.state.request_id = request_id
        started = time.perf_counter()
        log = get_logger()

        try:
            response = await call_next(request)
        except Exception:
            duration_ms = int((time.perf_counter() - started) * 1000)
            log.exception(
                "request_failed",
                method=request.method,
                path=request.url.path,
                duration_ms=duration_ms,
            )
            request_id_var.reset(token)
            raise

        duration_ms = int((time.perf_counter() - started) * 1000)
        response.headers[REQUEST_ID_HEADER] = request_id

        payload = {
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "duration_ms": duration_ms,
        }

        if response.status_code >= 500:
            log.error("request_failed", **payload)
        elif response.status_code >= 400:
            log.warning("request_rejected", **payload)
        elif request.url.path.endswith(_LOW_NOISE_SUFFIXES):
            log.debug("request_completed", **payload)
        else:
            log.info("request_completed", **payload)

        request_id_var.reset(token)
        return response


def get_request_id(request: Request) -> str:
    """Read the correlation id for the current request."""
    return getattr(request.state, "request_id", "unknown")
