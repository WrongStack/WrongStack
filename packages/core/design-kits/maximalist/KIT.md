---
id: maximalist
name: Maximalist
aesthetic: More is more — layered patterns, rich color, eclectic, expressive abundance.
tags: [maximalist, eclectic, bold, pattern, expressive, rich]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Fashion, art, culture, bold editorial, statement brands unafraid of abundance.
version: 1.0.0
---

# Maximalist

## Overview
Abundant and unapologetic: layered patterns, rich saturated color, mixed type, ornament,
and dense collage-like composition. The opposite of minimalism — yet still curated, with a
governing palette and a clear hierarchy so it reads as intentional maximalism, not mess.

## Rules
1. Rich, saturated palette (4–6 colors) tied together by a governing harmony.
2. Layer patterns, textures, borders, and ornament — but anchor with a strong grid underneath.
3. Mix type styles (serif + display + script) with deliberate hierarchy.
4. Dense, collage-like composition; overlap with intent.
5. Keep ONE clear focal point + reading path amid the abundance.
6. Protect legibility — text on solid panels, AA maintained.

## Color
- Light: bg cream `oklch(96% 0.02 85)`, jewel set: magenta `oklch(60% 0.2 350)`, teal `oklch(60% 0.12 195)`, gold `oklch(80% 0.13 90)`, plum `oklch(45% 0.15 320)`, ink `oklch(20% 0.02 320)`.
- Dark: bg `oklch(20% 0.04 320)`, same jewels brighter.

## Typography
- Mix: a display serif + a bold sans + an accent script. Strong, varied, hierarchical.

## Components
**Do**
- Patterned backdrops, ornate borders/frames, layered cards, bold pull quotes, rich color blocks, collage imagery.
**Don't**
- Don't lose the focal point; don't let text fight patterns; keep an underlying grid.

## Motion
- Lively but layered: parallax patterns, staggered reveals. 250–450ms.
- Reduced-motion: static, no parallax.

## Stack: web
- Tailwind v4 jewel tokens; SVG/CSS patterns; layered absolute decor; mixed font vars; grid anchor; Motion parallax.
## Stack: react-native
- Jewel palette; svg patterns; layered Views; mixed fonts; staggered Reanimated.
## Stack: flutter
- Jewel `ColorScheme`; `CustomPaint` patterns; layered `Stack`; mixed `google_fonts`.
## Stack: swiftui
- Jewel asset colors; `Canvas` patterns; layered `ZStack`; mixed `Font`s.
## Stack: compose
- Jewel M3; `Canvas` patterns; layered `Box`; mixed `FontFamily`.
