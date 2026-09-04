# Phase 5 — Conversational Troubleshooting

**Status:** complete, pending review
**Scope:** technician chat on top of Phase 4 retrieval/RAG — conversation CRUD, bounded history, persisted messages, citations, clarification/refusal/conflict/failure UI, technician actions, explicit issue status, close/reopen/archive
**Explicitly out of scope:** incident-memory retrieval, maintenance recommendations, predictive maintenance, autonomous actions, tool-calling, cloud AI, voice, images, notifications

---

## 1. What Phase 5 delivers

Phase 4 answered a single question. Phase 5 turns that into a troubleshooting thread.

| Capability | Before (Phase 4) | After (Phase 5) |
|---|---|---|
| Chat API | `POST /rag/answer` (stateless) | `POST /conversations/:id/messages` |
| History | `conversationId` ignored | Bounded recent turns + confirmed facts |
| Persistence | none | User + assistant messages, even on RAG failure |
| Actions | none | Technician actions are a separate collection |
| Issue status | none | Explicit PATCH; never inferred from AI |
| Frontend | health + RAG lab | Login + conversation list/create/chat |

`/system/info` reports `PHASE_5_FEATURES`. `incidentMemory` stays false.

---

## 2. Ownership

- **Express** authenticates, authorises, validates machine/model/manual scope, persists messages, assembles conversation context, calls FastAPI, formats the public envelope, records technician actions, audits.
- **FastAPI** retrieves, generates, cites, and may consume `conversation_context`. It still does not write business collections.
- **Frontend** talks only to Express (`/api/v1/*`). It never addresses Ollama, Qdrant or FastAPI.

```
Technician UI
  POST /api/v1/conversations/:id/messages   (JWT)
        │  persist user message first
        ▼
Express  assembleContext (confirmed facts + last N turns)
        POST /internal/v1/rag/answer  (X-Internal-Token, conversation_context)
        │
        ▼
FastAPI  retrieve → evidence gate → prompt (history is untrusted except CONFIRMED)
        │
        ▼
Express  persist assistant message + suggested_actions (status=suggested)
```

---

## 3. Context rules

- Technician-recorded actions / findings are **CONFIRMED**.
- Assistant text is history only — never a completed repair.
- History is truncated by `CONVERSATION_HISTORY_MESSAGE_LIMIT` (default 10) and `CONVERSATION_CONTEXT_CHARACTER_LIMIT` (default 6000).
- Ambiguous follow-ups (“that did not solve it”) with ≥2 last suggested checks ask for clarification without calling RAG.

---

## 4. Issue status and actions

Issue statuses: `unknown`, `investigating`, `temporary_fix`, `resolved`, `unresolved`, `recurring`, `escalated`.

Marking a confirmed status requires `confirmationNote`. Sending a message never sets `resolved`. Recording an action never sets `resolved`. Closing does not delete messages.

Suggested checks live on the assistant message (`suggested`). Technician actions live in `conversation_actions`.

---

## 5. Configuration

See `.env.example`: `CONVERSATION_HISTORY_MESSAGE_LIMIT`, `CONVERSATION_CONTEXT_CHARACTER_LIMIT`, `MAX_CONVERSATION_MESSAGE_LENGTH`, `MAX_CONVERSATION_TITLE_LENGTH`, `MAX_ISSUE_SUMMARY_LENGTH`, `CONVERSATION_DUPLICATE_WINDOW_SECONDS`. Message POSTs reuse the Phase 4 RAG rate limiter.

---

## 6. Testing

- Backend: `tests/conversation-context.test.ts`, `tests/conversations.test.ts`, plus the existing CRUD persistence-on-failure case.
- FastAPI: prompt includes conversation context; `/system/info` reports Phase 5.
- Frontend: login, citation rendering, refusal, retry after send failure; api-client chat URL is relative.

---

## 7. Must not (still)

Incident-history vectors, maintenance retrieval, predictive maintenance, auto incident creation, auto repair confirmation, autonomous control, web search, voice, image troubleshooting, telemetry, notifications, analytics, technician scoring, agents, tool-calling, fine-tuning, cloud AI.
