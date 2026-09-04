# Organizations (Phase 6)

The single-tenant deployment is scoped by organization end to end so the
isolation boundary exists in the data model and in every query from day one.

---

## 1. Model

- `OrganizationDoc`: `name`, `slug`, `is_active`.
- `UserDoc.organization_id`: set for users created after Phase 6; **legacy
  rows without it resolve to the default organization**.
- The default organization (`slug: 'default'`, "Default Organization") is
  seeded by `prepareDatabase` (and by the test harness) — the data-layer
  guarantee, not an optional feature.

## 2. Resolution (`organizations.service.ts`)

`resolveActorOrg(db, userId, username, role)`:

1. reads the user document (projection: `organization_id`),
2. uses its org id, or falls back to the org with slug `default`,
3. throws `ApiError.internal` if the default org is missing (unreachable in
   a prepared database).

`OrgActor` = `{ orgId, orgSlug, userId, username, role }` — the actor object
every incident/action/RAG service call builds **server-side**.
Organization identity is never accepted from a request body, query string,
or JWT claim.

## 3. Where the org boundary is enforced

| Surface | Enforcement |
|---|---|
| Incident/action reads | `organization_id` in every filter (liveFilter) |
| Incident/action writes | org from `resolveActorOrg` |
| Assignment | target user must exist, be active, and share the actor's org (`422` otherwise) |
| Similar-incident retrieval | hard org filter on the Qdrant query **and** the Mongo fallback |
| RAG answers/search | Express sends `organization_id` in the internal payload; the pipeline scopes history retrieval to it |
| Historical evidence | history hits are fetched with the org filter; no cross-org evidence |

Cross-organization ids always 404 — existence itself is not disclosed.

## 4. Sequences

Incident numbers are per-organization, per-year sequences
(`nextIncidentNumber(db, orgId, now)` → `INC-<year>-<6 digits>`). Two
organizations can both issue `INC-2026-000001` without collision, and a
cancelled incident's number is never reused.

## 5. Future multi-tenancy

Nothing in the Phase 6 UI manages organizations (single plant deployment);
the service boundary above is what multi-tenancy would build on. Phase 7+
work that adds org management must reuse `resolveActorOrg` rather than
introducing a second identity path.
