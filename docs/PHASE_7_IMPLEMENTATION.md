# Phase 7 — Maintenance History Lane

**Status:** complete
**Scope:** maintenance as the third evidence class in RAG answers (separate, non-causal, AC-13), the merged machine timeline, maintenance org-scoping, and the maintenance/timeline UI.
**Explicitly out of scope:** predictive maintenance, maintenance *recommendations*, causal inference from maintenance data, notification scheduling, Phase 8+ roadmap items.

---

## 1. What Phase 7 delivers

| Capability | Before (Phase 6) | After (Phase 7) |
|---|---|---|
| Maintenance records | CRUD, part normalisation | Org-scoped CRUD (legacy rows → default org) |
| RAG evidence classes | Manual (authoritative) + historical incidents (supplementary) | + Maintenance lane (separate, **non-causal**) |
| Machine history | Incident timeline only | Merged machine timeline: maintenance + incident events |
| Frontend | Incidents + chat | Maintenance list/create, machines list, machine timeline |
| Wire contract | `manual evidence` + `history-N` | `maintenance_context[]` + `maint-N` citations |

`PROMPT_VERSION` is now `rag-p7-v1`.

## 2. The AC-13 contract

> Maintenance appears **only** in `maintenance_context[]`, never in
> `manual_evidence[]`; each entry carries `days_before_incident` and
> `correlation_strength`; `causal_claim` is always `false`; the UI shows the
> non-causal caption.

Enforced mechanically at three layers:

1. **Namespace:** maintenance source ids are `maint-N`; manual evidence ids
   are `source-N`. A maintenance entry can never satisfy a manual citation
   and vice versa (tested in `test_maintenance.py`).
2. **Prompt:** rules 20–24 forbid citing maintenance as manual evidence,
   forbid causal statements from maintenance, and require the `noted_by_manual`
   correlation to carry its manual citation.
3. **UI:** maintenance sources render with the caption *“Maintenance record —
   noted context, never causally linked to this fault”* in chat, and the
   machine timeline labels every maintenance event the same way.

## 3. Data flow

```
Express (conversation message / rag answer)
   ├─ machine scope present?
   │    └─ collectMaintenanceContext(db, org, machineId, now)
   │         bounded: MAINTENANCE_HISTORY_DAYS (365), MAINTENANCE_CONTEXT_MAX_ITEMS (5)
   └─ payload: { maintenance_context: [...], query_at: ISO }
          ▼
FastAPI run_answer
   ├─ manual retrieval (authoritative) — unchanged
   ├─ historical incidents (supplementary) — unchanged
   └─ maintenance lane (separate):
        parse → days_before_incident → correlation_strength →
        noted_by_manual (part ∩ manual chunk text) →
        format block → maint-N refs → prompt section
```

Maintenance is **never** added to `/retrieval/search` — retrieval/search is
manual evidence by definition, and AC-13 forbids maintenance inside
`manual_evidence`.

## 4. Deterministic computations (`ai-service/app/rag/maintenance.py`)

- `days_before_incident` — whole days between `performed_at` and `query_at`
  (falls back to server time), never negative.
- `correlation_strength` —
  - `strong`: the question names a replaced part number (normalised token
    match, word-prefix aware, e.g. “strainer” ↔ `STRAINER-88`);
  - `moderate`: machine-scoped and ≤ 30 days old;
  - `weak`: everything else.
- `noted_by_manual` — `true` iff a replaced part number appears in the
  retrieved **manual** chunk text; the matching chunk's source id is attached
  so the prompt can cite the manual. Correlation, never causation.
- `causal_claim` — always `false`. Hard-coded, not computed.

No vectors are built for maintenance (by design): it is structured data
fetched by machine + time window, never embedded.

## 5. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MAINTENANCE_HISTORY_DAYS` | `365` | Lookback window for the lane (Express) |
| `MAINTENANCE_CONTEXT_MAX_ITEMS` | `5` | Max records passed per answer (Express) |

## 6. Testing

- **AI service:** `tests/test_maintenance.py` (17 tests) — parsing tolerance,
  days math, strength tiers, part-token normalisation, `noted_by_manual`
  intersection, block formatting, `maint-N` refs, citation validation, and
  the lane-separation prompt assertions. Full suite: 156 passing.
- **Backend:** timeline merging + kind filters, maintenance org isolation
  (cross-org 404/empty list), timeline access for every role + 401
  unauthenticated, viewer write refusal (in `crud.test.ts` /
  `authorization.test.ts`; mongod required, runnable in CI).
- **Frontend:** 22 vitest tests pass; production build clean.

## 7. Must not

- Never merge maintenance into `manual_evidence`.
- Never emit an unhedged causal statement from maintenance.
- Never guess correlation from the model — every field is deterministic.
- Never embed maintenance (no vectors).
- Never leak another organization's maintenance history into a lane.
