---
name: design-system
description: "Design tokens and themes: DESIGN.md, Tailwind v4 @theme, CSS variables, Design Studio kits, light/dark roles, component states. Use when creating or extending a token system, dealing, pinning or tuning a Design Studio kit, adding a theme, or restyling palette, type, spacing, radii or motion across an app; small UI fixes extend the existing system without a kit migration. Not for a one-off artifact theme (use theme-factory) or screen composition (use design-craft)."
version: 2.5.3
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when tokens, themes, DESIGN.md or a Design Studio kit are created, tuned, captured or verified."
metadata:
  routing-group: design
paths: ["DESIGN.md", "design-tokens.*", "design_tokens.dart"]
---

# Design System Engine — WrongStack

## Selection card
- Task: Define shared colors, typography and component tokens.
- Start: Find the token source — `DESIGN.md`, the `@theme` or `:root` block, `theme.ts`/`theme.dart`, or a pinned kit — and the app entry or theme provider that imports it.
- Finish: tokens changed at the source and imported by the app, `design {action:"verify"}` (pinned kit) or the DESIGN.md diff shows no FAIL, and each supported theme was rendered with its contrast pairs checked.

## Overview

Build from a real token source and verify the rendered result. Latest web target
checked 2026-11-02: Tailwind CSS 4.3.3 with CSS-first theme variables.
An existing theme is a valid source; Design Studio is a useful system generator,
not a requirement to replace an established design. When `DESIGN.md` or a
conventional token file (`src/index.css`, `src/theme/theme.ts`,
`lib/theme/theme.dart` and similar) declares at least four colors, Design Studio
names that system instead of dealing kits and checks frontend writes against
it; run capture only for a token source kept at another path.

## Rules

1. Inspect existing tokens, components, framework, fonts, assets, themes and
   .design/rules.md. Preserve the user's explicit brief and reference direction.
2. For a new system, choose a coherent kit/source before broad styling. Tune
   semantic roles, type, spacing, radii, elevation and motion together.
3. Use real token names from generated/source files. Never guess that a kit
   exposes a particular utility or that an unimported token file changes the app.
4. Keep light/dark or other requested themes on shared semantic roles. Ship the
   supported themes rather than inventing an unrequested theme migration.
5. Token adherence is separate from composition, accessibility and interaction
   quality. Scanner percentages are not visual or WCAG certificates.
6. Treat documented accessibility thresholds accurately; target-size AA/AAA and
   project touch preferences differ. Preserve keyboard and reduced-motion behavior.
7. Layer tokens: primitives (raw ramps) → semantic roles (`surface`, `fg`,
   `accent`, `danger`) → component tokens only where a component truly differs.
   Screens reference semantic roles; themes swap semantic values, never primitives' names.

In Tailwind v4, a theme variable that points at another variable belongs in
`@theme inline`, so utilities resolve the runtime value and a `.dark` or
`[data-theme]` override reaches `bg-*`/`text-*`; a dark variant keyed to a class
needs `@custom-variant dark (&:where(.dark, .dark *));`.

## Design Studio loop

For a new kit or authorized migration:

~~~
design {action:"deal", query:"editorial tactile"}
design {action:"use", kit:"<actual-id>", stack:"web"}
design {action:"draw", job:"subscribe", material:"words"}
design {action:"photos", query:"sourdough bakery oven", orient:"landscape"}
design {action:"tune", tune:{radius:"lg", density:"compact", motion:"snappy"}}
design {action:"materialize"}
~~~

The deal draws three kits spread across the 3D coordinate space (`paper/display/accent`)
with a printed seed; kits chosen recently in any project are left out, and `query`
narrows the pool by IDF-weighted domain terms. `draw` deals a job-native page
anatomy (macrostructure, opening hero, nav, sections, footer) from `job` +
`material` (`photo | product | words`) while avoiding recent layouts and the
kit's own specimen (`pictured`). For photo-led pages without user media, `photos`
ranks open-licensed Wikimedia Commons photographs into `<figure data-slot="...">`
markup + `data-credits` attribution; for web kits declaring `photo:` treatments or
`fontLinks`, `materialize` emits compiled `[data-slot]` photo treatment CSS and
font import hints alongside semantic tokens.

