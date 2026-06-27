---
id: dark-academia
name: Dark Academia
aesthetic: Scholarly vintage — sepia, oxblood, serif, candlelit library mood.
tags: [dark-academia, vintage, scholarly, serif, moody, literary]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Literary brands, education, journals, museums, bookish/intellectual products.
version: 1.0.0
---

# Dark Academia

## Overview
The mood of an old candlelit library: deep browns and oxblood, aged-paper sepia, classic
serif typography, brass accents, and vintage texture. Scholarly, romantic, and moody. Rich
darks with warm low light; ornamental restraint; everything feels printed and old-world.

## Rules
1. Warm dark palette: espresso, oxblood, forest, aged gold; sepia papers in light mode.
2. Classic serif (Garamond/Caslon) for body + display; literary hierarchy.
3. Vintage texture: aged paper, subtle vignette, ink stains, fine rules.
4. Brass/gold fine accents; ornamental dividers used sparingly.
5. Low, warm contrast lighting — moody but still AA for text.
6. Imagery: classical, sepia-toned, etchings.

## Color
- Dark: bg espresso `oklch(24% 0.02 60)`, fg parchment `oklch(88% 0.03 85)`, oxblood `oklch(40% 0.12 25)`, brass `oklch(72% 0.09 85)`, forest `oklch(45% 0.07 150)`.
- Light: aged paper `oklch(92% 0.02 85)`, ink `oklch(28% 0.03 60)`, oxblood/brass accents.

## Typography
- Serif throughout: EB Garamond / Cormorant / Caslon. Italics for emphasis; small caps labels.

## Components
**Do**
- Serif text blocks, ornamental rules, framed/etched imagery, oxblood buttons with gold edge, paper texture.
**Don't**
- No bright/neon color, no flat tech sans, no harsh contrast. Keep it warm and printed.

## Motion
- Slow, candlelit: gentle fades, soft vignette pulse. 300–500ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 warm-dark tokens; serif var; paper texture + vignette overlay; ornamental SVG rules; oxblood/gold buttons.
## Stack: react-native
- Warm-dark theme; serif via expo-font; paper texture; oxblood buttons; vignette overlay.
## Stack: flutter
- Warm-dark `ColorScheme`; `google_fonts` Garamond; paper texture image; ornamental `CustomPaint` rules.
## Stack: swiftui
- Warm-dark asset colors; serif `Font`; paper texture; vignette `.overlay`; small-caps labels.
## Stack: compose
- Warm-dark M3; serif `FontFamily`; paper texture; ornamental dividers.
