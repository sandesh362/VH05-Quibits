# FRONTEND_API_INTEGRATION.md

## Central client

`frontend/src/lib/api-client.ts` is the **only** module that performs network
I/O. Every page calls a method on the exported `apiClient` object.

- Base URL: `import.meta.env.VITE_API_BASE_URL ?? '/api/v1'` (relative; the
  browser never targets FastAPI, Qdrant, Mongo or Ollama). The Vite dev server
  proxies `/api` to Express (`vite.config.ts`); nginx does the same in Docker.
- The shared response envelope `{ success, data, meta }` is unwrapped;
  failures become `ApiClientError(code, message, status, requestId, details)`.
- Bearer token is attached via a registered getter (`setAuthTokenGetter`).
- JSON requests have a 15s default timeout; RAG answers use 130s.
- Manual upload uses XHR (`uploadMultipart`) to report real upload progress;
  it sends the same bearer token and parses the same envelope.
- Any 401 triggers the registered unauthorized handler, which clears the
  session and returns the user to the login page with an "expired" notice.
- Pagination metadata is exposed via the `meta.pagination` returned by list
  calls.

## Endpoint coverage (frontend method → Express route)

| Area | Methods |
| --- | --- |
| System | `getHealth`, `getReadiness`, `getSystemInfo` |
| Auth/users | `login`, `refresh`, `logout`, `me`, `changePassword`, `updateMe`, `listUsers`, `registerUser` |
| Machines | `listMachines`, `getMachine`, `createMachine`, `updateMachine`, `deleteMachine`, `getMachineTimeline` |
| Machine models | `listModels`, `getModel`, `createModel`, `updateModel`, `deleteModel` |
| Manuals | `listManuals`, `getManual`, `uploadManual` (multipart), `updateManual`, `deleteManual`, `reprocessManual`, `getManualProcessingStatus`, `listManualPages`, `listManualChunks`, `getManualChunk` |
| Jobs | `listProcessingJobs`, `retryProcessingJob` |
| Maintenance | `listMaintenance`, `getMaintenance`, `createMaintenance`, `updateMaintenance` |
| Conversations | `listConversations`, `getConversation`, `createConversation`, `updateConversation` (rename), `deleteConversation`, `listMessages`, `sendMessage`, `listActions`, `recordAction`, `updateIssueStatus`, `closeConversation`, `reopenConversation`, `archiveConversation`, `createIncidentFromConversation` |
| Incidents | `listIncidents`, `getIncident`, `createIncident`, `updateIncident`, `changeIncidentStatus`, `changeIssueStatus`, `closeIncident`, `reopenIncident`, `deleteIncident`, `getIncidentTimeline`, `listIncidentActions`, `recordIncidentAction`, `confirmIncidentAction`, `updateRootCause`, `confirmRootCause`, `rejectRootCause`, `getRootCauseHistory`, `recordTemporaryFix`, `confirmTemporaryFix`, `recordPermanentFix`, `confirmPermanentFix`, `getSimilarIncidents`, `reindexIncident` |

## Error handling

- Field validation errors (HTTP 422) carry `details: [{ field, issue }]`;
  forms map these onto inline field errors (`ApiClientError.fieldError`).
- 401 → session expired flow; 403 → Forbidden page/inline message; 409 →
  conflict message (e.g. duplicate asset tag or duplicate manual hash);
  413 → file size error; 429 → rate-limit message.
- Network/timeout/5xx errors show the standard `ErrorState` with a retry
  button and a plain-language hint. Stack traces and tokens are never shown.

## Known missing contracts (documented, not mocked)

1. **Audit log listing endpoint.** The `audit_log.read` capability exists
   (and gates `/rag/debug`), but there is no `GET /audit-logs` route. Audit
   history is therefore presented through incident timelines
   (`GET /incidents/:id/timeline`) and the machine activity timeline
   (`GET /machines/:id/timeline`).
2. **User role updates / user deactivation.** Only `POST /auth/register`
   (admin-scoped for role) and `GET /users` exist; there is no
   `PATCH /users/:id` or delete. The Users page reflects this — create +
   list only.
3. **Notifications feed.** There is no notifications API; the shell's
   "notifications area" is intentionally omitted rather than faked.
4. **Organization switching.** Deployment is single-organization; the shell
   shows a static workspace label.
5. **Manual file download/view.** No binary download route exists; the UI
   links manuals by metadata and citations open chunk excerpts, not raw PDFs.

## Environment variables (frontend)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api/v1` | API base (relative in normal use) |
| `VITE_DEV_PROXY_TARGET` | `http://localhost:8080` | Dev-server proxy target |
| `VITE_ALLOWED_HOSTS` | localhost, .e2b.app | Dev host allowlist (`true` to disable) |
