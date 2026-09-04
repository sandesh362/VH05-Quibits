# FRONTEND_DESIGN_SYSTEM.md

A single, standardized design system for the operations workspace. The
aesthetic is **dark, high-contrast, and dense**: the users are technicians on
a shop floor, often on a washed-out tablet under bright light.

## Tokens (`styles/global.css`)

- Surfaces: `--color-bg`, `--color-surface`, `--color-surface-raised`,
  borders `--color-border`, `--color-border-strong`.
- Text: `--color-text`, `--color-text-muted`, `--color-text-subtle`.
- Status tones (each with a solid colour and a translucent background):
  `ok`, `info`, `warn`, `error`, `neutral`.
- Radius: `--radius` (8px), `--radius-sm` (5px).
- Spacing scale: `--space-xs/sm/md/lg/xl` (4/8/16/24/32).
- Fonts: system sans for UI, monospace for codes/IDs/error codes.

## Status is never colour-only

Every status renders as **icon + text label + tone**. Maps live in
`lib/labels.ts` (`incidentStatus`, `issueStatus`, `severity`, `priority`,
`rootCauseStatus`, `fixStatus`, `actionResultStatus`, `processingStatus`,
`jobStatus`, `machineStatus`, `maintenanceType`, `conversationStatus`,
`techActionStatus`). Unknown values fall back to a neutral presentation
instead of crashing.

Covered semantic states: open, investigating, waiting (info/parts), resolved,
closed, reopened, cancelled, confirmed, suspected, rejected, temporary fix,
permanent fix, successful, unsuccessful, critical/high/medium/low, queued,
processing, completed, failed.

## Components (`components/ui.tsx`)

- **Button**: `primary`, `secondary`, `danger`, `ghost`; `loading` with
  spinner and `aria-busy`; disabled states; minimum 40px tap target.
- **Badge / ToneBadge**: pill with icon + label + tone.
- **Field + TextInput / SelectInput / TextArea / PasswordInput**: labelled
  controls with required markers (`*`), inline `field__error`, `aria-invalid`,
  `aria-describedby`, visible focus ring. Password has an accessible show/hide
  toggle.
- **Card**, **PageHeader** (breadcrumbs, title, description, actions),
  **StatTile** (dashboard metrics, linkable).
- **Tabs / TabPanel** with `role=tablist/tab/tabpanel` and `aria-selected`.
- **Modal / Drawer**: `role=dialog`, `aria-modal`, labelled by title, Escape
  to close, backdrop click to close, focus moves in on open and returns on
  close, Tab cycles within the dialog.
- **ConfirmDialog**: for destructive/high-impact actions; optional mandatory
  note (with `min-length` validation), "cannot be undone" warning, loading
  state. Used for incident close/reopen, root-cause reject, deletes, etc.
- **DropdownMenu**: `aria-haspopup=menu`, `aria-expanded`, click-away and
  Escape close.
- **Tooltip**, **Pagination**, **Skeleton / SkeletonTable**, **ProgressBar**
  (`role=progressbar`), **Alert** (tones ok/info/warn/error), **DescriptionList**.
- **EmptyState / ErrorState / LoadingState** (`components/states.tsx`).

## Layout

- Sidebar (248px) with grouped, role-filtered navigation; sticky topbar with
  the current-user menu; content max-width 1280px.
- Below 1024px the sidebar becomes a slide-in drawer with hamburger and
  backdrop; below 640px forms stack and user names collapse.
- Tables live in `.table-wrap` (horizontal scroll on small screens) rather
  than crushing columns.

## Safety wording

Evidence lanes and the persistent footer repeat the product rule: **manual
evidence is authoritative; historical incidents and maintenance are
supplementary context and never prove a diagnosis or fix.**