When restyling an existing codebase, run `design {action:"snapshot"}` BEFORE
editing UI files to capture routes, form inputs, `data-testid`s, and named
handlers into `.design/before.json`, then run `design {action:"kept"}` after the
redesign to verify zero wiring was silently dropped.

Tune only when needed; use set for explicit brand/semantic overrides.
Supported stacks are web, react-native, flutter, swiftui and compose.
Read the current tool schema and result rather than copying guessed kit ids.

Materialize after final tuning, inspect its actual token exports, and import
the output through the real app entry/theme provider. A force overwrite requires
checking the owned target and preserving existing project customization.

### DESIGN.md (interchange & 10-section specification)

`DESIGN.md` (compatible with both Google `design.md` alpha and the 10-section
`designmd.me` agent prompt specification) carries the system between tools:
- **Export from project:** `design {action:"document"}` (or `/design document`)
  writes the pinned kit with overrides, or captured tokens, as a linted `DESIGN.md`.
- **Extract from live reference:** `design_reference {action:"extract", url, maxPages:6}`
  (or `/design extract <url> 6`) synthesizes `.design/references/<slug>/DESIGN.md`
  with full YAML frontmatter (`colors` incl. `canvas`/`ink`/`body` + decorative
  ramps, `typography` role specs, `rounded`, `spacing`, `shadows`, `themes`
  measured + derived, `gradients`, `components` with `{colors.*}`/`{rounded.*}`/`{typography.*}`
  refs, `states`, `breakpoints`, `coverage`) and the 10-section prompt guide.
- **Import / capture:** `design {action:"capture"}` (or `/design capture [file]`)
  reads `DESIGN.md` first — supporting both `dark-<role>` keys and `themes.dark`
  maps — before inferred CSS/TS/Dart, refusing files with lint errors (broken
  references, duplicate keys/sections).

Before changing a committed DESIGN.md, keep the old version and run
`design {action:"diff", files:["<before>", "DESIGN.md"]}` (one file compares
it with the active kit). FAIL means a text pair lost WCAG AA in a theme or a
component reference stopped resolving; fix it or state the reason in the change.

PRODUCT.md at the project root (audience, primary job, voice, words to avoid)
is injected with the design brief on UI turns. Write it once for a new product;
tokens cannot carry who the interface is for.

## Workflow

1. Establish the existing source or selected kit and explain its fit briefly.
2. Reuse shared primitives. Add missing semantic tokens at the source rather
   than scattering literals across screens.
3. Build loading/empty/error/populated and relevant interactive states. Use
   representative content and long labels.
4. With a pinned kit, run design {action:"verify"} and inspect actual drift.
   Composition heuristics need rendered evidence; do not change useful symmetry
   merely to clear a score.
5. Render affected desktop/narrow/short viewports and supported themes.
   Check focus, contrast, scrolling, reduced motion and task completion.
6. For native stacks, inspect actual theme constants and device evidence;
   a scanner that only understands web classes cannot certify native output.

## Precedence

Follow the user's task and host instructions, then project design rules,
the actual token source and kit defaults. Accessibility requirements should be
implemented and clearly explained; a kit's stylistic preferences do not outrank
the user's chosen outcome.

## Before returning

- [ ] Token source (`DESIGN.md`, project theme file, or pinned kit) and app entrypoint imports are verified; any kit or token changes are intentional.
- [ ] Semantic roles cover light/dark or supported themes without scattering raw hex or pixel literals across screens.
- [ ] Loading, empty, error, disabled, focus-visible, and populated component states are implemented.
- [ ] Scanner and `DESIGN.md` diff/verify findings were checked against the actual source and brief.
- [ ] Rendered viewport, theme, contrast, and interaction evidence is recorded with any unverified surfaces stated explicitly.

## Sources

[Tailwind theme variables](https://tailwindcss.com/docs/theme),
[WCAG 2.2](https://www.w3.org/TR/WCAG22/).

## Skills in scope

- `design-craft` — product-specific visual direction, content hierarchy, and composition
- `design-critique` — scored rendered review separating token adherence from visual craft
- `accessibility` — WCAG 2.2 contrast, target size, focus visibility, and forced-colors checks
- `motion-design` — duration/easing tokens, choreography, and `prefers-reduced-motion` compliance
- `react-modern` — component primitives and state architecture consuming the token system
