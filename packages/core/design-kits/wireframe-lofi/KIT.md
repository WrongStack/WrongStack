---
id: wireframe-lofi
name: Wireframe Lo-Fi
aesthetic: Hand-sketched wireframe — grayscale boxes, scribbles, low-fidelity prototype.
tags: [wireframe, lo-fi, sketch, prototype, grayscale, mockup]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Prototypes, design tools, internal demos, "draft mode", playful sketch-style sites.
version: 1.0.0
---

# Wireframe Lo-Fi

## Overview
The deliberate look of a hand-drawn wireframe: sketchy grayscale strokes, placeholder boxes
with an X for images, squiggle "lorem" lines, hand-lettered labels, and rough rounded corners.
Signals "draft / prototype / work-in-progress" — charming and honest. Great as an intentional
aesthetic or a real low-fidelity mode.

## Rules
1. Grayscale only; everything looks hand-drawn (slightly wobbly strokes, rough corners).
2. Placeholder conventions: boxed image with diagonal cross, squiggle text lines, "Button" labels.
3. Sketchy 1.5–2px strokes; hand-lettered or marker-style font.
4. No color, no real imagery — it's a blueprint of the idea, not the finished thing.
5. Clear structure despite the sketch — hierarchy still reads.
6. Maintain contrast (dark stroke on light) for legibility.

## Color
- Light: paper `oklch(98% 0.002 90)`, stroke `oklch(35% 0 0)`, fill `oklch(92% 0 0)`, muted `oklch(60% 0 0)`.
- Dark: bg `oklch(20% 0 0)`, stroke `oklch(85% 0 0)`, fill `oklch(28% 0 0)`.

## Typography
- Hand-drawn/marker font (Excalifont / Comic-style sketch) or a clean sans labelled "[placeholder]".

## Components
**Do**
- Boxed placeholders (image = box + X), squiggle text lines, sketchy buttons, hand-labelled sections, dashed/rough borders.
**Don't**
- No color, gradients, real photos, or polished shadows. Keep it rough on purpose.

## Motion
- Minimal, sketchy: subtle "draw-in" of strokes; nothing polished. 150–250ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 grayscale + a sketch lib (rough.js) or sketch font + `border-dashed`; placeholder boxes; squiggle SVG lines.
## Stack: react-native
- Grayscale; sketch font; dashed borders; placeholder boxes; squiggle svg.
## Stack: flutter
- Grayscale; sketch `google_fonts`; `CustomPaint` rough strokes; placeholder boxes.
## Stack: swiftui
- Grayscale; sketch `Font`; `Canvas` rough strokes; dashed `.strokeBorder`; placeholders.
## Stack: compose
- Grayscale; sketch `FontFamily`; `Canvas` rough strokes; dashed borders; placeholders.
