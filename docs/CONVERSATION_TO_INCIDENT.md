# Conversation → Incident

Turning a troubleshooting conversation into a formal incident report without
letting AI output masquerade as facts.

---

## 1. Endpoint

`POST /api/v1/conversations/:id/create-incident`
(auth: `incident.create`)

Response: `{ incident, importedActions }` — the new incident and the number
of technician actions carried over.

## 2. What is copied — explicit facts only

From the conversation document:

| Copied | Notes |
|---|---|
| `issue_summary` → title/description | Only if present |
| `error_codes` | Normalised on the way in |
| `symptoms` | Explicitly recorded symptoms |
| `operating_conditions` | If the conversation recorded them |
| `confirmed_findings` | Technician-confirmed findings become incident facts |
| Machine / model / manual references | Scope follows the conversation |
| Confirmed technician actions | Imported as `technician` actions, `resultStatus: 'not_tested'`, `sourceMessageId` set |

## 3. What is never copied

- **AI hypotheses, suggested actions, and assistant message text.** An AI
  suggestion is not a repair and never becomes an incident fact or a
  technician action. The assistant's role in the conversation ends when the
  conversation ends.
- Unconfirmed conversation state (`issue_status` does not move the incident;
  the incident starts `open` with its own issue status).
- Conversation messages (verbatim) — the conversation remains the context;
  the incident links back to it via `conversation_id`.

## 4. Mechanics

- The conversation must belong to the actor's organization; otherwise 404.
- The incident is created with `source: 'conversation'`,
  `conversation_id` set, and the conversation's `incident_ids` gains the new
  id (`$addToSet` — idempotent).
- The imported actions are ordinary action rows: they are **unconfirmed**
  (`resultStatus: 'not_tested'`) until a human explicitly confirms them on
  the incident — nothing arrives pre-confirmed.
- Audit + timeline events record the import on both records.

## 5. Frontend

The conversation detail page shows a "Create incident from this
conversation" action only when the conversation has no linked incident yet;
otherwise it links to the incident(s). The button carries the same
disclaimer: only explicit facts are copied, AI suggestions are never
imported.
