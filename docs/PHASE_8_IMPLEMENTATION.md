# Phase 8 — UI Completion & Safety Pass

**Status:** complete
**Scope:** the demo-ready interface layer — visually distinct evidence lanes, citations that land on the real manual content, the persistent safety disclaimer, the retrieval trace drawer, the admin jobs page, and the accessibility/responsive pass.
**Explicitly out of scope:** scanned page-image previews (no page images are extracted in this pipeline), Playwright E2E, pixel-level design system rework.

---

## 1. What Phase 8 delivers

| Area | Before (Phase 7) | After (Phase 8) |
|---|---|---|
| Evidence lanes | Citations rendered, maintenance captioned | Lane chips on every source (Manual / Historical / Maintenance), lane legend above the thread, distinct borders per class |
| Citations | Title/version/pages/excerpt modal | **Citation preview**: fetches the exact stored chunk (`GET /manuals/:id/chunks/:chunkId`) — section path, page range, full text, plus lane-specific captions for historical and maintenance sources |
| Safety | Per-page notes | **Persistent, non-dismissible safety disclaimer** in the app shell (every page, signed in or out) |
| Debuggability | Retrieval counts in audit only | **Retrieval trace drawer** per assistant message: manual/exact/semantic/historical/maintenance counts, warnings, sources used |
| Operations | Jobs endpoints existed | **Jobs page** (`/jobs`, manager/admin): live queue, per-job stage/attempt/error, retry |
| Errors | `ErrorState` with hints | Request-id error cards (already rendered; verified + documented) |
| A11y / responsive | Focus-visible + reduced-motion in global.css | Verified: dialog semantics (`role`, `aria-modal`, `aria-labelledby`, close labels), lane legend/list semantics, non-colour-only status (colour + icon + text everywhere), responsive lane grids and tables |

## 2. The AC-16 contract (evidence classes distinguishable in a screenshot)

> After a troubleshooting answer is produced: each evidence class renders as a
> visually distinct block, badged and labelled by source; safety warnings are
> always rendered first and are not collapsible.

- **Manual** — neutral chip “Manual”, solid border, cited with page numbers.
- **Historical incident** — amber chip “Historical”, amber border, caption:
  *“Historical context only — a similar past incident. It does not prove the
  current diagnosis…”*.
- **Maintenance** — blue chip “Maintenance”, blue border, caption:
  *“Maintenance record — noted context, never causally linked to this fault”*.

All three appear in the thread's legend before the first message, so the
distinction is visible even in a static screenshot. No distinction relies on
colour alone — every lane carries a text chip and a label.

## 3. Citation → real manual content

`GET /api/v1/manuals/:id/chunks/:chunkId` (auth: `manual.read`) returns the
stored chunk (`sectionPath`, `pageStart/End`, `text`, hash, indexing state).
The preview modal fetches it for manual sources and states its provenance:

> “This is the exact chunk the answer was grounded on (pages 42–43). This
> deployment stores extracted text; scanned page-image previews are not part
> of this phase.”

That sentence is deliberate: the UI never pretends to show an image it does
not have. Cross-manual chunk ids 404 (existence not disclosed), and the
endpoint is covered by the manuals suite in `crud.test.ts`.

Historical and maintenance sources have no chunks by design; their previews
render the lane metadata instead (days-before, correlation strength,
`causalClaim: false`).

## 4. Retrieval trace drawer

Per assistant message with stored `retrievalMetadata`, a “Retrieval trace”
button opens the drawer: manual evidence (final chunks), exact matches,
semantic matches, historical incidents, maintenance records, warnings, and
the sources used. It is built from what Express actually persists (the same
record the audit trail keeps) and says so — the full AI-service debug
payload is not persisted, and the drawer never invents numbers.

## 5. Persistent safety disclaimer

Rendered by the app shell on **every** page, signed in or out, with no
dismiss control:

> **Safety notice:** answers are generated from your indexed manuals and are
> fallible. Always verify against the machine documentation before acting —
> manual evidence is authoritative; historical and maintenance context is
> supplementary and never proves a diagnosis.

Tested in `frontend/src/layouts/app-layout.test.tsx` (visible signed out,
visible signed in, no dismiss control).

## 6. Jobs page

`/jobs` (nav shown for admin/manager; the backend enforces capabilities) —
live list of manual processing jobs: manual id, job type, current stage,
attempt, status badge (colour + icon + text), progress %, pages/chunks,
error code, and a Retry action (`POST /manual-processing-jobs/:id/retry`,
`manual.reprocess`). Polls every 10 s; retry buttons are disabled while a
job is queued/processing.

## 7. Testing

- **Frontend:** 28 vitest tests (citation-preview chunk fetch, lane legend,
  retrieval trace drawer, maintenance caption, safety disclaimer ×3, plus
  the existing suites). `tsconfig.app.json` typecheck and production build
  clean.
- **Backend:** `api.test.ts` asserts Phase 7; the manuals suite gains the
  chunk-preview cases (exact chunk, cross-manual 404, 401) — mongod-gated
  like the other HTTP suites, running in CI. Full backend tsc clean.
- **AI service:** unchanged this phase (156 pytest).

## 8. Must not

- Never render a page-image preview the pipeline did not produce.
- Never hide the safety disclaimer behind a dismiss or a scroll.
- Never show a retrieval count that was not stored.
- Never distinguish evidence by colour alone.
