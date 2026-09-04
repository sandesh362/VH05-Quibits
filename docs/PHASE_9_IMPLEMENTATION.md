# PHASE_9_IMPLEMENTATION.md

Phase 9 delivers the complete, production-oriented React web application:
consistent shell, design system, auth, dashboard, machine/model/manual
management, processing visibility, troubleshooting assistant, incidents with
confirmations and historical evidence, maintenance, users, and settings — all
on the existing Express + FastAPI APIs. No backend business logic, RAG
changes, collections, or Phase-10 features were introduced.

## What changed

### Application shell and design system
- New sidebar + topbar application shell with role-aware grouped navigation,
  current-user menu (profile, sign out), mobile slide-in drawer with backdrop
  and route-change close.
- Standardized design-system kit (`components/ui.tsx/.css`): buttons, labelled
  form fields (incl. password toggle), cards, stat tiles, tabs, semantic
  status badges, accessible modal/drawer, confirmation dialog, dropdown menu,
  tooltip, pagination, skeletons, progress bar, alerts, description lists.
- Semantic status language (icon + text + tone, never colour alone) for all
  incident/issue/severity/priority/root-cause/fix/result/processing/job/
  machine/maintenance/conversation states via `lib/labels.ts`.
- Toasts (`lib/toast.tsx`) for success/error feedback.

### Authentication and authorization
- Session restore verifies `/auth/me`, falls back to a single
  `/auth/refresh`, clears on failure; network-down retains the session.
- Any API 401 triggers the global expired-session flow.
- `RequireAuth` and `RequireCapability` route guards; nav/actions filtered by
  a frontend capability map that mirrors `backend/common/policy.ts` (the API
  still enforces).
- `/forbidden` page; login page rebuilt with validation, password toggle,
  safe errors, expired banner, redirect-back.

### Pages
- **Dashboard** (`/dashboard`): stat tiles (machines, open/critical/
  investigating incidents, recurring machines, processing manuals, records,
  indexed manuals), critical-incident list, live document-processing panel,
  recent maintenance, recently uploaded manuals, troubleshooting activity —
  every figure derived from existing list endpoints; failure banner for
  failed jobs.
- **Machines**: list with search/status/model filters and pagination;
  registration form; machine detail with tabs (overview, incidents,
  maintenance, manuals, conversations, activity timeline); edit form (model
  change requires an audited reason; asset tag immutable); delete capability
  enforced server-side.
- **Machine models**: list with machine/manual counts, searchable; create/edit
  modal; detail drawer with aliases/specs; audited delete with mandatory
  reason (admin).
- **Manuals**: list with filters and explicit "searchable only when completed"
  presentation; drag-and-drop/drag-click upload with client-side PDF/size
  validation and real XHR progress; detail with metadata, per-stage pipeline
  status, stage table, error display, retry and audited delete.
- **Jobs** (`/jobs`, "Document Processing"): renamed navigation target, manual
  titles, semantic badges, progress bars, polling every 10 s, gated retry.
- **Conversations**: the existing chat gained rename, archive and delete
  actions (modal/dropdown), plus the existing citations, evidence lanes,
  refusal/clarification handling, technician actions, issue status, close/
  reopen and create-incident flows.
- **Incidents**: list/detail/report and full lifecycle were retained and the
  historical-evidence section now uses the required title ("Historical
  troubleshooting evidence"), explicit warning copy, and distinct
  confirmed / suspected / rejected / unresolved history badges.
- **Maintenance**: list upgraded (machine labels, technician filter, type
  badges, detail links); new detail page (parts, measurements, components,
  linked incident, edit within the backend's author/24h rule); create form now
  supports `?machineId=` preselection and lands on the detail page.
- **Users** (`/users`, manager+): list with search; admin create-user modal
  (role selection). Role update/deletion are **not** offered because no such
  API exists (documented in FRONTEND_API_INTEGRATION.md).
- **Settings** (`/settings`): profile update and change password.

### API client
- Extended to cover the full Express surface (machine/model CRUD, manual
  multipart upload with progress, processing-status/pages/chunks, maintenance
  detail/update, register/change-password, conversation rename/delete/
  archive, refresh). Field-level error details propagate to forms.

### Performance
- Route-level code splitting (`React.lazy` per page; ~67 kB gzip initial).
- Debounced search, server-side pagination, polling only on the jobs page,
  request abort on unmount, background refresh that never blanks content.

### Tests
- 50 tests pass (28 pre-existing updated for the new shell/forms, plus new
  component, routing, dashboard, machines and upload suites). Strict
  TypeScript compiles; production Vite build succeeds with per-route chunks.

## Local development

```bash
npm install
npm run build:shared
npm run dev               # api + ai + frontend together (concurrently)
# or separately: npm run dev:frontend / dev:backend / dev:ai
```

Frontend at the printed Vite port (5173 by default); it proxies `/api` to
Express. Set `VITE_DEV_PROXY_TARGET` if the backend runs elsewhere.

Build/test:

```bash
npm run build --workspace @itp/frontend
npm run test:frontend
npm run typecheck
```

## Known limitations / missing contracts

Documented in full in `FRONTEND_API_INTEGRATION.md`: no audit-log listing
endpoint (timelines serve as audit views), no user role-update/deactivation
endpoint, no notifications feed, single-organization (no org switcher), no
manual PDF binary download route. None of these are mocked.

## Explicitly NOT in this phase

Predictive-maintenance or IoT/telemetry work, autonomous agents, new LLM
providers/RAG logic, new Qdrant collections, automatic incident closure or
confirmation, automatic scheduling, voice/image diagnosis, machine control,
payments, or marketing pages. Phase 10 has not been started.
