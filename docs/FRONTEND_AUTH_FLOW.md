# FRONTEND_AUTH_FLOW.md

## Storage and tokens

- Access token, refresh token and the serialized current user are kept in
  **`sessionStorage`** — tab-scoped, never written to disk, cleared when the
  tab closes. No tokens appear in localStorage, cookies set by JS, URLs, or
  logs.
- The API client attaches `Authorization: Bearer <token>` via a getter
  registered by the auth provider.
- Logout always clears local session, and attempts `POST /auth/logout`
  (refresh-token rotation) when possible; network failure during logout never
  traps the user in a signed-in state.

## Session restoration (on load)

`AuthProvider` runs once on mount:

1. If a stored access token + user exist, it calls `GET /auth/me` to verify.
2. On success, the app renders with the stored user.
3. On a 401 (expired/blacklisted token), it tries **`POST /auth/refresh`**
   once with the stored refresh token.
4. If refresh also fails, the session is cleared and `expired` is set.
5. On a network error (backend down), the stored session is retained so the
   app's error states can retry instead of forcing a re-login.

## Route protection

- `<RequireAuth>` — renders the full-screen restore state until `ready`,
  redirects to `/login` (preserving `state.from`) when unauthenticated.
- `<RequireCapability capability="…">` — for role-gated routes; authenticated
  users lacking the capability are sent to `/forbidden`.
- Navigation entries in the sidebar are filtered with the **same capability
  map** (`lib/permissions.ts`) that mirrors `backend/src/common/policy.ts`.
  This is convenience only — the Express policy remains authoritative and a
  403 is still handled.

## Capability summary (mirrors backend)

- **viewer**: read everything; no create/update.
- **technician**: create incidents, conversations, technician actions,
  maintenance (own); record root-cause suggestions and fixes; update own
  records and conversations.
- **manager**: technician abilities + machine/model CRUD (no deletes),
  manual upload/reprocess/delete, incident assignment, root-cause
  confirm/reject, fix and action confirmation, close/reopen, user list,
  audit-read.
- **admin**: manager abilities + structural deletes (machines, models,
  incidents) + user creation with roles.

## Login page behaviour

- Client validation (required fields, email shape) with inline errors.
- Password show/hide toggle (accessible `aria-pressed`).
- Generic, safe error message on wrong credentials
  ("Sign-in failed. Check your email and password."); specific messaging for
  rate limiting and network failure.
- Expired-session banner when redirected from a 401 elsewhere.
- Submit is disabled while pending; double-submit prevented by the loading
  state.

## Settings

- `PATCH /users/me` updates the display name and immediately updates the
  auth context (no re-login).
- `POST /auth/change-password` requires the current password; validation
  enforces ≥12 characters and matching confirmation; errors map inline.
