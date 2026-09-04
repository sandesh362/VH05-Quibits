# Incident Actions — the 4-way model

The one rule that defines this module:

> **An AI suggestion is NOT a technician action, and it can never become
> confirmed.** Only `action_type: 'technician'` entries represent work a
> human actually performed, and only those can carry results or be confirmed.
> Confirmation is a separate explicit human act — a recorded result of
> `successful` is not a confirmation.

---

## 1. Action types

| `actionType` | Meaning | Can carry a result? | Can be confirmed? | Can be edited? |
|---|---|---|---|---|
| `technician` | Work a human performed and recorded | Yes | Yes (with note) | Yes, until confirmed |
| `assistant_suggestion` | AI-proposed next step | No | **Never** | **Never** |
| `manual` | Reference to a manual step | No | No | Yes, until confirmed |
| `other` | Free-form note | No | No | Yes, until confirmed |

- The validators enforce the result rule at the schema level:
  `resultStatus !== 'not_tested'` with a non-technician `actionType` is a
  `422 VALIDATION_ERROR`.
- The service enforces the confirmation rule:
  `POST /incidents/:id/actions/:actionId/confirm` on a suggestion returns
  `403 FORBIDDEN` — "AI suggestions can never be confirmed."
- Editing an `assistant_suggestion` returns `409 CONFLICT` — "Record a
  technician action instead."
- A **confirmed** action (of any type) is locked: edits return `409`.

## 2. Recording

`POST /incidents/:id/actions`
`{ actionType, description, performedBy?, sourceMessageId?, sourceSuggestionId?, sourceManualId?, sourceManualVersion?, result?, resultStatus?, notes?, performedAt? }`

- `resultStatus` defaults to `not_tested`
  (`not_tested|successful|unsuccessful|partially_successful|inconclusive|
  temporary_improvement|worsened_condition`).
- For `technician` actions the performer defaults to the authenticated user;
  an explicit `performedBy` must be an active user in the same organization.
- Recording is refused on `closed`/`cancelled` incidents (`409`).
- Each record appends a timeline event
  (`technician_action_recorded` / `ai_suggestion_recorded` — suggestions are
  explicitly labelled in the timeline note).

## 3. Confirming

`POST /incidents/:id/actions/:actionId/confirm { note }`

- The note is mandatory (min 3 chars) and is stored in the audit log.
- Only the incident owner (reporter/assignee) or a manager/admin may confirm.
- The route lets technicians through (`authorizeAny(confirm, create)`) and
  the service makes the ownership decision — the same pattern as the Phase 5
  resolution flow.
- Confirmation sets `confirmed`, `confirmed_by`, `confirmed_at` and appends
  `technician_action_confirmed` to the timeline. It has **no** side effects
  on incident status — actions never resolve incidents by themselves.

## 4. Editing

`PATCH /incidents/:id/actions/:actionId`
`{ description?, result?, resultStatus?, notes?, performedAt? }`

- Only the performer or a manager/admin may edit (`403` otherwise).
- Description changes set `edited: true` and append the previous description
  to `edit_history`, exposed via
  `GET /incidents/:id/actions/:actionId/history`.

## 5. Import from conversations

When an incident is created from a conversation
([Conversation → incident](./CONVERSATION_TO_INCIDENT.md)), confirmed
technician actions become `technician` actions with
`resultStatus: 'not_tested'` and `sourceMessageId` pointing at the message.
AI suggestions are never imported. Imported rows are ordinary rows: they
still need explicit human confirmation before they count as confirmed work.
