# FRONTEND_RESPONSIVE_DESIGN.md

The workspace targets desktop, laptop, shop-floor tablet and phone.

## Breakpoints

- **≥1024px**: fixed 248px sidebar + content column; multi-column stat grids
  and dashboard cards (`auto-fit, minmax`).
- **<1024px**: sidebar becomes a slide-in drawer (280px) opened with a
  hamburger button in the topbar; a dimmed backdrop closes it; navigation also
  closes automatically on route change.
- **<640px**: form grids stack to one column; the user's name collapses in the
  topbar (avatar remains); page padding tightens.

## Component behaviour

- **Tables** never crush below readability: they sit in `.table-wrap` and
  scroll horizontally on narrow screens; cells keep their content on one line
  where possible (badges, tags, mono IDs).
- **Forms**: `.form-grid` is two columns on wide screens, one on small.
  Required markers and inline errors stay adjacent to their field.
- **Chat interface**: the message column flexes; the composer remains at the
  bottom; evidence citations stack; action buttons wrap.
- **Dialogs**: modals become full-width with 90vh scrollable bodies on small
  screens; drawers take 94vw.
- **Timelines** (incident audit, machine activity, root-cause history) stack
  vertically with the connector line; text wraps rather than clipping.
- **Page headers**: title and action buttons wrap; the stat grid reflows from
  four columns to one as the viewport narrows.
- **Filter bars** wrap into a vertical stack and search inputs grow.

## Technician usability

- Tap targets ≥40px; high-contrast dark theme works under bright shop light;
  statuses always include an icon and text, not colour alone.
- No controls depend on hover; every action is keyboard reachable.
