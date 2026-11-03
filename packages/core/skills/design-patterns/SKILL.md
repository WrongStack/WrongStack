---
name: design-patterns
description: "UI pattern catalog by stable id: app shells, landing sections, navigation, tables, forms, wizards, empty, loading and error states. Use to choose or adapt a layout, page section, navigation, data display, form flow or feedback state — hero, pricing page, dashboard, admin console, settings, onboarding, checkout, toast vs banner, bento grid, sidebar vs top nav, command palette — or to name the pattern a reference site uses. Not for visual styling (use design-craft) or tokens (use design-system)."
version: 1.0.3
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [web.research, browser.interact]
trigger: "Use when a region's structure must be chosen, adapted, verified or identified by a stable pattern id with measurable checks."
metadata:
  routing-group: design
---

# Design Patterns — WrongStack

## Selection card
- Task: Pick, adapt, verify or identify a UI pattern for a concrete surface.
- Start: Split the surface into regions and write, per region, the one-line job, the content shape and the density it needs.
- Finish: One pattern id per region, adapted only along its declared Variables, passing its Accept checks.

## Overview

A pattern is a solved arrangement for a recurring job. This catalog describes each
one with numbers and observable checks instead of adjectives, so the same pattern
produces the same structure whichever model applies it. It decides *structure*;
visual direction, type, color and copy stay with the sibling skills.

## How this skill relates to the design series

| Need | Skill |
|---|---|
| Visual direction, brief, build loop | design-craft |
| Which structure fits this job (this skill) | design-patterns |
| Tokens, kits, themes | design-system |
| Scored audit of an existing surface | design-critique |
| Implement a supplied reference | design-to-code |
| Measure a live site and name its patterns by these ids | design-reference-read |

Do not restate design-craft guidance here. Load it when needed, e.g.
`skill({ name: "design-craft", resource: "references/composition.md" })` for grid,
rhythm and focal point, `references/typography.md` for measure and ramps,
`references/slop-inventory.md` for generated-default tells.

## Reading a pattern block

Every pattern uses the same fields: **Job**, **Anatomy** (parts marked
*invariant* must stay), **Measures**, **Use when / Avoid when**, **Variables**
(the only things you may change), **Failure modes**, **Accept**, and
**Seen as (DNA signals)**, which are layout measurements a rendered page or an
extraction pass would expose.

Conventions used in Measures:
- "Step" means a step on the project's spacing scale (a typical 4px-based scale is
  4, 8, 12, 16, 24, 32, 48, 64, 96). "+2 steps" means two positions up the scale.
- Breakpoints are written as the container width where the layout must reflow.
  Content decides the real breakpoint; listed widths are common conventions, not rules.
- Ranges are conventions unless a source (WCAG, platform guideline) is named.
  Treat a value outside the range as a prompt to justify, not an automatic defect.
- Touch targets: WCAG 2.2 SC 2.5.8 sets a 24×24 CSS px minimum; Apple HIG
  recommends 44×44 pt and Material 48×48 dp. Use 44px or more for primary touch controls.

## Selection procedure a small model can follow

1. **Name the region.** Split the surface into regions (shell, navigation, primary
   content, secondary content, feedback). Select one pattern per region; never one
   pattern for a whole product.
2. **Write the job in one line**: "<user> needs to <verb> <object> while <constraint>".
   If you cannot, ask or record an assumption before choosing anything.
3. **Classify content shape**, choosing exactly one:
   prose · list of comparable items · records with many attributes · a single
   object being edited · a sequence of steps · a status/metric summary · a
   persuasive narrative.
4. **Classify density**: compact (scan many rows), cozy (product UI, forms),
   comfortable (reading, marketing, mobile).
5. **Filter the index** below to the reference file for that region, then keep
   only patterns whose **Use when** matches your answers to steps 2–4 and whose
   **Avoid when** does not. Shortlist at most 3 ids.
6. **Pick one** with a stated reason in this form:
   "`<id>` because <job/content/density fact>; rejected `<id2>` because <its Avoid-when hit>".
   If two remain tied, prefer the one with fewer anatomy parts.
7. **Adapt** by changing only the listed Variables. If the design needs an
   invariant part removed, you chose the wrong pattern: return to step 5.
8. **Fill with real or labelled content.** Never fabricate logos, testimonials,
   customer counts, ratings or awards to complete an anatomy slot; drop the slot
   or mark it as a placeholder the user must supply.
