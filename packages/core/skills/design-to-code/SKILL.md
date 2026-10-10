---
name: design-to-code
description: "Implement supplied Figma designs, screenshots or design specifications as working interfaces. Use when matching a reference or handling design handoff; inspect the actual artifact and preserve its layout, content and interaction intent."
trigger: "Implement supplied Figma designs, screenshots or design specifications as working interfaces. Use when matching a reference or handling design handoff; inspect the actual artifact and preserve its layout, content and interaction intent."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "design"
---

# Design To Code

## Selection card
- Task: Implement a supplied design or Figma reference.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement supplied Figma designs, screenshots or design specifications as working interfaces.

Use the existing framework and latest stable target when a new project or upgrade is requested. A Figma link needs an accessible design source; never pretend to have inspected an unavailable file.

## Rules

1. Identify reference frame, viewport, content and states; distinguish a literal match from an authorized adaptation.
2. Extract reusable roles for typography, spacing, color and assets before creating arbitrary per-element values.
3. Map visual elements to semantic components. A screenshot does not reveal keyboard behavior or data contracts.
4. Verify licensed fonts/assets and available variants; record substitutions with their effect on wrapping and geometry.
5. Prefer existing primitives and tokens. Do not rebuild a design system merely because the handoff uses different names.
6. Preserve real interactions; decorative controls cannot substitute for functioning navigation or forms.

## Workflow

1. Inspect the reference and existing implementation; record key geometry and missing states.
2. Implement structure, then typography/spacing, then color/assets and interactions.
3. Render at the reference viewport and compare alignment, line breaks, density and crop.
4. Check narrow/short viewports and long content rather than inferring responsiveness from one frame.
5. Correct observed differences and document justified adaptations.

## Before returning

Reference access and viewport recorded; assets/fonts verified; rendered comparison and actual interaction checks separated from source inspection.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Figma developer resources](https://developers.figma.com/), [Web layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout).

## Skills in scope

- design-system — tokens and shared component state.
- design-craft — product-specific composition.
- design-critique — rendered evidence and ranked findings.
- interaction-design — task/state transition design.
