# Incident Authorization

Who may do what with incidents and actions, and why the rules are split
between the route table and the service layer.

---

## 1. Capability matrix (Phase 6 additions)

| Capability | Admin | Manager | Technician | Viewer |
|---|---|---|---|---|
| `incident.read`, `incident_action.read` | ✓ | ✓ | ✓ | ✓ |
| `incident.create` | ✓ | ✓ | ✓ | — |
| `incident.update_own` | ✓ | ✓ | ✓ | — |
| `incident.update_any` | ✓ | ✓ | — | — |
| `incident.root_cause_update` | ✓ | ✓ | ✓ | — |
| `incident.root_cause_confirm/reject` | ✓ | ✓ | — | — |
| `incident.fix_record` | ✓ | ✓ | ✓ | — |
| `incident.fix_confirm` | ✓ | ✓ | — | — |
| `incident_action.create/update` | ✓ | ✓ | ✓ | — |
| `incident_action.confirm` | ✓ | ✓ | —* | — |
| `incident.close` | ✓ | ✓ | — | — |
| `incident.reopen` | ✓ | ✓ | —* | — |
| `incident.reindex` | ✓ | ✓ | — | — |
| `incident.delete` | ✓ | — | —* | — |
| `user.read_all` (assignment picker) | ✓ | ✓ | — | — |

\* Technicians reach these routes via `authorizeAny(…, update_own)` /
`authorizeAny(…, create)`; the service then decides by ownership (below).
Deny-by-default: any capability absent from a role's set is refused at the
middleware with `403 FORBIDDEN` before the service runs.

## 2. Ownership rules (service layer)

A capability alone cannot express ownership, so the service re-checks:

- **Manage** (update/status/issue-status/root-cause/fixes): manager/admin,
  or the incident's **reporter**, or its **assignee**. Anyone else gets
  `403 FORBIDDEN` — "You can only manage incidents that you reported or that
  are assigned to you."
- **Reopen:** a technician may reopen only their own incidents; managers/
  admins any.
- **Confirm an action:** only the incident owner (reporter/assignee) or a
  manager/admin — and only `technician` actions (suggestions are refused
  even for admins).
- **Edit an action:** only its performer or a manager/admin.
- **Cancel (`DELETE`):** managers/admins any; technicians only their own
  (via `requireManage`).

These rules are exercised in `authorization.test.ts` (role matrix, the
"technician edits somebody else's incident" case, reopen ownership,
cancel ownership, suggestion-confirmation refusal, org isolation).

## 3. Organization isolation

- Incidents and actions carry `organization_id`; every read/write filter
  includes it, resolved from the authenticated user's document.
- A cross-organization incident id returns **404, not 403** — existence is
  not disclosed.
- Assignment references must resolve to an active user **in the same
  organization**; cross-org user ids are `422 VALIDATION_ERROR`.

## 4. Lifecycle locks (not authorization, but security-relevant)

- `closed`/`cancelled` incidents reject all mutations with `409 CONFLICT`.
- A confirmed root cause is immutable (`409`) until reopen.
- Confirmed actions and confirmed fixes are immutable (`409`).
- `resolved` and `cancelled` are unreachable through generic status updates.

## 5. Audit coverage

Every mutation records `actor`, `entity`, `changes`/`reason`, and a request
id: creation, updates, status/issue-status changes, root-cause
update/confirm/reject, fix record/confirm, action record/update/confirm,
assignment changes, close, reopen, cancel, reindex, index success/failure,
and similar-search consultations.
