"""Internal-service authentication.

Express is the only caller. Every FastAPI business route requires the shared
`X-Internal-Token`. The token is compared in constant-ish time against the
configured secret; a miss is a 401, never a 403 (the caller is unauthenticated,
not under-privileged).
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException

from app.core.config import get_settings


def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    """Reject any caller that does not present the shared internal token."""
    expected = get_settings().INTERNAL_SERVICE_TOKEN
    provided = x_internal_token or ""
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Missing or invalid internal token.")
