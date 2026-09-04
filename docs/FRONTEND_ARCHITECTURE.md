# FRONTEND_ARCHITECTURE.md

Phase 9 completes the React web application. This document describes the
frontend's structure, data flow, and conventions. It assumes you have read
`ARCHITECTURE_OVERVIEW.md` and `API_CONTRACTS.md`.

## Stack

- **React 18 + TypeScript** (strict mode, `noUnusedLocals/Parameters`)
- **Vite 5** dev server and bundler
- **react-router-dom v6** for routing
- **Vitest + Testing Library** for unit/component/integration tests
- **Plain CSS with custom properties** — no CSS framework or component library
- **No state-management library**: a hand-rolled data hook (`useApi`) plus
  React context for auth and toasts. The backend owns all data; server state
  stays local to the page that fetched it.

## Directory layout

```
frontend/src/
  App.tsx                    # Route table: lazy-loaded pages + protected routes
  main.tsx                   # Providers: BrowserRouter, AuthProvider, ToastProvider, ErrorBoundary
  components/
    ui.tsx / ui.css          # Design-system kit (buttons, fields, modal, drawer,
                             #   dropdown, tabs, badges, pagination, skeletons, confirm…)
    states.tsx               # LoadingState / ErrorState / EmptyState / InlineSpinner
    status-badge.tsx         # Service dependency badges (health page)
    incident-badges.tsx      # Incident domain badges (used by incident pages)
    citation-preview.tsx     # Manual citation drawer (chat)
    retrieval-trace.tsx      # Retrieval trace drawer (chat)
    error-boundary.tsx       # Top-level React error boundary
  layouts/
    app-layout.tsx/css       # Sidebar + topbar shell, role-aware navigation, mobile drawer
  lib/
    api-client.ts            # Single HTTP client: envelope, errors, multipart upload, all endpoints
    auth.tsx                 # AuthProvider, useAuth, RequireAuth, RequireCapability
    permissions.ts           # Frontend capability map mirroring backend/common/policy.ts
    labels.ts                # Semantic icon+label+tone for every status enum
    user-labels.ts           # Role badge presentation
    format.ts                # Dates, bytes, location, title-case
    toast.tsx / toast.css    # Toast notification context + aria-live region
    use-api.ts               # Data-fetching hook (abort, refetch, polling, initial vs refresh)
  hooks/
    use-debounced-value.ts   # Debounced search inputs
  pages/                     # One file per route; *.test.tsx colocated
  styles/
    global.css               # Design tokens + base styles (dark, high-contrast)
```

## Data flow

1. **API client** (`lib/api-client.ts`) is the *only* place that calls
   `fetch`/`XHR`. It unwraps the shared `{ success, data, meta }` envelope,
   attaches the bearer token, normalises failures into `ApiClientError`
   (with status, request id and field-level `details`), and invokes the
   registered 401 handler on authentication failures.
2. **Pages** call the client through `useApi(fetcher, deps, pollMs?)`, which
   provides `{ data, error, isLoading, isInitialLoading, refetch }`, aborts
   in-flight requests on unmount, and optionally polls (jobs page).
3. **Mutations** call the client directly, surface success/failure through the
   toast context, and trigger `refetch()` of the affected queries so the UI
   never shows stale data. No global cache is kept.
4. **Auth state** lives in `AuthProvider` (sessionStorage tokens + context).
   Session restore validates the token via `/auth/me` and falls back to
   `/auth/refresh` once.

## Code splitting

Every feature page is `React.lazy`-loaded (`App.tsx`), producing a per-route
chunk. The initial bundle contains React, the router, the shell and the login
page; feature pages load on demand.

## Routing

See `FRONTEND_ROUTES.md`.

## Known constraints

- The frontend never talks to FastAPI, Qdrant, Mongo or Ollama — only to
  Express over relative `/api/v1` paths (proxied by Vite in dev, by nginx in
  Docker).
- There is no audit-log listing endpoint in the backend yet; audit history is
  surfaced through incident timelines and the machine activity timeline.
  See `FRONTEND_API_INTEGRATION.md`.
