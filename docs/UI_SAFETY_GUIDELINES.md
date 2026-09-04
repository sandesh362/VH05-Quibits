# UI Safety & Presentation Guidelines

The rules every surface follows, and the reasons behind them. These exist so
the interface cannot accidentally imply a certainty the system does not have.

## 1. Evidence lanes are never distinguished by colour alone

Shop-floor screens wash out; ~8% of male technicians have a colour vision
deficiency; a static screenshot must convey the class of every block.

| Lane | Chip text | Border / background | Caption |
|---|---|---|---|
| Manual | `Manual` | neutral, solid | *(none needed — authoritative)* |
| Historical incident | `Historical` | amber | “does not prove the current diagnosis” |
| Maintenance | `Maintenance` | blue | “never causally linked to this fault” |

Every lane also appears in the **lane legend** at the top of the
conversation, so the distinction is visible before any message is read.

## 2. Status is colour + icon + text

`StatusBadge` and the incident badges render an icon, a label, and a colour
class together — never colour alone, and unknown values fall back to a
neutral presentation instead of crashing a list.

## 3. The safety disclaimer is persistent and non-dismissible

Rendered by the app shell on every page, for every auth state. It must never
be collapsible, dismissible, or behind a scroll. Text (verbatim):

> **Safety notice:** answers are generated from your indexed manuals and are
> fallible. Always verify against the machine documentation before acting —
> manual evidence is authoritative; historical and maintenance context is
> supplementary and never proves a diagnosis.

## 4. Honesty rules for AI content

- Suggestions are labelled `(suggested)` and sit apart from technician
  actions; a suggestion is never rendered as performed work.
- A historical incident's confirmed fix is context, never a prescription —
  the disclaimer on the similar-incidents panel says so.
- Maintenance is never rendered without the non-causal caption.
- The chat renders refusals (`insufficient_evidence`,
  `conflicting_evidence`, `generation_failed`) with the backend's exact
  reason — never softened into an answer.

## 5. Errors carry the request id

`ErrorState` shows the failure code and the server's `requestId` (when the
client received one). Support can correlate a screenshot with the audit
trail; the error is never replaced with generic text.

## 6. Citations land on the real source

Clicking a manual citation opens the **exact stored chunk** (section path,
pages, text) with a provenance note. Where the deployment has no page
images, the modal says so instead of showing a placeholder. Historical and
maintenance citations open lane-specific metadata views.

## 7. Accessibility & motion

- Modals: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, labelled
  close buttons.
- Loading/empty/error states are announced (`role="status"`,
  `aria-live="polite"`, `role="alert"`).
- `:focus-visible` outlines and `prefers-reduced-motion` are global.
- Primary actions are real buttons with large touch targets; tables scroll
  horizontally on narrow screens; forms stack to one column on phones.

## 8. Nothing is fabricated

- The home page renders feature flags reported by the backend.
- The status page renders real dependency probes.
- The retrieval trace renders stored counts only; missing data shows
  “not recorded”.
- The jobs page renders the real processing queue.
