# FRONTEND_ERROR_HANDLING.md

## Principles

1. **Every data view** implements initial loading, background loading, empty,
   not-found, unauthorized, forbidden, validation, network and server states.
2. **Errors are never swallowed**: they either render an `ErrorState` with a
   retry action (reads) or a toast + inline field errors (mutations).
3. **No sensitive detail**: stack traces, tokens and internal paths are never
   displayed. Server messages for field errors are shown verbatim only because
   the backend already sanitizes them.

## Mapping

| Situation | UX |
| --- | --- |
| First load | Skeleton (`Skeleton`, `SkeletonTable`) or `LoadingState` |
| Background refresh | Existing content stays; small "Refreshing…" note; the 10s polling never blanks the page |
| Network error / timeout / 5xx | `ErrorState` with plain-language hint and **Try again** button (retry-safe) |
| 404 (record missing) | Inline not-found `ErrorState` on detail pages; 404 route for unknown URLs |
| 401 (session expired) | Global handler clears the session; user returns to login with an expired-session banner |
| 403 (capability missing) | Route-level: `/forbidden` page; action-level: control hidden by capability; a racing 403 shows a toast/error |
| 422 validation | Field-level errors (`ApiClientError.details`) inline; non-field issues as toast |
| 409 conflict | Toast with the server's message (duplicate asset tag, duplicate manual hash, state conflict) |
| 413 file too large | Inline upload error before/after server rejection |
| 429 rate limited | Specific "too many attempts" message on login; generic retry suggestion elsewhere |

## Components

- `ErrorState` (`components/states.tsx`): icon, title, the error message, a
  hint per error code, the safe request id, and an optional retry.
- `Alert` tones (`ok/info/warn/error`) for contextual inline messaging.
- Toasts for transient mutation outcomes; error toasts persist longer (8s).
- Confirmation dialogs guard irreversible/high-impact actions and state
  reversibility, and collect required notes (closure summary, reopen reason,
  root-cause rejection, deletion reason).

## Chat/RAG specific states

- Refusal responses and clarification requests render distinct, labelled
  panels — they are not presented as answers.
- Insufficient/conflicting evidence shows a dedicated message; citations are
  only shown when the server returns them (the client never fabricates them).
- A failed answer keeps the user's question and offers a retry.

## Error boundary

`components/error-boundary.tsx` catches render-time crashes and shows a static
recovery screen with a reload action.
