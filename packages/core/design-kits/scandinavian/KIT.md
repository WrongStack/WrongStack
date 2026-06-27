---
id: scandinavian
name: Scandinavian
aesthetic: Hygge minimalism — light wood, soft neutrals, cozy, functional, calm.
tags: [scandinavian, hygge, minimal, cozy, neutral, nordic]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Furniture/home, lifestyle, wellness, slow-commerce, calm productivity apps.
version: 1.0.0
---

# Scandinavian

## Overview
Nordic functional warmth: airy off-white/light-wood neutrals, muted dusty accents (sage,
clay, soft blue), natural textures, and clean uncluttered layouts. Cozy minimalism (hygge):
less than minimal-clarity's tech edge, more human warmth. Function and calm above all.

## Rules
1. Light, warm neutrals (off-white, oat, light wood) + one muted dusty accent.
2. Generous whitespace; uncluttered, functional layouts.
3. Soft natural textures (linen/paper) subtly; gentle rounded corners.
4. Muted, low-saturation palette — nothing loud.
5. Quality typography, comfortable reading; warm not clinical.
6. Maintain AA — muted ≠ low-contrast for text.

## Color
- Light: bg oat `oklch(96% 0.01 80)`, fg `oklch(28% 0.02 60)`, sage `oklch(72% 0.05 145)`, clay `oklch(70% 0.07 45)`, soft blue `oklch(72% 0.05 230)`.
- Dark: warm charcoal `oklch(24% 0.01 60)`, fg `oklch(92% 0.01 80)`, muted accents.

## Typography
- Clean humanist sans (Inter / General Sans) + optional warm serif for headings. Comfortable, calm.

## Components
**Do**
- Airy cards with soft radius + subtle shadow; muted accent buttons; light-wood/linen texture backdrops; simple iconography.
**Don't**
- No bright/saturated color, no heavy shadows, no clutter. Keep it warm, not cold-tech.

## Motion
- Calm, slow: gentle fades and soft lifts. 250–400ms ease.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 warm-neutral tokens; soft radius; subtle shadow; linen texture overlay; humanist sans var.
## Stack: react-native
- Warm NativeWind neutrals; soft cards; muted accents; texture backdrops.
## Stack: flutter
- Warm neutral M3; soft `Card`; muted accent; subtle texture image.
## Stack: swiftui
- Warm asset neutrals; soft `RoundedRectangle` cards; muted `.tint`; calm motion.
## Stack: compose
- Warm neutral M3; soft `Card`; muted accent; gentle animations.
