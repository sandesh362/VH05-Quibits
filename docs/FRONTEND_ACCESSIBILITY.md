# FRONTEND_ACCESSIBILITY.md

Accessibility rules applied across the Phase 9 frontend.

## Semantics and structure

- Semantic landmarks: sidebar/topbar, `<main id="main-content">`, contentinfo
  footer; each page uses one `<h1>` inside `PageHeader`, with ordered headings
  thereafter.
- Forms: every control has an associated `<label htmlFor>` (or
  `aria-label` for icon-only controls). Required fields carry a visible `*`
  and `aria-required`. Errors set `aria-invalid` and are linked via
  `aria-describedby`; they are announced with `role="alert"`.
- Status badges communicate with **icon + text + colour together**
  (`lib/labels.ts`). Colour is never the sole signal — important for the
  ~8% of users with colour vision deficiency and for washed-out shop-floor
  screens.
- Tables use real `<table>/<thead>/<th>`; caption context comes from the card
  heading. Long tables scroll horizontally instead of reflowing content.

## Keyboard navigation

- All interactive elements are native buttons/links/inputs; no `div`-on-click
  patterns (the upload dropzone is an exception that also responds to Enter
  and Space).
- A high-visibility `:focus-visible` ring is defined globally.
- **Modal / Drawer / ConfirmDialog**: focus moves into the dialog on open,
  Tab cycles within the dialog, Escape closes it, and focus returns to the
  triggering element on close.
- **DropdownMenu**: opened with the keyboard trigger; Escape or click-away
  closes; menu items are real buttons (`role="menuitem"`).
- Tabs use `role="tablist/tab/tabpanel"` with `aria-selected` and
  `aria-controls`.

## Announcements

- Toast notifications render in an `aria-live="polite"` region; error toasts
  use `role="alert"`.
- Loading states use `role="status"` (`LoadingState`, skeletons, auth restore
  screen, progress bars with `role="progressbar"` and value attributes).
- Async errors use the `ErrorState` alert (`role="alert"`), with a Try-again
  action reachable by keyboard.

## Forms

- Inline, specific validation messages; the submit button is disabled while a
  mutation is in flight and marked `aria-busy`.
- The password visibility toggle exposes `aria-label` ("Show/Hide password")
  and `aria-pressed`.
- Confirmation dialogs for destructive actions label the required note and
  keep the confirm button disabled until validation passes.

## Contrast and target size

- Text colours and translucent status backgrounds are tuned for WCAG AA
  contrast on the dark surface.
- Minimum 40px tap targets (36px for compact controls), comfortable for
  gloved hands on tablets.

## What is NOT claimed

- No automated axe/lighthouse run is wired in; accessibility is enforced by
  the patterns above and component tests (dialogs, badges, pagination, form
  labels). Add an axe integration when CI is introduced.
