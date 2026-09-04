# FRONTEND_TESTING.md

## Commands

```bash
# from the repository root
npm install
npm run build:shared          # build @itp/shared (required first)
npm run test:frontend         # vitest run (one-shot)
# or inside frontend/
cd frontend
npx vitest                     # one-shot
npx vitest watch               # watch mode
npx vitest run src/pages/machines-page.test.tsx
npm run typecheck              # strict TypeScript (run from repo root)
npm run build --workspace @itp/frontend   # production build
```

## Framework

Vitest with jsdom, `@testing-library/react` and
`@testing-library/user-event`. Tests are colocated as `*.test.tsx` next to the
code they cover. Setup lives in `src/test-setup.ts` (jest-dom matchers, mock
reset after each test).

## Coverage by file

| Test file | What it validates |
| --- | --- |
| `components/ui.test.tsx` | Semantic badge icons/labels/tones for incident, root-cause and processing states; ConfirmDialog mandatory-note gating and irreversibility warning; Modal labelling and Escape close; Pagination disabled states and empty rendering |
| `lib/api-client.test.ts` | Envelope unwrapping, error normalization, query encoding |
| `lib/auth-routing.test.tsx` | Protected redirect to /login, authenticated render, capability gating to `/forbidden`, admin allowed |
| `layouts/app-layout.test.tsx` | Persistent safety disclaimer in signed-out and signed-in states; user menu exposes sign-out |
| `pages/login-page.test.tsx` | Login calls the API and stores tokens; invalid credentials show a safe error |
| `pages/dashboard-page.test.tsx` | Fleet metrics derived from list endpoints; error state + retry |
| `pages/machines-page.test.tsx` | Machine row rendering (badge, location, open counts), empty state, manager-only create action, error retry |
| `pages/manual-upload-page.test.tsx` | Non-PDF rejection, oversize rejection, filename → title prefill, required version/model fields |
| `pages/conversation-detail-page.test.tsx` (pre-existing, extended wrapper) | Citations never expose filesystem paths; maintenance sources captioned non-causal; evidence lanes legend; retrieval trace drawer; refusal rendering; failed-send retry; citations open exact chunk |
| `pages/status-page.test.tsx` | Dependency status rendering (pre-existing) |

## Test style

- Assert **behaviour**: queries target accessible labels/roles/text, not
  implementation detail.
- The API boundary is mocked by spying on `apiClient` methods; no real network.
- Sessions in tests are established via sessionStorage + a mocked
  `apiClient.me()`, exactly as the production restore path does.
- Async assertions use `findBy*`/`waitFor`; mutations assert both API calls and
  resulting UI.

## Not covered yet (future work)

- End-to-end browser tests against the full Docker stack (recommended next).
- Automated axe/contrast checks in CI (patterns in
  `FRONTEND_ACCESSIBILITY.md`).
- Drag-and-drop upload pointer interaction (file input change is tested).
