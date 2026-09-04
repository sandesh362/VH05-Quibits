# FRONTEND_ROUTES.md

All routes render inside `AppLayout` (sidebar + topbar). Feature pages are
lazy-loaded. Protected routes use `RequireAuth`; capability-gated routes use
`RequireCapability` (mirrors the backend policy; the API still enforces every
permission).

| Path | Page | Access | Notes |
| --- | --- | --- | --- |
| `/` | Home / landing | Public | Product overview + backend feature flags |
| `/login` | Login | Public | Redirects to `/dashboard` when authenticated |
| `/forbidden` | Forbidden (403) | Authenticated | Shown by `RequireCapability` |
| `/status` | Service status | Public-ish | Health/readiness dependency probes |
| `/dashboard` | **Dashboard** | Any authenticated | Operational metrics, derived from list APIs |
| `/machines` | Machines list | `machine.read` | Search, status/model filters, pagination |
| `/machines/new` | Register machine | `machine.create` | Managers/admins |
| `/machines/:id` | Machine detail | `machine.read` | Tabs: overview, incidents, maintenance, manuals, conversations, timeline |
| `/machines/:id/edit` | Edit machine | `machine.update` | Asset tag immutable; model change requires a reason |
| `/machine-models` | Machine models | `machine_model.read` | List + create/edit drawer/modal + delete (admins) |
| `/manuals` | Manuals list | `manual.read` | Search, model/status/type filters, searchable indicator |
| `/manuals/upload` | Upload manual | `manual.create` | Multipart upload with progress + client validation |
| `/manuals/:id` | Manual detail | `manual.read` | Metadata, pipeline stages, retry/delete |
| `/jobs` | Document processing | `manual_processing_job.read` | Live processing jobs (10 s poll), retry |
| `/conversations` | Conversations list | `conversation.read_own` | Status/issue filters, search |
| `/conversations/new` | New conversation | `conversation.create` | Machine/model picker; supports `?machineId=` |
| `/conversations/:id` | Troubleshooting chat | `conversation.read_own` | Messages, evidence lanes, citations, actions, issue status, rename/archive/delete, create incident |
| `/incidents` | Incidents list | `incident.read` | Full filters + pagination |
| `/incidents/new` | Report incident | `incident.create` | Supports `?machineId=` |
| `/incidents/:id` | Incident detail | `incident.read` | Lifecycle, root cause, fixes, actions, similar history, timeline |
| `/maintenance` | Maintenance list | `maintenance.read` | Search, machine/type filters, pagination |
| `/maintenance/new` | Record maintenance | `maintenance.create` | Supports `?machineId=` |
| `/maintenance/:id` | Maintenance detail | `maintenance.read` | Parts/measurements + edit (author 24 h / manager any time) |
| `/users` | Users | `user.read_all` | Managers/admins; create user is admin-only |
| `/settings` | Settings | Any authenticated | Profile + change password |
| `*` | Not found | — | 404 page |

## Query parameters consumed

- `?machineId=` — pre-selects a machine on `machines/:id` links for
  incidents, conversations and maintenance forms.
- `?modelId=` — pre-selects a machine model on manual upload.
- List pages read their own filter state locally (search, status, severity,
  type, page) and translate it into API query parameters.

## Deep links and not-found behaviour

- Unknown pages render the 404 page with a link back to the dashboard.
- API 404s on a detail page render an inline error state with retry.
- API 403 on a gated route renders `/forbidden`.
