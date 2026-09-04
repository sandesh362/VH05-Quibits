# Authentication and Authorization — Phase 2

---

## 1. Authentication

### 1.1 Password storage

Argon2id via `@node-rs/argon2` (prebuilt binaries — no compiler toolchain needed), at **m=19456 KiB, t=2, p=1** — the OWASP second-choice profile, chosen so a laptop-class machine stays responsive while a GPU attacker does not.

The policy (`common/password.ts`): 10–200 characters, at least one letter and one non-letter, rejected against a common-password list, and rejected for excessive character repetition. Length carries most of the weight; complexity theatre mainly produces `Password1!`.

`verifyPassword()` returns `false` on a malformed hash rather than throwing, so a corrupt record is a failed login rather than a 500.

### 1.2 Tokens

**Access token** — HS256 JWT, 15 minutes, verified with `algorithms: ['HS256']` pinned (an unpinned verifier accepts `alg: none`). Issuer and audience are checked. The payload is minimal:

```json
{ "sub": "<userId>", "role": "technician", "tv": 0, "iat": ..., "exp": ..., "iss": "itp-api", "aud": "itp-web" }
```

No email, no name — a JWT is signed, not encrypted, and anyone holding it can read the payload.

**Refresh token** — 32 random bytes, base64url, opaque. Stored **hashed with SHA-256**; a database dump yields no usable session. SHA-256 rather than Argon2 is correct here: the token is already 256 bits of entropy, so there is nothing to brute-force. Capped at 5 per user.

### 1.3 Rotation and reuse detection

Every refresh issues a new token and marks the old one revoked, keeping the `family_id`. Presenting an already-revoked token means it leaked, so the **entire family is deleted and `token_version` is incremented** — every session for that user dies at once. The legitimate holder is logged out too; that is the correct outcome when a token is known to be compromised.

### 1.4 Revocation

A stateless JWT cannot normally be recalled. `token_version` solves this: the value is embedded as `tv` and compared against the database on **every** authenticated request. Incrementing it invalidates every outstanding access token immediately. It is bumped on password change, logout-all, and refresh-reuse detection.

`authenticate()` re-reads the user on every request and re-checks `is_deleted`, `is_active`, and `token_version`. That is one indexed lookup per request — a deliberate trade of a small cost for the ability to disable an account instantly.

### 1.5 No email enumeration

| Situation | Response |
|---|---|
| Unknown email | `401` "Invalid email or password." |
| Wrong password | `401` "Invalid email or password." (identical) |
| Inactive account | `403` "This account has been deactivated." |
| Locked account | `429` |

When the email is unknown the service still verifies against a **dummy Argon2 hash**, so timing does not distinguish the cases. The inactive check deliberately runs *after* password verification — checking it first would let anyone test which addresses have accounts.

### 1.6 Lockout and rate limiting

- **Lockout** — `AUTH_MAX_FAILED_LOGINS` (10) failures locks for `AUTH_LOCKOUT_MINUTES` (15). Successful login resets the counter.
- **Rate limit** — `AUTH_RATE_LIMIT_MAX` (20) per `AUTH_RATE_LIMIT_WINDOW_MINUTES` (15) on `/auth/login`, `/auth/register`, `/auth/refresh` only.

Both exist because they stop different attacks: lockout protects one account against targeted guessing; the rate limit protects the whole system against spraying many accounts. Neither is applied to general API traffic — with 1–5 local users that would only produce false positives during a demo.

### 1.7 Bootstrap

**No default credentials exist anywhere in this source tree.** Three paths, all requiring an operator to supply real values:

1. **First user** — the first account registered on an empty database becomes `admin`, audited as `first_user_bootstrap`.
2. **Environment** — `BOOTSTRAP_ADMIN_EMAIL` / `_USERNAME` / `_PASSWORD`, applied at startup only when `users` is empty. Config validation enforces all-or-nothing, a 12-character minimum, and rejects placeholders (`changeme`, `admin123`, `password`, …).
3. **`npm run create-admin`** — the same, on demand, with clear output.

The created account is flagged `must_change_password`. The password is never logged, echoed, or written to a file.

---

## 2. Authorization

### 2.1 Model

Capability-based RBAC. Routes declare a **capability**; a single frozen map (`common/policy.ts`) decides which roles hold it. There is no `if (role === 'admin')` anywhere in a handler.

**Deny by default.** A capability absent from a role's set is denied, and a route that declares no capability is unreachable rather than public.

Roles nest: `READ_ONLY ⊂ TECHNICIAN ⊂ MANAGER ⊂ ADMIN`.

### 2.2 Authorization matrix

