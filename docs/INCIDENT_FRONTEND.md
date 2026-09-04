# Incident Frontend (Phase 6)

Pages, components, and the design rules behind them. The browser talks only
to Express (`/api/v1/*`).

---

## 1. Routes (in `App.tsx`, behind `RequireAuth`)

| Route | Page | Purpose |
|---|---|---|
| `/incidents` | `IncidentsPage` | Searchable, filterable, paginated list |
| `/incidents/new` | `IncidentNewPage` | Creation form |
| `/incidents/:id` | `IncidentDetailPage` | Workflow + timeline + history + actions |

`/conversations/:id` gains the "Create incident" affordance; the layout
header gains an **Incidents** nav entry and the Phase 6 label.

## 2. Badges (`components/incident-badges.tsx` + `incidents.css`)

Status is always colour **+ icon + text** — never colour alone (the
convention from `StatusBadge`, important for washed-out shop-floor
screens):

- `IncidentStatusBadge` — open / investigating / waiting_* / resolved /
  closed / reopened / cancelled
- `IssueStatusBadge` — unknown / investigating / temporary_fix / resolved /
  unresolved / recurring / escalated
- `SeverityBadge`, `PriorityBadge` — low → critical / urgent
- `RootCauseStatusBadge` — unknown / suspected / confirmed / rejected
- `ConfirmedBadge` — confirmed vs unconfirmed, with icon

Unknown values fall back to a neutral presentation instead of crashing the
list.

## 3. List page

- Filter form: search, status, issue status, severity, priority, root-cause
  status, source; applied state is explicit (Apply / Clear buttons) so the
  list doesn't refetch on every keystroke.
- Sortable columns (status/severity via `sortBy`), pagination controls with
  "Page X of Y · N incidents", empty state with a "Report incident" action.
- Server-side filtering and pagination via `GET /incidents` query params —
  the client only renders what the API returns.

## 4. Creation page

- Machine is required and drives the model (the model is **derived**
  server-side; a mismatched `machineModelId` is rejected by the API). The
  form shows the derived model for verification.
- Multi-line textareas for symptoms / error codes / operating conditions /
  tags (one per line, trimmed, emptied lines dropped).
- Severity/priority selects; assignment picker only for manager/admin
  (backed by `GET /users`).
- Client-side required-field checks mirror the API's; server errors render
  in the form, never silently.

## 5. Detail page sections

1. **Metadata** — number, machine, model, reporter, assignee, source,
   conversation/manual links, embedding status (+ retry reindex when
   `failed`).
2. **Workflow** — status transitions with reason/note; the transition
   buttons shown are exactly the ones the lifecycle map allows; issue-status
   transitions separately.
3. **Root cause** — record-as-suspected, confirm (manager/admin; note
   mandatory, disabled button until filled), reject (reason prompt),
   confirmation history toggle.
4. **Fixes** — temporary and permanent sections with record → confirm; the
   permanent-fix section states explicitly that recording is not success
   and confirmation is separate.
5. **Technician actions** — record with type/result/result-status;
   suggestions and manual references listed separately and labelled "never
   technician actions"; confirm requires an explicit note.
6. **Similar historical incidents** — cards with reasons, score, badges,
   confirmed-outcome highlighting, and the mandatory disclaimer: *historical
   evidence is supplementary context, not proof; a previous fix will not
   necessarily solve this problem; manual instructions always take
   precedence*.
7. **Timeline** — newest first; type, actor, from→to, note.

## 6. Client rules (mirror of the server rules)

- Never render an AI suggestion as a technician action.
- Never show a confirm button for suggestions.
- Never imply similarity proves a diagnosis — the disclaimer is part of the
  component, not a help page.
- Show server errors (`ApiClientError` message) rather than generic text.
