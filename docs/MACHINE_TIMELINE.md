# Machine Timeline

One chronological view of everything recorded about a physical machine:
maintenance records and incident events. It merges records; it never invents
them.

## 1. Endpoint

`GET /api/v1/machines/:id/timeline` (auth: `machine.read` — every
authenticated role)

Query params:

| Param | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `all` \| `maintenance` \| `incident` | `all` | Which event class to include |
| `from` / `to` | ISO date | — | Window on event time |
| `limit` | 1–200 | 100 | Max merged events |

Response:

```
data: {
  machine: { id, assetTag, displayName, modelLabel, openIncidentCount },
  timeline: [
    { id, kind: 'maintenance'|'incident', at, title,
      actorId, actorUsername,
      // maintenance events:
      maintenanceType, partsReplaced[],
      // incident events:
      incidentId, incidentNumber, eventType, previous, next, note }
  ]
}
```

## 2. Sources merged

- **Maintenance records** — one event per record, at `performed_at`, with
  type, title, parts, and performer.
- **Incident events** — every append-only event from every incident on the
  machine (created, status/issue-status changes, root-cause/fix/action
  events, close/reopen/cancel, reindex, similar search), at the event's own
  timestamp, annotated with the incident number.

Both are filtered to the caller's organization — a cross-org machine id is
404, and no event from another organization can ever appear.

## 3. Ordering and bounds

- Events are merged and sorted newest-first by `at`.
- The result is capped at `limit` (default 100, max 200).
- The incident-title prefix includes the incident number
  (“status_changed — INC-2026-000042”) so the timeline reads without a join;
  incident events link to the incident detail page.

## 4. Frontend

`/machines` lists machines (asset tag, display name, model, open timeline
link). `/machines/:id` renders the merged timeline with three filter tabs
(All / Maintenance only / Incidents only), status transitions shown as
`previous → next`, and the non-causal caption under every maintenance event.

The incident detail page's machine field links here, closing the loop
between an incident and the machine's full history.

## 5. Why a merged view

Troubleshooting asks “what has happened to this machine?”. Incidents answer
with faults; maintenance answers with work performed. Showing them on one
timeline is the whole point of the machine-memory story — while keeping the
two evidence classes visually and semantically distinct (different labels,
different captions, never conflated).
