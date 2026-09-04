"""FastAPI application for the document-processing and RAG service.

Phase 4: retrieval (exact + semantic), evidence-grounded RAG, citation
validation and refusal. Conversation memory, incident history and
maintenance intelligence remain out of scope.

This service is INTERNAL. It must never be reachable from a browser; only the
Express API calls it, over the internal Docker network.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import ConfigValidationError, get_settings, redact_uri
from app.core.errors import ServiceError, failure_envelope
from app.core.logging import configure_logging, get_logger
from app.core.middleware import RequestContextMiddleware, get_request_id
from app.routers import documents as documents_router
from app.routers import health as health_router
from app.routers import indexing as indexing_router
from app.routers import rag as rag_router
from app.routers import retrieval as retrieval_router

# --------------------------------------------------------------------------- #
# Configuration is validated at import time so a bad environment fails fast
# with one readable message.
# --------------------------------------------------------------------------- #
try:
    settings = get_settings()
except ConfigValidationError as exc:
    import sys

    print("\n RAG service configuration validation failed. Not starting.\n", file=sys.stderr)
    print(f"   {exc}\n", file=sys.stderr)
    raise SystemExit(1) from exc

configure_logging(level=settings.LOG_LEVEL, json_output=not settings.is_test)
log = get_logger()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Startup and shutdown.

    Storage directories are created eagerly so a permissions problem surfaces
    at boot rather than during the first upload in Phase 3.
    """
    storage_root = settings.storage_root_path
    for sub in ("manuals", "processed", "page-images", "temporary"):
        (storage_root / sub).mkdir(parents=True, exist_ok=True)

    log.info(
        "service_starting",
        phase="Phase 4 - Retrieval Engine and RAG Pipeline",
        environment=settings.PYTHON_ENV,
        api_prefix=settings.RAG_API_PREFIX,
        qdrant_url=settings.QDRANT_URL,
        ollama_url=settings.OLLAMA_BASE_URL,
        mongodb=redact_uri(settings.MONGODB_URI) if settings.MONGODB_URI else "not configured",
        storage_root=str(storage_root),
    )

    yield

    log.info("service_stopping")


app = FastAPI(
    title="ITP RAG Service",
    description=(
        "Internal document-processing and RAG service. "
        "Phase 4: retrieval, evidence-grounded generation, citation validation."
    ),
    version="0.1.0",
    lifespan=lifespan,
    # Docs are useful locally but are noise (and a small information leak) in
    # production.
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None,
    openapi_url=None if settings.is_production else "/openapi.json",
)

# --------------------------------------------------------------------------- #
# Middleware
# --------------------------------------------------------------------------- #
app.add_middleware(RequestContextMiddleware)

# CORS is OFF unless explicitly configured. This service is internal-only and
# the browser must never call it directly.
if settings.cors_origins:
    log.warning(
        "cors_enabled_on_internal_service",
        origins=settings.cors_origins,
        note="The RAG service is internal-only; enable CORS for local debugging only.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Request-Id", "X-Internal-Token"],
    )


# --------------------------------------------------------------------------- #
# Exception handlers - every error uses the shared envelope
# --------------------------------------------------------------------------- #


@app.exception_handler(ServiceError)
async def handle_service_error(request: Request, exc: ServiceError) -> JSONResponse:
    request_id = get_request_id(request)
    if exc.status_code >= 500:
        log.error("service_error", code=exc.code, message=exc.message, **exc.internal_context)
    else:
        log.warning("service_error", code=exc.code, message=exc.message)

    return JSONResponse(
        status_code=exc.status_code,
        content=failure_envelope(exc.code, exc.message, request_id, exc.details),
    )


@app.exception_handler(StarletteHTTPException)
async def handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Map Starlette's default HTTP errors onto the shared envelope."""
    code_by_status = {
        401: "UNAUTHENTICATED",
        403: "FORBIDDEN",
        404: "NOT_FOUND",
        405: "METHOD_NOT_ALLOWED",
        409: "CONFLICT",
        413: "PAYLOAD_TOO_LARGE",
        415: "UNSUPPORTED_MEDIA_TYPE",
        429: "RATE_LIMITED",
    }
    code = code_by_status.get(exc.status_code, "INTERNAL_SERVER_ERROR")

    message = (
        f"Route not found: {request.method} {request.url.path}"
        if exc.status_code == 404
        else str(exc.detail)
    )

    return JSONResponse(
        status_code=exc.status_code,
        content=failure_envelope(code, message, get_request_id(request)),
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    details = [
        {
            "field": ".".join(str(p) for p in err.get("loc", []) if p != "body") or "(body)",
            "issue": err.get("msg", "invalid value"),
        }
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=422,
        content=failure_envelope(
            "VALIDATION_ERROR", "Request validation failed.", get_request_id(request), details
        ),
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    """Last-resort handler.

    The real error is logged with a stack trace; the client receives a generic
    message so internal detail never leaks.
    """
    log.exception("unhandled_exception", error_type=exc.__class__.__name__)
    return JSONResponse(
        status_code=500,
        content=failure_envelope(
            "INTERNAL_SERVER_ERROR",
            "An unexpected error occurred.",
            get_request_id(request),
        ),
    )


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
app.include_router(health_router.router, prefix=settings.RAG_API_PREFIX)
app.include_router(documents_router.router, prefix=settings.RAG_API_PREFIX)
app.include_router(indexing_router.router, prefix=settings.RAG_API_PREFIX)
app.include_router(retrieval_router.router, prefix=settings.RAG_API_PREFIX)
app.include_router(rag_router.router, prefix=settings.RAG_API_PREFIX)


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, str]:
    """Unversioned liveness alias for container healthchecks."""
    return {"status": "ok"}
