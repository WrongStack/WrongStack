---
id: pastel-dream
name: Pastel Dream
aesthetic: Soft dreamy pastels — gentle gradients, airy, ethereal, calm and cute.
tags: [pastel, soft, dreamy, gentle, ethereal, cute]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Lifestyle, journaling, self-care, fashion, gentle consumer and creative apps.
version: 1.0.0
---

# Pastel Dream

## Overview
Soft, ethereal, and gentle: airy pastel gradients (lavender, peach, mint, sky), lots of
white space, rounded shapes, and a light dreamy mood. Calmer than dopamine-pop and softer
than playful-rounded — think cloudscapes and cotton candy. Gentle gradients and generous
air do the work; keep contrast adequate so it stays usable.

## Rules
1. Soft pastel palette: lavender, peach, mint, sky, blush — low saturation, high lightness.
2. Gentle multi-pastel gradients on backgrounds/heroes; airy white space.
3. Rounded, soft shapes; light, feathery shadows; delicate details.
4. Light, friendly type; gentle hierarchy.
5. Dreamy, ethereal mood — soft blur/glow, floating elements.
6. CAREFUL with contrast — pastels are light; darken text or add solid chips to hit AA.

## Color
- Light: bg `oklch(97% 0.02 320)`, lavender `oklch(82% 0.07 300)`, peach `oklch(86% 0.07 50)`, mint `oklch(88% 0.07 160)`, sky `oklch(86% 0.06 230)`, fg `oklch(38% 0.05 300)`.
- Dark: soft dusk `oklch(30% 0.03 290)`, fg `oklch(94% 0.02 300)`, muted pastels.

## Typography
- Light, friendly sans (Quicksand / Poppins Light); soft, airy; optional delicate script accent.

## Components
**Do**
- Pastel-gradient heroes; soft rounded cards with feathery shadow; gentle pill buttons; floating decorative blobs; airy spacing.
**Don't**
- Don't sacrifice contrast (the pastel trap); no harsh/neon color; no heavy shadows.

## Motion
- Floaty and gentle: slow drift, soft fades, dreamy scale. 300–500ms.
- Reduced-motion: static.

## Stack: web
- Tailwind v4 pastel tokens; soft multi-stop gradients; feathery `shadow`; rounded; ensure AA via darker `fg` on light bg.
## Stack: react-native
- Pastel `expo-linear-gradient`; soft shadows; rounded; floating blobs; Reanimated drift.
## Stack: flutter
- Pastel M3 seed; `LinearGradient` heroes; soft `BoxShadow`; rounded; floating `CustomPaint` blobs.
## Stack: swiftui
- Pastel asset colors; `LinearGradient`; soft `.shadow`; rounded; floating shapes; gentle motion.
## Stack: compose
- Pastel M3; gradient `Brush`; soft shadow; rounded; floating `Canvas` blobs.
