---
name: design-system
description: "Create and maintain coherent visual tokens, themes and shared component states using the existing project system or WrongStack Design Studio. Use when designing or substantially restyling interfaces, palettes, typography or themes; small UI fixes should extend the existing system without a kit migration."
version: 2.3.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "designing or substantially restyling interfaces, palettes, typography or themes; small UI fixes should extend the existing system without a kit migration."
metadata:
  routing-group: design
---

# Design System Engine — WrongStack

## Selection card
- Task: Define shared colors, typography and component tokens.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build from a real token source and verify the rendered result. Latest web target
checked 2026-10-09: Tailwind CSS 4.3.3 with CSS-first theme variables.
An existing theme is a valid source; Design Studio is a useful system generator,
not a requirement to replace an established design.

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

## Design Studio loop

For a new kit or authorized migration:

~~~
design {action:"list"}
design {action:"use", kit:"<actual-id>", stack:"web"}
design {action:"tune", tune:{radius:"lg", density:"compact", motion:"snappy"}}
design {action:"materialize"}
~~~

Tune only when needed; use set for explicit brand/semantic overrides.
Supported stacks are web, react-native, flutter, swiftui and compose.
Read the current tool schema and result rather than copying guessed kit ids.

Materialize after final tuning, inspect its actual token exports, and import
the output through the real app entry/theme provider. A force overwrite requires
checking the owned target and preserving existing project customization.

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

- Token source and imports verified; kit changes intentional.
- Relevant component/data states implemented.
- Scanner findings checked against actual source and brief.
- Rendered and interaction evidence recorded, with unknowns explicit.

## Sources

[Tailwind theme variables](https://tailwindcss.com/docs/theme),
[WCAG 2.2](https://www.w3.org/TR/WCAG22/).

## Skills in scope

- design-craft — product direction and composition.
- design-critique — rendered review.
- accessibility — input/focus/conformance checks.
- motion-design — motion roles and interruption.
- react-modern — components consuming the theme.
