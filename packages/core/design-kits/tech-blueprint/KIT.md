---
id: tech-blueprint
name: Tech Blueprint
aesthetic: Engineering schematic — blueprint grid, cyan linework on navy, technical precision.
tags: [blueprint, technical, engineering, grid, schematic, developer]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Hardware, infra/devtools, robotics, scientific and engineering products.
version: 1.0.0
---

# Tech Blueprint

## Overview
The look of an engineering schematic: deep navy "blueprint" grounds, fine cyan/white
grid lines, technical annotations, dimension marks, and monospace labels. Precise, factual,
and analytical — every element looks measured and drafted. Great for products that signal
engineering rigor.

## Rules
1. Blueprint ground (deep navy) with a fine measurement grid in low-opacity cyan/white.
2. Thin technical linework; dimension lines, brackets, crosshairs, annotations.
3. Monospace for labels/data; clean sans for prose.
4. Cyan/white on navy; one warm accent (amber) for highlights/warnings.
5. Everything aligns to the grid; coordinates/measurements as decoration.
6. High contrast for legibility (cyan/white on navy is strong).

## Color
- Dark: bg navy `oklch(25% 0.06 250)`, grid `oklch(70% 0.08 220 / 0.25)`, cyan `oklch(80% 0.12 210)`, white `oklch(96% 0.01 230)`, amber `oklch(80% 0.14 80)`.
- Light: "whiteprint" `oklch(96% 0.01 230)` bg, navy lines/ink `oklch(30% 0.06 250)`, cyan accent.

## Typography
- Mono (JetBrains Mono / IBM Plex Mono) for labels/data + clean sans (Inter) for body.

## Components
**Do**
- Grid backdrops, annotated diagrams, dimension-line dividers, monospace data tables, crosshair markers, technical cards.
**Don't**
- No rounded blobs, gradients, or soft pastels. Keep linework thin and precise.

## Motion
- Precise: lines draw in, crosshairs snap, grid subtly parallaxes. 150–300ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 navy+cyan tokens; CSS grid backdrop (`background-image` lines); SVG dimension marks; mono labels; thin borders.
## Stack: react-native
- Navy theme; svg grid + dimension marks; mono labels; thin-border cards.
## Stack: flutter
- Navy `ColorScheme`; `CustomPaint` grid + dimension lines; mono `TextStyle`; thin borders.
## Stack: swiftui
- Navy asset colors; `Canvas` grid + crosshairs; monospaced `Font`; thin strokes.
## Stack: compose
- Navy M3; `Canvas` grid/dimension marks; `FontFamily.Monospace`; thin borders.
