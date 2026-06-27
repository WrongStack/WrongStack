---
id: retro-70s
name: Retro 70s
aesthetic: 1970s funk — burnt orange/mustard/avocado, groovy rounded type, warm earthy.
tags: [retro, 70s, funky, earthy, vintage, groovy]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Music, food/coffee, lifestyle, vintage brands, warm nostalgic marketing.
version: 1.0.0
---

# Retro 70s

## Overview
Groovy 1970s warmth: burnt orange, mustard yellow, avocado green and warm browns, chunky
rounded "groovy" display type, concentric arcs and rainbow stripes, and a sunny earthy mood.
Funky and nostalgic without being kitsch — keep the palette tight and the type bold.

## Rules
1. 70s earth palette: burnt orange, mustard, avocado, cream, warm brown.
2. Groovy rounded/bubble display type; chunky, friendly headlines.
3. Retro motifs: concentric arcs, sunbursts, rainbow stripes, rounded badges.
4. Warm, slightly faded tones; flat fills (no neon, no cold colors).
5. Bold but cozy; generous rounded shapes.
6. Maintain AA — warm tones still need contrast for text.

## Color
- Light: cream `oklch(94% 0.03 85)`, burnt orange `oklch(62% 0.16 50)`, mustard `oklch(78% 0.13 85)`, avocado `oklch(62% 0.1 130)`, brown `oklch(40% 0.06 60)`, fg `oklch(28% 0.04 55)`.
- Dark: warm brown-black `oklch(24% 0.03 55)`, fg `oklch(92% 0.03 85)`, same earthy accents.

## Typography
- Groovy rounded display (Cooper / a 70s bubble face) + warm humanist sans for body.

## Components
**Do**
- Rounded chunky buttons in earth tones; arc/sunburst accents; rainbow-stripe dividers; warm cards; retro badges.
**Don't**
- No cold blues/grays, no neon, no sharp tech edges. Keep it warm and rounded.

## Motion
- Groovy, smooth: gentle bobs, arc sweeps, warm fades. 250–400ms.
- Reduced-motion: static.

## Stack: web
- Tailwind v4 earth tokens; rounded chunky buttons; SVG arcs/sunbursts; rainbow-stripe dividers; groovy display var.
## Stack: react-native
- Earth NativeWind; rounded buttons; svg arcs; warm cards; rounded display font.
## Stack: flutter
- Earth M3 seed; rounded `FilledButton`; `CustomPaint` arcs/sunbursts; groovy `google_fonts`.
## Stack: swiftui
- Earth asset colors; rounded buttons; `Canvas` arcs; groovy `Font`; warm motion.
## Stack: compose
- Earth M3; rounded buttons; `Canvas` arcs/sunbursts; groovy `FontFamily`.
