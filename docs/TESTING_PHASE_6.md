# Testing Phase 6

What each layer proves and how to run it.

---

## 1. Backend (Express, vitest)

**`tests/crud.test.ts`** — lifecycle and business rules over HTTP:

- creation: generated per-org numbers, normalised error codes, machine
  required, model/machine mismatch refusal, date-range validation;
- list filters + pagination metadata;
- status/issue-status transition maps (allowed, refused, timeline
  recording);
- root cause: record → confirm (mandatory note, mandatory text),
  confirm-through-update refused, reject, immutability after confirmation,
  double-confirmation conflict;
- fixes: record → confirm for both kinds, temporary-fix → issue-status
  effect, permanent-fix + confirmed root cause → `resolved`, no resolution
  without a confirmed root cause, second-fix conflict;
- close/reopen rules; cancellation (reason required, hides the record,
  releases the machine's open counter); settled-incident locks;
- actions: 4-way model, result-only-for-technician validation, suggestions
  never confirmable, confirmed-action immutability, "successful ≠
  confirmed";
- similar incidents: Mongo fallback when the AI service is down, reasons,
  `confirmed` flag; reindex (`202`).

**`tests/authorization.test.ts`** — the role matrix and ownership:

- create: technician yes / viewer no; edit: own vs others'; manager edits
  any;
- root-cause confirm and fix-confirm/close reserved for manager/admin;
- reopen ownership (own vs other technician); cancel ownership;
- read access for every role (detail + timeline);
- viewer write-refusal matrix (incl. `POST /incidents`);
- reindex refusal for technician/viewer;
- organization isolation: cross-org incident ids 404, lists empty;
- `GET /users` manager-only.

**`tests/api.test.ts`** — `/system/info` reports Phase 6
(`incidentManagement`, `incidentMemory`, `maintenanceHistory` true).

**Harness:** `tests/helpers/app.ts` now reseeds the default organization on
every `resetDb` (Phase 6 actors always resolve to an org). The HTTP suites
run against a real in-memory mongod; where no mongod is available they are
skipped, and the mongod-free suites (config, api, conversation-context,
manual-files, rag-hash) still run.

```sh
cd backend && npm test
```

## 2. AI service (pytest — 139 tests)

- incident-memory indexing: point ids, payload, empty-text refusal,
  collection dimension assertion;
- similar retrieval: ranking formula, exact-error-code leg, org isolation,
  confirmed-vs-speculative handling, graceful warnings;
- RAG pipeline: historical evidence block integration, `history-N` citation
  validation, prompt version `rag-p6-v1`, history-never-proof rules;
- configuration defaults for `INCIDENT_HISTORY_*`.

```sh
cd ai-service && .venv/bin/python -m pytest -q
```

## 3. Frontend (vitest + build)

- 22 component/page tests (login, conversations, status, API client);
- `tsconfig.app.json` typecheck and a production `vite build` must be clean.

```sh
cd frontend && npm test && npm run build
```

## 4. Manual smoke checklist

1. Report an incident from `/incidents` and from a conversation (explicit
   facts only — no AI suggestions in the imported actions).
2. Walk the lifecycle: investigate → record suspected root cause → confirm
   (note) → record permanent fix → confirm (note) → incident resolved →
   close with summary → reopen with reason.
3. Confirm a temporary fix and watch the issue status move to
   `temporary_fix`.
4. Cancel an incident and confirm it disappears and the machine counter
   drops.
5. With the AI service down, open "similar incidents" and confirm the
   deterministic error-code fallback still returns reasons.
6. Ask a RAG question on a machine with historical incidents and confirm the
   answer cites `history-N` sources and treats history as supplementary.
