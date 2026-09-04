# Testing Phase 8

What each layer proves about the UI completion pass.

## 1. Frontend (vitest — 28 tests)

**`conversation-detail-page.test.tsx` (7):**

- citations render without filesystem paths; suggestions stay separate from
  technician actions;
- the citation preview fetches the exact chunk and shows section path,
  pages, and the chunk text (via `GET /manuals/:id/chunks/:chunkId`);
- the lane legend names all three evidence classes with their rules;
- the retrieval trace drawer opens per answered message and shows lane
  counts, warnings, and sources;
- a maintenance source renders with the non-causal caption and the
  correlation note;
- refusals render with the backend's reason; failed sends keep the question
  and offer retry.

**`app-layout.test.tsx` (3):**

- the safety disclaimer renders signed out;
- it stays visible signed in;
- there is no dismiss control for it.

Plus the existing login (2) and status (2) suites. Typecheck:
`npx tsc --noEmit -p tsconfig.app.json`; production `npm run build` clean.

## 2. Backend (vitest)

- `api.test.ts`: 26 passing without mongod — `/system/info` reports
  **Phase 7** and the Phase 6+ capability flags.
- Manuals suite (mongod-gated, CI): the chunk-preview endpoint returns the
  exact chunk; a chunk requested under a different manual 404s; unauthenticated
  requests 401.
- The remaining HTTP suites run in CI where mongod is available
  (auth, authorization, conversations, crud, general, manual-upload, rag).

## 3. AI service

Unchanged this phase: `cd ai-service && .venv/bin/python -m pytest -q` →
156 passing.

## 4. Manual smoke checklist

1. Sign out and land on any page → the safety notice is visible at the
   bottom of the shell.
2. Open a machine-scoped conversation → the lane legend shows three lanes.
3. Ask about `E-041`-style content → the answer's citations carry Manual /
   Historical / Maintenance chips; the caption text matches the lane.
4. Click a manual citation → the preview shows the section path, pages, and
   the exact chunk text with the provenance note.
5. Click “Retrieval trace” on an answered message → counts, warnings and
   sources render; missing fields show “not recorded”.
6. As a manager, open `/jobs` → live jobs with stage/attempt/error; retry
   works for a failed job; technicians never see a retry button.
7. Force an API error → the error card shows the request id.

## 5. Acceptance mapping (AC-16, demo step 3)

| Requirement | Where verified |
|---|---|
| Each evidence class visually distinct, badged and labelled | lane chips + legend (frontend tests) |
| Safety warnings rendered first, not collapsible | persistent non-dismissible disclaimer (layout tests) |
| A stranger names each block's source from a screenshot | lane legend + captions; verified by the UI tests' text assertions |
| Click a citation → land on the real manual | chunk-preview fetch + backend chunk endpoint tests |
