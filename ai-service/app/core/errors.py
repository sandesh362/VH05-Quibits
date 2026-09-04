"""Typed service errors and the shared response envelope.

The RAG service uses the SAME envelope as the Express API so that a failure
looks identical wherever it originates. Internal detail never reaches a client
in production.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

# Mirrors ApiErrorCode in packages/shared/src/index.ts. Keep in sync.
ErrorCode = Literal[
    "VALIDATION_ERROR",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "CONFLICT",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "RATE_LIMITED",
    "INTERNAL_SERVER_ERROR",
    "SERVICE_UNAVAILABLE",
    "DEPENDENCY_UNAVAILABLE",
    "NOT_IMPLEMENTED",
]

ERROR_STATUS_MAP: dict[str, int] = {
    "VALIDATION_ERROR": 422,
    "UNAUTHENTICATED": 401,
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "METHOD_NOT_ALLOWED": 405,
    "CONFLICT": 409,
    "PAYLOAD_TOO_LARGE": 413,
    "UNSUPPORTED_MEDIA_TYPE": 415,
    "RATE_LIMITED": 429,
    "INTERNAL_SERVER_ERROR": 500,
    "SERVICE_UNAVAILABLE": 503,
    "DEPENDENCY_UNAVAILABLE": 503,
    "NOT_IMPLEMENTED": 501,
}


class ServiceError(Exception):
    """Application error carrying a stable, machine-readable code."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        status_code: int | None = None,
        details: list[dict[str, str]] | None = None,
        internal_context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code or ERROR_STATUS_MAP.get(code, 500)
        self.details = details
        # Logged, never serialised into a response.
        self.internal_context = internal_context or {}

    @classmethod
    def not_found(cls, message: str = "The requested resource was not found.") -> ServiceError:
        return cls("NOT_FOUND", message)

    @classmethod
    def not_implemented(cls, feature: str) -> ServiceError:
        return cls("NOT_IMPLEMENTED", f"{feature} is not implemented yet.")

    @classmethod
    def unauthenticated(cls, message: str = "Missing or invalid internal token.") -> ServiceError:
        return cls("UNAUTHENTICATED", message)


# --------------------------------------------------------------------------- #
# Response models
# --------------------------------------------------------------------------- #


class ErrorDetail(BaseModel):
    field: str
    issue: str


class ErrorBody(BaseModel):
    code: str
    message: str
    requestId: str  # noqa: N815 - wire format matches the TypeScript contract
    details: list[ErrorDetail] | None = None


class ErrorResponse(BaseModel):
    """Failure envelope - identical in shape to the Express API."""

    success: Literal[False] = False
    error: ErrorBody


class ResponseMeta(BaseModel):
    requestId: str  # noqa: N815
    timestamp: str


class SuccessResponse(BaseModel):
    """Success envelope - identical in shape to the Express API."""

    success: Literal[True] = True
    data: Any
    meta: ResponseMeta


def success_envelope(data: Any, request_id: str) -> dict[str, Any]:
    """Build the success envelope as a plain dict."""
    return {
        "success": True,
        "data": data,
        "meta": {
            "requestId": request_id,
            "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        },
    }


def failure_envelope(
    code: str,
    message: str,
    request_id: str,
    details: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Build the failure envelope as a plain dict."""
    error: dict[str, Any] = {"code": code, "message": message, "requestId": request_id}
    if details:
        error["details"] = details
    return {"success": False, "error": error}


class DependencyCheckModel(BaseModel):
    """One dependency probe result. Mirrors DependencyCheck in @itp/shared."""

    name: str
    status: Literal["ok", "degraded", "down", "disabled", "unknown"]
    latencyMs: int | None = None  # noqa: N815
    detail: str | None = None
    error: str | None = None
    required: bool
    impact: str | None = None


class HealthPayload(BaseModel):
    status: Literal["ok"] = "ok"
    service: str
    version: str
    environment: str
    uptimeSeconds: int  # noqa: N815
    timestamp: str


class ReadinessPayload(BaseModel):
    status: Literal["ok", "degraded", "down"]
    service: str
    ready: bool
    checks: list[DependencyCheckModel]
    degradedCapabilities: list[str] = Field(default_factory=list)  # noqa: N815
    durationMs: int  # noqa: N815
    timestamp: str


class SystemInfoPayload(BaseModel):
    service: str
    version: str
    environment: str
    apiPrefix: str  # noqa: N815
    pythonVersion: str  # noqa: N815
    platform: str
    phase: str
    startedAt: str  # noqa: N815
    uptimeSeconds: int  # noqa: N815
    features: dict[str, bool]
    configuredDependencies: list[str]  # noqa: N815
