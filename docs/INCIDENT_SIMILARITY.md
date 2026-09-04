# Similar-Incident Retrieval

The Phase 6 analogue of manual retrieval: given one incident, find historical
incidents that may be relevant — with explicit reasons, hard org isolation,
and a UI disclaimer that similarity is not proof.

---

## 1. Endpoint

`GET /api/v1/incidents/:id/similar` (auth: `incident.read`)

Response: `{ similar: [{ incidentId, incidentNumber, title, status, …,
similarityScore, similarityReasons, confirmed, confirmedRootCause,
confirmedFix }] }`.

`confirmed` is `true` only when the historical incident has **both** a
confirmed root cause and a confirmed fix — the UI renders speculative
history differently and the ranking prefers confirmed outcomes.

## 2. Hybrid retrieval

**Leg 1 — AI service** (`POST /incidents/similar`):
semantic search over Qdrant plus exact error-code matching in Mongo, ranked
by the formula below.

**Leg 2 — Mongo fallback (Express):** if the AI service is unreachable (or
returns nothing) and the incident has error codes, Express finds exact
error-code matches in the same organization directly, ranks same-model
matches higher, and returns them with reasons — so the feature degrades to
deterministic structured matching, never to an error.

## 3. Ranking formula (AI service, `similar.py`)

| Signal | Score |
|---|---|
| Exact error-code match | +0.35 |
| Same machine | +0.15 |
| Same machine model | +0.10 |
| Symptom overlap | +0.05 |
| Confirmed root cause + confirmed fix | +0.10 |
| Speculative / unresolved | −0.15 |
| Resolved but unconfirmed | −0.075 |
| Recency | +0.05 · exp(−days/365) |

Candidates below a threshold (0.25) are dropped. The final sort key is
`(confirmed, score, resolved_at || created_at)` descending — confirmed
outcomes always outrank equally-scored speculative history.

## 4. Reasons over numbers

Every result carries human-readable `similarityReasons`
(e.g. `Exact error-code match`, `Same machine model`,
`Has confirmed root cause and confirmed fix`). The UI must show reasons
alongside the score — a number alone is not actionable, and the disclaimer
(§5) must be visible.

## 5. Historical evidence is not proof

- A similar incident's **confirmed root cause is context, not a diagnosis**;
  its confirmed fix is **not a prescription**.
- The incident detail page renders this disclaimer above the similar list,
  and the RAG prompt (rules 14–20, see
  [RAG historical evidence](./RAG_HISTORICAL_EVIDENCE.md)) enforces the same
  rule inside answers.
- Speculative historical incidents (no confirmed outcome) are shown but
  explicitly labelled.

## 6. Isolation and audit

- Organization is a hard filter on both legs; cross-org leakage is
  impossible by construction (and tested).
- Every similar search is audited
  (`incident.similar_search`, metadata: match count + warnings) and appends
  `similar_incident_search` to the timeline — operators can see when the
  memory was consulted.

## 7. Failure modes

| Failure | Behaviour |
|---|---|
| AI service down | Mongo fallback; response carries a warning |
| Ollama down | Same |
| No candidates | Empty list (200), not an error |
| Incident id from another org | 404 (existence not disclosed) |
