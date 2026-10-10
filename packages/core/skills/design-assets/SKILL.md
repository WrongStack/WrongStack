---
name: design-assets
description: "Prepare icons, SVGs, images, fonts and illustrations for product use with correct rights, formats and rendering. Use when importing, optimizing or generating design assets; preserve an established icon system rather than inventing incompatible replacements."
trigger: "Prepare icons, SVGs, images, fonts and illustrations for product use with correct rights, formats and rendering. Use when importing, optimizing or generating design assets; preserve an established icon system rather than inventing incompatible replacements."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "design"
---

# Design Assets

## Selection card
- Task: Create consistent icons and exportable visual assets.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Prepare icons, SVGs, images, fonts and illustrations for product use with correct rights, formats and rendering.

Choose current supported codecs and asset tools after inspecting the project and target platforms; verify generated/imported assets rather than assuming their suitability.

## Rules

1. Record provenance/license, intended semantic role, display size and supported backgrounds.
2. Preserve vectors for icons/diagrams where practical; use raster assets for photographic or bitmap content.
3. Check SVG viewBox, dimensions, currentColor behavior and external references before embedding.
4. Optimize against measured output size and visible quality; keep editable masters separate from delivery assets.
5. Treat fonts as layout dependencies: license, subsets, weights, language coverage and fallback all affect output.
6. Label generated/demo imagery honestly; do not fabricate customer logos or product evidence.

## Workflow

1. Inventory the existing asset pipeline and naming conventions.
2. Inspect the actual source asset; choose formats/crops/variants from delivery needs.
3. Integrate semantic icons or images with appropriate accessible treatment.
4. Render in supported themes, at small/large sizes and with fallback fonts.
5. Verify dimensions, loading behavior and ownership of source/delivery files.

## Before returning

Rights/provenance recorded; actual assets inspected; theme/size/language variants checked; editable master preserved when required.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[SVG](https://developer.mozilla.org/en-US/docs/Web/SVG), [Responsive images](https://developer.mozilla.org/en-US/docs/Learn_web_development/HTML/Multimedia_and_embedding/Responsive_images).

## Skills in scope

- design-system — tokens and shared component state.
- design-craft — product-specific composition.
- accessibility — keyboard and assistive interaction.
- web-performance — loading and frame measurements.