9. **Verify** every Accept check for the chosen pattern at a desktop width, at
   320–390px wide, and on a short viewport (around 600–700px tall). Record which
   checks were observed and which were not.
10. **Report** region → id → reason → Accept results.

## Adapting without breaking the pattern

- Invariants carry the pattern's usability; Variables carry the product identity.
  Distinctiveness comes from content, type, color and the chosen Variables, not
  from deleting invariants.
- A product may combine patterns across regions (`sidebar-console` shell +
  `data-table` content + `empty-state` feedback). Keep each region's Measures.
- When a trend is requested, map it onto an evergreen id first
  (see `references/trends-dated.md`), then apply the trend only to Variables.

## Identifying a pattern on a reference

When a reference site is measured (design-reference-read, a screenshot or DOM
inspection), compare observations against each candidate's **Seen as** signals.
Name an id only when at least two of its signals are observed; otherwise say
"resembles `<id>`" and list which signals were and were not seen. Never infer a
pattern from a brand name or a memory of the site; measure the current page.

## Pattern index

| Id | Reference file |
|---|---|
| `app-shell`, `sidebar-console`, `split-pane`, `holy-grail`, `editorial-column`, `bento-grid`, `catalogue-grid`, `masonry-grid`, `canvas-tool-chrome` | `references/page-layouts.md` |
| `hero-claim-product-shot`, `hero-split`, `hero-demo-first`, `hero-editorial`, `proof-strip`, `feature-zigzag`, `feature-sticky-narrative`, `feature-tabbed`, `pricing-table`, `faq-accordion`, `cta-band`, `site-footer` | `references/landing-sections.md` |
| `top-bar-nav`, `sidebar-nav`, `command-palette`, `tabs`, `segmented-control`, `breadcrumbs`, `bottom-tab-bar`, `mega-menu` | `references/navigation.md` |
| `data-table`, `kpi-tiles`, `card-collection`, `row-list`, `list-detail`, `activity-timeline`, `chart-panel` | `references/data-display.md` |
| `single-column-form`, `multi-step-wizard`, `inline-edit`, `onboarding-checklist`, `auth-screen`, `checkout-flow`, `settings-page` | `references/forms-and-flows.md` |
| `empty-state`, `loading-skeleton`, `error-state`, `success-confirmation`, `partial-state`, `offline-state`, `toast-notification`, `page-banner`, `inline-message`, `destructive-confirm`, `undo-action` | `references/feedback-states.md` |
| Dated visual trends (`trend-*` ids) mapped onto the ids above | `references/trends-dated.md` |

Load a file with `skill({ name: "design-patterns", resource: "references/<file>.md" })`.

## Quick region → candidates map

| Region / job | Start the shortlist with |
|---|---|
| Daily-use tool with many sections | `sidebar-console`, `app-shell` |
| Browse items, open one | `list-detail`, `split-pane`, `catalogue-grid` |
| Long reading | `editorial-column` |
| Persuade and convert | `hero-*`, `feature-*`, `pricing-table`, `cta-band` |
| Compare many records | `data-table` |
| Summarize health/metrics | `kpi-tiles`, `chart-panel` |
| Collect input | `single-column-form`, `multi-step-wizard`, `inline-edit` |
| First-run activation | `onboarding-checklist`, `empty-state` |
| Tell the user something changed | `inline-message`, `toast-notification`, `page-banner` |

## Acceptance checks

- [ ] Every region names exactly one pattern id with a one-line job/content/density reason and a rejected alternative.
- [ ] No invariant anatomy part was removed; every customization is restricted to the pattern's declared Variables.
- [ ] The chosen pattern's Accept checks were verified on a rendered surface at desktop, narrow (`320–390px`), and short (`600–700px`) viewports, or explicitly marked unverified.
- [ ] Zero anatomy slots are filled with fabricated customer logos, testimonials, ratings, or metrics.
- [ ] Any dated visual trend (`trend-*`) is mapped onto an evergreen pattern id with its usability trade-offs stated.

## Skills in scope

- `design-craft` — visual direction, typography, color hierarchy, composition and iterative build loop.
- `design-system` — semantic design tokens, kits, themes and reusable component primitives.
- `design-critique` — scored visual and structural audit of an existing or newly built surface.
- `design-to-code` — faithful implementation of a supplied screenshot, mockup or live reference.
- `design-reference-read` — extract measured design DNA from a reference URL or screenshot and map signals to these pattern ids.
