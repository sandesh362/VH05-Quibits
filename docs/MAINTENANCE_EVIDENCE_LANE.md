# The Maintenance Evidence Lane

The third evidence class, and the one that is never evidence of causation.

## 1. Why a separate lane

A maintenance record says *work was performed*. It does not say *what caused
a fault*, and it does not prescribe a repair for a new symptom. Mixing it
into manual evidence would let the model cite a service record as if it were
a manufacturer instruction — the exact conflation AC-13 forbids. The lane
exists so maintenance can inform an answer without ever becoming proof.

## 2. Lane anatomy

For each machine-scoped answer, Express passes up to
`MAINTENANCE_CONTEXT_MAX_ITEMS` recent records (each: id, type, title,
performed_at, parts_replaced, related_incident_id). The AI service derives,
deterministically:

| Field | Value | Rule |
|---|---|---|
| `days_before_incident` | 0…n | Whole days between `performed_at` and `query_at` |
| `correlation_strength` | strong / moderate / weak | Part named in question → strong; ≤30 days → moderate; else weak |
| `causal_claim` | **false** | Always. Hard-coded. |
| `noted_by_manual` | bool | Replaced part number appears in retrieved manual chunk text |
| `noted_by_manual_source_id` | source-N \| null | The manual citation that supports the correlation |

## 3. Prompt rules (20–24, `rag-p7-v1`)

- Maintenance appears under **MAINTENANCE HISTORY**, never inside
  **RETRIEVED EVIDENCE**; cite `maint-N` ids only.
- Entries are non-causal context: no “caused by” / “was fixed by” /
  “failed because” from maintenance alone.
- A `noted_by_manual` entry may be phrased as “the manual mentions a part
  that was serviced…” **with the manual citation** — correlation, not
  causation.
- Maintenance must include its age and correlation strength when presented.
- Conflicts with the manual: prefer the manual, record in
  `notes_on_conflicts`.

## 4. Presentation in answers

- The model may reference the lane via `maint-N` citations; those refs appear
  in `sources` with `sourceType: 'maintenance'`,
  `daysBeforeIncident`, `correlationStrength`, `causalClaim: false`.
- Even when the model does not cite the lane, the maintenance refs are
  attached to the answer's sources so the UI can render them — they are
  machine facts, not model claims.

## 5. UI caption (non-causal)

Chat sources of type `maintenance` render:

> Maintenance record — noted context, never causally linked to this fault
> (· N days before · correlation: strong/mod/weak)

…with the `noted_by_manual` note appended when present. The machine timeline
shows the same caption on every maintenance event.

## 6. Guarantees

- Zero maintenance items in `manual_evidence` — mechanically impossible
  (separate id namespace + separate prompt section + separate context field).
- Zero unhedged causal statements — the prompt rules plus the
  `causal_claim=false` metadata, verified by the adversarial assertions in
  `tests/test_maintenance.py`.
- Zero model-inferred correlation — every field is a pure function of the
  payload and the retrieved manual chunks.
