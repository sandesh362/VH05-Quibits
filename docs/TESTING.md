# Testing — Phase 2

**149 backend tests, all passing.** 42 carried from Phase 1, 107 added in Phase 2.

---

## 1. Running the tests

```bash
npm run test --workspace @itp/backend    # 149 backend tests
npm run test                             # all workspaces (backend + ai-service + frontend)
npm run typecheck                        # all four workspaces
```

Individual files:

```bash
cd backend
npx vitest run tests/auth.test.ts
npx vitest run tests/crud.test.ts
npx vitest watch                         # watch mode
npm run test:coverage
```

---

## 2. How the tests are isolated

Integration tests run against a **real `mongod`**, started in-process by `mongodb-memory-server` and backed by a temp directory that is destroyed afterwards.

A mock would not exercise the behaviour most likely to break: unique index enforcement, case-insensitive collation, partial filter expressions, and duplicate-key errors. Indeed the first run against a real server caught an index definition MongoDB rejects outright (`sparse` combined with `partialFilterExpression`) — a defect that would otherwise have surfaced only on a developer's first startup.

Safety:

- `tests/setup.ts` points `MONGODB_URI` at **port 1**, an unroutable address. If a test ever missed the in-memory override it would fail to connect rather than silently reaching a real database.
- `setDbForTests()` throws unless `NODE_ENV === 'test'`.
- `clearTestDb()` empties collections between tests with `deleteMany` rather than dropping the database, so the production index set stays in place and duplicate-key assertions test the real constraint.
- **No production data is touched, and no fixture data ships with the application.**

---

## 3. Coverage by area

| File | Tests | Area |
|---|--:|---|
| `tests/config.test.ts` | 16 | Configuration validation (Phase 1) |
| `tests/api.test.ts` | 26 | Health, readiness, system info, envelopes (Phase 1) |
| `tests/auth.test.ts` | 34 | Registration, login, tokens, refresh, logout, password change |
| `tests/authorization.test.ts` | 14 | RBAC matrix, ownership, unauthenticated access |
| `tests/crud.test.ts` | 33 | All five CRUD modules, business rules, resolution flow |
| `tests/general.test.ts` | 26 | Envelopes, pagination, injection, body limits, audit, DB failure |
| **Total** | **149** | |

### Authentication (34)

First-user-becomes-admin; self-registration forced to `viewer` even when `role: "admin"` is requested; admin-assigned roles; hash never serialised; Argon2id actually stored; weak passwords rejected; duplicate registration generic; case-insensitive email collision; unknown fields rejected; **identical response for unknown email vs wrong password**; submitted password never echoed; inactive → 403; lockout after 10 failures; audit entries for success and failure; `/auth/me` with missing, malformed, wrong-secret, and post-deactivation tokens; refresh rotation; **family revocation on replay**; refresh tokens stored hashed; logout single and all-devices; password change invalidating sessions; `PATCH /users/me` refusing `role` and `isActive`.

### Authorization (14)

Every role against read and write on machine models; admin-only deletion; technician create vs viewer denial; technician blocked from editing another's incident; manager editing any; reopen restricted to manager/admin; viewer refused across every write endpoint while retaining every read; all protected endpoints refusing anonymous access; health and system info remaining public; conversation ownership including the 404-not-403 rule and list scoping.

### CRUD and business rules (33)

Full lifecycle on machine models; case-insensitive duplicate rejection; **deletion refused while machines reference the model, with dependents named**; unknown enum rejected; machine referencing a missing model; malformed ObjectId as 422 rather than 500; asset tag uppercased; duplicate asset tag; **asset tag immutable**; model change requiring a reason; **machine deletion refused when incident history exists, advising retirement**; manual created `queued` and not searchable; storage path never exposed; **`processingStatus: "ready"` refused**; path traversal in filename rejected; malformed checksum rejected; scope exclusivity; maintenance updating `last_maintenance_at`; future date refused; part-number normalisation on write and query; incident number format and uniqueness across five creations; **`PATCH status: "resolved"` refused**; confirmation without an action refused; **confirmation with a `no_change` action refused**; successful confirmation; double confirmation as 409; action sequence numbering; auto-transition to `in_progress`; `needsLinking` when only a model is given; conversation `scope_source`; **501 on message send**; empty message list.