| Capability | admin | manager | technician | viewer |
|---|:--:|:--:|:--:|:--:|
| `machine_model.read` | ✅ | ✅ | ✅ | ✅ |
| `machine_model.create` / `update` | ✅ | ✅ | ❌ | ❌ |
| `machine_model.delete` | ✅ | ❌ | ❌ | ❌ |
| `machine.read` | ✅ | ✅ | ✅ | ✅ |
| `machine.create` / `update` | ✅ | ✅ | ❌ | ❌ |
| `machine.delete` | ✅ | ❌ | ❌ | ❌ |
| `manual.read` | ✅ | ✅ | ✅ | ✅ |
| `manual.create` / `update` / `delete` | ✅ | ✅ | ❌ | ❌ |
| `incident.read` | ✅ | ✅ | ✅ | ✅ |
| `incident.create` | ✅ | ✅ | ✅ | ❌ |
| `incident.update_own` | ✅ | ✅ | ✅ | ❌ |
| `incident.update_any` | ✅ | ✅ | ❌ | ❌ |
| `incident.confirm_resolution` | ✅ | ✅ | ✅¹ | ❌ |
| `incident.reopen` | ✅ | ✅ | ❌ | ❌ |
| `incident_action.read` | ✅ | ✅ | ✅ | ✅ |
| `incident_action.create` | ✅ | ✅ | ✅ | ❌ |
| `maintenance.read` | ✅ | ✅ | ✅ | ✅ |
| `maintenance.create` | ✅ | ✅ | ✅ | ❌ |
| `maintenance.update_own` | ✅ | ✅ | ✅ | ❌ |
| `maintenance.update_any` | ✅ | ✅ | ❌ | ❌ |
| `conversation.create` / `read_own` / `update_own` | ✅ | ✅ | ✅ | ❌ |
| `conversation.read_any` | ✅ | ✅ | ❌ | ❌ |
| `user.read_self` / `update_self` | ✅ | ✅ | ✅ | ✅ |
| `user.read_all` | ✅ | ✅ | ❌ | ❌ |
| `user.create` / `update_role` | ✅ | ❌ | ❌ | ❌ |
| `audit_log.read` | ✅ | ✅ | ❌ | ❌ |

¹ Technicians hold the capability, but `canConfirmResolution()` additionally requires that the incident is one they reported or were assigned, and that `INCIDENT_CONFIRMATION_MODE=self`. In `supervisor` mode they are refused.

### 2.3 Ownership rules

A capability cannot express "your own record". Where that is needed, the middleware admits the request and the **service** makes the real decision:

| Rule | Enforced in |
|---|---|
| Technician may edit only incidents they reported, only while `open`/`in_progress` | `incidents.service.update` |
| Author may edit an incident action for 24 h; managers any time | `incident-actions.service.update` |
| Author may edit a maintenance record for 24 h; managers any time | `maintenance.service.update` |
| Conversations are visible only to their owner unless `read_any` | `conversations.service` |
| Technician may confirm only their own incident, in `self` mode | `incidents.service.confirmResolution` |

Denials return `403` with a consistent message. The one exception is conversations, which return **404** for another user's thread — a 403 would confirm that a conversation exists at that id.

### 2.4 Nobody escalates their own role

Four independent barriers:

1. `PATCH /users/me` accepts only `fullName` and `preferences`; the schema is `.strict()`, so `role` is a 422.
2. `POST /auth/register` ignores `role` unless the caller is an authenticated admin.
3. `user.update_role` is admin-only, and no endpoint currently exposes it.
4. `created_by` / `updated_by` / `performed_by` / `reported_by` always come from the verified token, never the body.

### 2.5 Enforced in the backend only

Every check runs in Express. The frontend may hide a button for a viewer, but the API refuses the request regardless — a hidden button is a usability affordance, not a security control.

---

## 3. Auth flow

```
Register ──► viewer (or admin if first user, or a chosen role if an admin created it)

Login ─────► verify Argon2id (dummy hash if user unknown — constant time)
             ├─ locked?    → 429
             ├─ bad pass?  → increment failures, maybe lock, → 401 (generic)
             ├─ inactive?  → 403  (checked AFTER verification)
             └─ ok         → access token (15 min) + refresh token (hashed, stored)

Request ───► Bearer token
             ├─ signature + iss/aud + expiry
             ├─ re-read user: is_deleted? is_active? token_version === tv?
             └─ authorize(capability) → 403 naming the capability

Refresh ───► look up by SHA-256 hash
             ├─ revoked?   → delete the family, bump token_version → 401
             ├─ expired?   → 401
             └─ ok         → rotate: revoke old, issue new in the same family

Logout ────► remove that refresh token, or (allDevices) clear all + bump token_version
```

---

## 4. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | — | Access token signing. ≥32 chars; placeholders rejected at boot |
| `JWT_REFRESH_SECRET` | — | Must differ from `JWT_SECRET` |
| `JWT_EXPIRES_IN` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token lifetime |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `itp-api` / `itp-web` | Verified on every token |
| `AUTH_MAX_FAILED_LOGINS` | `10` | Failures before lockout |
| `AUTH_LOCKOUT_MINUTES` | `15` | Lockout duration |
| `AUTH_RATE_LIMIT_MAX` | `20` | Requests per window on credential endpoints |
| `AUTH_RATE_LIMIT_WINDOW_MINUTES` | `15` | Window length |
| `INCIDENT_CONFIRMATION_MODE` | `self` | `self` \| `supervisor` |
| `BOOTSTRAP_ADMIN_EMAIL` / `_USERNAME` / `_PASSWORD` | unset | All three or none |

The process **refuses to start** on a weak, placeholder, or duplicated secret. A misconfigured secret should be a loud failure at boot, not a quiet weakness in production.
