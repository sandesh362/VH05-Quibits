# Testing Phase 7

What each layer proves about the maintenance lane and the machine timeline.

## 1. AI service (`tests/test_maintenance.py` — 17 tests)

- **Parsing tolerance:** malformed rows, non-dicts, and non-list payloads
  are skipped, never fatal.
- **`days_before_incident`:** whole-day math, never negative, bad dates fall
  back to zero.
- **`correlation_strength`:** strong when the question names a serviced part
  (word-prefix aware: “strainer” matches `STRAINER-88`), moderate for recent
  records, weak otherwise.
- **`noted_by_manual`:** true iff a replaced part number appears in a
  retrieved manual chunk, with that chunk's source id attached; false and
  null otherwise.
- **Determinism and AC-13 shape:** every entry carries
  `days_before_incident` + `correlation_strength` and
  `causal_claim == False`.
- **Block formatting:** age, strength, `causal_claim=false`, part numbers.
- **Source refs:** `maint-N` ids, `sourceType: 'maintenance'`,
  page-less, non-causal citation label.
- **Citation validation:** `maint-N` ids are accepted; a `source-N` claim
  with only maintenance refs present is dropped as invented.
- **Prompt separation:** MAINTENANCE HISTORY is its own section after
  RETRIEVED EVIDENCE, labelled NON-CAUSAL, never merged into manual evidence.

Full suite: `cd ai-service && .venv/bin/python -m pytest -q` → 156 passing.

## 2. Backend (`crud.test.ts`, `authorization.test.ts`)

- **Timeline merging:** a machine with one incident and one maintenance
  record returns both event kinds, newest first; `kind` filters return only
  the requested class with the expected fields.
- **Maintenance org isolation:** a record created in the default org 404s
  for a user in another org and is absent from their list; the owner still
  reads it.
- **Access:** every role reads `/machines/:id/timeline`; unauthenticated
  calls are 401; a viewer cannot record maintenance (403).

HTTP suites need a local mongod (CI); the mongod-free suites
(api, config, conversation-context, manual-files, rag-hash) run anywhere.

## 3. Frontend

- 22 existing vitest tests keep passing; the maintenance/timeline pages
  typecheck and the production build is clean.
- Manual smoke: record maintenance against a machine → open the machine
  timeline (event + non-causal caption) → run a machine-scoped conversation
  (RAG unavailable locally is fine) and inspect the wire payload for
  `maintenance_context`.

## 4. Acceptance mapping (AC-13)

| Requirement | Where verified |
|---|---|
| Maintenance only in `maintenance_context[]` | ai-service prompt-separation + namespace tests |
| `days_before_incident` + `correlation_strength` on every entry | `test_evidence_pipeline_is_fully_deterministic_and_non_causal` |
| `causal_claim` always false | same test; hard-coded in the module |
| Non-causal caption in the UI | frontend renders `maintenance-caption`; machine timeline labels maintenance events |
| Zero maintenance in `manual_evidence` | separate id namespace + prompt rules; adversarial citation test |
