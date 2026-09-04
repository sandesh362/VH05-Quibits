# Security Notes — Phase 2

> **This system is not production-secure and must not be exposed to the internet.**
> It is a hackathon build designed to run on a local network. This document records what *is* implemented and, just as importantly, what is not.

---

## 1. Implemented

### 1.1 Credentials

- Argon2id (m=19456, t=2, p=1). No plaintext, no reversible encoding, no MD5/SHA for passwords.
- Password policy: 10–200 chars, letter + non-letter, common-password rejection, repetition check.
- Refresh tokens stored as SHA-256 hashes; a database dump yields no usable session.
- `USER_PUBLIC_PROJECTION` strips `password_hash`, `refresh_tokens`, `failed_login_count`, `locked_until`. The `PublicUser` type has no field for a hash, so leaking one requires deliberately writing new code.
- **Tested:** no response, log line, or audit entry contains a password or an `$argon2` string.

### 1.2 Secrets

- Every secret comes from the environment. No credential is committed.
- Startup **fails** on a `JWT_SECRET` under 32 characters, on a recognised placeholder, or when `JWT_REFRESH_SECRET === JWT_SECRET`.
- Bootstrap admin credentials must be supplied by the operator; the password is never logged or echoed.
- Logging redacts tokens, passwords, and credentialed URIs; connection strings are printed via `redactUri()`.

### 1.3 Query safety

- `assertNoOperators()` rejects any `$`-prefixed key, dotted key, or `__proto__` / `constructor` / `prototype` in a request body, blocking NoSQL operator injection and prototype pollution before a query is built.
- Every schema is `.strict()`: unknown fields are errors, which blocks mass assignment.
- Sort fields come from a per-module allowlist, so a caller cannot sort by an unindexed field (a cheap table scan) or probe the schema through timing.
- Search terms are escaped with `escapeRegex()` before becoming a `RegExp`, so a submitted `.*` is a literal, not a wildcard, and a catastrophic-backtracking pattern cannot be injected.
- All ids are validated as ObjectIds before use.
- **Tested:** `{"email": {"$ne": null}}` on login, `$where` in a nested object, raw-JSON `__proto__`, and regex metacharacters in search.

### 1.4 Transport and headers

- `helmet()` for security headers; `x-powered-by` disabled.
- CORS is a strict allowlist from `CORS_ORIGIN`; requests without an `Origin` (curl, server-to-server) are permitted.
- `trust proxy` set to exactly one hop, matching the nginx/Vite deployment.
- Body size capped by `REQUEST_BODY_LIMIT`; array and string lengths bounded per field.

### 1.5 Error handling

- One envelope for every failure; clients branch on `code`, never on message text.
- **Stack traces are attached only when `NODE_ENV !== 'production'`.** Verified by booting in production mode and inspecting 404, 422, and 501 responses.
- No filesystem path, hostname, port, or driver message reaches a client. `storage_path` is never serialised.
- Duplicate-key errors are translated to 409 with a field name, not a raw driver dump.

### 1.6 Audit trail

Every state-changing operation writes an append-only entry: actor (snapshotted id, username, role), action, entity, outcome, severity, request id, allowlisted field changes (200-char truncation), and a reason where required.

There is **no API to modify or delete audit entries**. Audit writes never throw — a failed write is logged but does not fail the user's operation, because losing a machine repair record to a logging fault would be worse.

### 1.7 Abuse resistance

- Account lockout after repeated failures; rate limiting on credential endpoints.
- Refresh-token reuse detection revokes the whole family.
- Pagination is capped at 100 per page, and an over-limit request is rejected rather than clamped.

---

## 2. Not implemented — known limitations

| Gap | Impact | Why deferred |
|---|---|---|
| **No HTTPS** | Tokens and passwords travel in clear text | Local-network deployment; terminating TLS needs certificates that a hackathon environment cannot provision meaningfully |
| **In-memory rate limiting** | Resets on restart; ineffective across multiple nodes | Single-node deployment. A shared store would mean adding Redis, which the constraints exclude without strong justification |
| **No CSRF protection** | — | Tokens are sent via the `Authorization` header, not cookies, so classic CSRF does not apply. Adding cookie auth later would require CSRF tokens |
| **No account recovery** | A locked-out sole admin needs database access | Password reset needs email, which is out of scope |
| **No MFA** | Single-factor only | Out of scope |
| **No JSON-Schema validators on collections** | A direct database write bypasses all validation | Phase 0 specifies `validationLevel: "moderate"` as defence in depth; zod covers the API path |
| **No per-user API rate limit** | An authenticated user can hammer any endpoint | 1–5 trusted local users |
| **MongoDB has no authentication** | Anyone on the host can read everything | Matches the local compose setup; enabling auth is a deployment change |
| **No secret rotation** | Rotating `JWT_SECRET` invalidates all sessions | Acceptable for the target deployment |
| **No user-administration endpoints** | Role changes require a direct database edit | Deferred; the largest functional gap |
| **No audit-log read API** | Entries are only visible in the database | Deferred |
| **Counters are eventually consistent** | `machine_count`, `open_incident_count` may drift after a crash | Single-node MongoDB has no transactions; these are display-only and never used as filters |

---

## 3. Deliberate design decisions

**Inactive-account check runs after password verification.** Reversing the order would be marginally faster but would turn the endpoint into an account-existence oracle.

**Another user's conversation returns 404, not 403.** A 403 confirms the resource exists.

**Duplicate registration returns a generic message.** Naming whether the email or the username collided would confirm which account exists.

**Login failures are constant-time.** Unknown emails are verified against a dummy hash so response timing does not distinguish them.

**Incident actions cannot be deleted.** Not a limitation — an append-only work log is the point. Corrections append, or edit within 24 hours with the prior text preserved.

**Manual processing state is rejected, not ignored.** An operator who tries to mark a manual `ready` is told why, rather than having the field silently dropped.

---

## 4. Before any real deployment

1. Terminate TLS in front of the API and set `NODE_ENV=production`.
2. Enable MongoDB authentication and bind it to localhost.
3. Move rate limiting to a shared store if running more than one node.
4. Add the JSON-Schema collection validators.
5. Rotate every secret; ensure `.env` is not readable by other users.
6. Add user-administration endpoints so role changes do not require database access.
7. Have someone other than the authors review the authorization matrix against the deployed roles.
