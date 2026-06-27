---
id: bauhaus
name: Bauhaus
aesthetic: Form follows function — primary red/yellow/blue, circles/squares/triangles, grid.
tags: [bauhaus, modernist, primary, geometric, functional, constructivist]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Design schools, museums, posters, editorial, bold functional brands.
version: 1.0.0
---

# Bauhaus

## Overview
The foundational modernist system: primary red, yellow, blue plus black on white, pure
geometric forms (circle, square, triangle), a strict grid, and functional sans typography.
Nothing decorative — every shape and color is intentional. Bold, timeless, and didactic.

## Rules
1. Primary palette: red/yellow/blue + black + white. Flat, no tints.
2. Pure geometry: circles, squares, triangles as both structure and content.
3. Strict grid; asymmetric balance; diagonal energy allowed.
4. Functional sans (geometric grotesque); strong size contrast.
5. Form follows function — no ornament; color blocks carry meaning.
6. High contrast throughout (AAA easily achievable).

## Color
- Light: bg white `oklch(99% 0 0)`, ink `oklch(15% 0 0)`, red `oklch(58% 0.22 27)`, yellow `oklch(88% 0.18 95)`, blue `oklch(52% 0.18 255)`.
- Dark: bg `oklch(16% 0 0)`, same primaries.

## Typography
- Geometric grotesque (Futura / Geist / a constructed sans); bold, functional, sometimes vertical/rotated.

## Components
**Do**
- Color-block sections, geometric-shape buttons/badges, grid layouts, primary-color CTAs, diagonal accents.
**Don't**
- No gradients, shadows, rounded blobs, or non-primary colors. No ornament.

## Motion
- Geometric and precise: shapes slide/rotate along grid axes. 150–250ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 primary tokens; CSS grid; geometric SVG shapes; color-block sections; Futura/Geist var.
## Stack: react-native
- Primary palette; svg shapes; grid via flex; bold geometric sans.
## Stack: flutter
- Primary `ColorScheme`; `CustomPaint` shapes; `GridView`; geometric font.
## Stack: swiftui
- Primary asset colors; `Shape`/`Canvas` geometry; `Grid`; bold geometric `Font`.
## Stack: compose
- Primary M3; `Canvas` shapes; `LazyVerticalGrid`; geometric `FontFamily`.