### Cross-cutting (26)

Success and failure envelopes with matching request ids; caller-supplied request id echoed; structured 404 for unknown routes; no stack or path in errors; default page size with accurate totals; second page; **`limit=5000` rejected**; zero, negative, and non-numeric pages; non-allowlisted sort ignored; allowlisted sort honoured; unknown query parameter rejected; `$ne` in a login body; `$where` nested in a create; **raw-JSON `__proto__`**; regex metacharacters treated literally; oversized body; over-long array; audit entries for create, delete-with-reason, and field-level update changes; **no password or token in any audit entry**; no endpoint for altering the audit trail; **clean 503 when the database disappears**; liveness staying up while it is down.

---

## 4. Manual verification

The sequence below was executed against a real `mongod` during Phase 2 and can be repeated.

```bash
# 1. Start MongoDB (Docker, if available)
docker compose up -d mongo

# 2. Create an administrator — no default credentials exist
#    Set these in .env first:
#      BOOTSTRAP_ADMIN_EMAIL=admin@example.test
#      BOOTSTRAP_ADMIN_USERNAME=bootadmin
#      BOOTSTRAP_ADMIN_PASSWORD=<a strong password, 12+ chars>
npm run create-admin

# 3. Start the API
npm run dev:backend
```

Expected startup log: `Database indexes ensured { collections: 11, indexesCreated: 51 }`, then the bootstrap-admin warning **with no password in it**.

```bash
B=http://localhost:8080/api/v1

# 4. Sign in
TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.test","password":"<your password>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')

# 5. No email enumeration — both must return the identical body
curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.test","password":"wrongpassword1"}'
curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ghost@example.test","password":"wrongpassword1"}'

# 6. Unauthenticated access → 401
curl -s $B/machines

# 7. Create a model and a machine
MID=$(curl -s -X POST $B/machine-models -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"manufacturer":"Haas","modelName":"VF-2SS","machineType":"cnc_mill"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["machineModel"]["id"])')

curl -s -X POST $B/machines -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"assetTag\":\"cnc-042\",\"machineModelId\":\"$MID\"}"     # note: tag returns uppercased

# 8. Referential integrity → 409 naming the dependents
curl -s -X DELETE $B/machine-models/$MID -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"reason":"cleanup"}'

# 9. The resolution gate — each of these must be refused
#    (create an incident first, then:)
#    a. PATCH {"status":"resolved"}                    → 422, points at confirm-resolution
#    b. confirm without effectiveActionId              → 422
#    c. confirm nominating an action with outcome      → 422, quotes the actual outcome
#       other than "worked"
#    d. confirm with a "worked" action + root cause    → 200, resolutionConfirmed: true

# 10. No fake AI
curl -s -X POST $B/conversations/<id>/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"why is it hot?"}'   # → 501

# 11. Feature flags tell the truth
curl -s $B/system/info    # authentication: true, every AI flag false
```

### Verifying production error hygiene

```bash
NODE_ENV=production npm run start --workspace @itp/backend
```

Then trigger a 404, a 422, and the 501 above: no response may contain a stack trace, a `/home/...` path, or a `node_modules` reference.

---

## 5. What is not tested

Stated plainly rather than implied by absence:

- **No load or performance testing.** Index choices are reasoned from query shape, not measured.
- **No concurrency testing.** Sequence allocation is atomic by construction (`findOneAndUpdate` + `$inc`) and uniqueness is enforced by indexes, but no test runs parallel writers.
- **No frontend integration test against the live API.** The frontend suite (15 tests) mocks its client.
- **No Docker-level test.** The sandbox has no Docker; compose is syntax-checked only.
- **Token expiry is not tested against wall-clock time.** Revocation is tested via `token_version`; a genuine 15-minute expiry test would require clock manipulation.
- **Coverage percentage is not enforced.** There is no minimum threshold gate.
