# FRONTEND_COMPONENT_GUIDE.md

How to build a screen consistently with the Phase 9 design system.

## Page skeleton

```tsx
import { PageHeader, Card, /* … */ } from '../components/ui';
import { EmptyState, ErrorState } from '../components/states';
import { useApi } from '../lib/use-api';
import { apiClient } from '../lib/api-client';

export function FooPage() {
  const { data, error, isInitialLoading, refetch } = useApi(
    () => apiClient.listFoos({ limit: 20 }).then((r) => r.data),
    [],
  );

  return (
    <div className="page">
      <PageHeader
        title="Foos"
        description="…"
        breadcrumbs={[{ label: 'Foos' }]}
        actions={<a className="btn btn--primary" href="/foos/new">New foo</a>}
      />
      <Card>
        {isInitialLoading && <SkeletonTable rows={6} cols={4} />}
        {error && <ErrorState error={error} onRetry={refetch} title="Could not load foos" />}
        {data?.length === 0 && <EmptyState title="No foos" message="…" />}
        {data && data.length > 0 && /* table or list */ null}
      </Card>
    </div>
  );
}
```

## Conventions

- **Data**: always via `useApi` for reads (aborts on unmount, polls when
  given an interval, exposes `isInitialLoading` so background refreshes do not
  blank the screen). For mutations call the client directly in an event
  handler, then `refetch()` affected queries and show a toast.
- **Forms**: use `Field` + `TextInput/SelectInput/TextArea/PasswordInput`
  inside `<form className="ui-form">`. Two-column layouts use
  `.form-grid` with `className="field--full"` for wide fields. Validate
  client-side, map server `details` to the same field keys, and show a toast
  for non-field errors. Disable the submit button while pending.
- **Confirmations**: destructive or high-impact actions (delete, close,
  reopen, root-cause reject) open `ConfirmDialog` with `requireNote` when the
  API requires a reason/summary. Never make them one-click.
- **Status**: render with `<Badge presentation={…} />` using a map from
  `lib/labels.ts`. Never invent ad-hoc colours for statuses.
- **Empty/loading/error**: every data view has all three states. Skeletons
  for first load; spinner in buttons for mutations.
- **Toasts**: `useToast().success/error(message)` for mutation outcomes.
- **Capability checks**: `const { can } = useAuth();` then
  `can('manual.create')` to hide actions the user cannot perform. The API
  still enforces.
- **Dates/sizes**: use `formatDate`, `formatDateShort`, `toDateInput`,
  `formatBytes` from `lib/format`.
- **Search inputs**: debounce with `useDebouncedValue` (300 ms) to avoid a
  request per keystroke; reset to page 1 when filters change.
- **Pagination**: server-side via `meta.pagination`; use the `Pagination`
  component. Never fetch huge datasets.
- **Lazy routes**: add new pages to `App.tsx` with `React.lazy` and a
  `Protected` wrapper.

## Reusable building blocks

`ui.tsx`: Button, Badge, ToneBadge, Field, TextInput, SelectInput, TextArea,
PasswordInput, Card, PageHeader, StatTile, Tabs/TabPanel, Modal, Drawer,
ConfirmDialog, DropdownMenu, Tooltip, Pagination, Skeleton, SkeletonTable,
ProgressBar, Alert, DescriptionList.

`states.tsx`: LoadingState, InlineSpinner, ErrorState, EmptyState.

`incident-badges.tsx`: IncidentStatusBadge, IssueStatusBadge, SeverityBadge,
PriorityBadge, RootCauseStatusBadge, ConfirmedBadge (used by incident pages).

## Styling

Use design tokens and the shared classes (`.data-table`, `.table-wrap`,
`.filter-bar`, `.form-grid`, `.desc-list`, `.tag-list`, `.timeline`,
`.evidence-lane`). Add page-specific CSS to the page's co-located stylesheet
only when the kit does not cover it.
