---
id: warm-organic
name: Warm Organic
aesthetic: Earthy & natural — terracotta/sage/sand, organic shapes, calm and human.
tags: [organic, earthy, wellness, natural, warm, calm]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Wellness, food, sustainability, lifestyle, skincare, slow-living brands.
version: 1.0.0
---

# Warm Organic

## Overview
Grounded and natural: warm earth tones (terracotta, sand, sage, clay), soft organic
shapes (blobs, arches, rounded asymmetry), gentle grain/paper texture, and a calm,
unhurried rhythm. Feels handmade and human, not corporate. Pairs a warm serif or humanist
sans with lots of breathing room.

## Rules
1. Earthy, warm palette — terracotta + sage + sand + cream; low saturation, high comfort.
2. Organic shapes: blob backgrounds, arch frames, asymmetric rounded cards; avoid rigid grids.
3. Subtle natural texture (paper grain, soft noise) on large surfaces.
4. Generous, relaxed spacing; nothing tight or clinical.
5. Imagery is warm and natural (no harsh stock-blue tech photos).
6. Maintain AA — warm muted tones still need real contrast for text.

## Color
- Light: cream bg `oklch(96% 0.02 85)`, terracotta `oklch(64% 0.13 45)`, sage `oklch(70% 0.06 145)`,
  clay `oklch(60% 0.09 60)`, ink `oklch(30% 0.03 60)`.
- Dark: bg `oklch(24% 0.02 60)` (warm charcoal), fg `oklch(93% 0.02 80)`, terracotta `oklch(68% 0.13 45)`.

## Typography
- Warm serif (Fraunces / Recoleta) for display + humanist sans (Inter / General Sans) for body. Comfortable sizes.

## Components
**Do**
- Arch-topped images, blob backdrops, rounded asymmetric cards; soft buttons with warm fills.
- Pill tags in earth tones; dividers as thin warm lines or hand-drawn strokes.
- Calm hover: gentle warm tint + slight lift.

**Don't**
- No cold blues/grays, no neon, no hard geometric grids or sharp tech edges.

## Motion
- Slow and soft: 250–400ms ease-out; gentle fades and rises; blobs drift subtly.
- Reduced-motion: static, instant fades.

## Stack: web
- Tailwind v4 warm tokens; organic shapes via SVG blobs / `border-radius` asymmetry / `clip-path` arches;
  grain via overlay; serif display var + humanist body; Motion gentle.

## Stack: react-native
- Warm NativeWind tokens; blob/arch via `react-native-svg`; soft shadows; humanist + serif fonts via expo-font.

## Stack: flutter
- Warm M3 seed (terracotta); `ClipPath` arches/blobs; `google_fonts` Fraunces/Inter; soft `BoxShadow`.

## Stack: swiftui
- Warm asset colors; custom `Shape` arches/blobs; Fraunces/serif + system body; gentle `.shadow`; `.bouncy` off (calm).

## Stack: compose
- Warm M3 scheme; custom `Shape` for arches; serif `FontFamily`; soft elevation; slow `tween` animations.
