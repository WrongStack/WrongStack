---
id: nordic-noir
name: Nordic Noir
aesthetic: Moody cinematic — desaturated cold tones, deep shadows, tense minimal.
tags: [moody, cinematic, dark, desaturated, noir, atmospheric]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Film/TV, true-crime, premium editorial, atmospheric brands, moody portfolios.
version: 1.0.0
---

# Nordic Noir

## Overview
Cold, cinematic tension: deeply desaturated blue-gray tones, near-black shadows, a single
cold accent, fog/grain texture, and stark minimal composition. The mood of a Scandinavian
crime drama — restrained, atmospheric, slightly bleak. Big negative space and low-key
lighting carry the drama; one accent cuts through the gloom.

## Rules
1. Desaturated cold palette: slate, gunmetal, fog gray; near-black grounds.
2. One cold accent (icy blue or muted teal) used sparingly.
3. Heavy negative space, stark composition, cinematic crops.
4. Subtle fog/grain/vignette texture; low-key lighting feel.
5. Restrained type; tight, quiet hierarchy.
6. Maintain AA despite the gloom — text stays legible.

## Color
- Dark: bg `oklch(18% 0.01 240)`, surface `oklch(23% 0.012 240)`, fog `oklch(60% 0.02 240)`, ice accent `oklch(72% 0.08 220)`, fg `oklch(88% 0.01 230)`.
- Light: cold paper `oklch(92% 0.005 230)`, slate ink `oklch(30% 0.02 240)`, ice accent.

## Typography
- Restrained grotesque or fine serif; quiet hierarchy; tight tracking.

## Components
**Do**
- Stark full-bleed cinematic imagery (desaturated); minimal cards; thin cold-accent lines; grain/vignette overlays; quiet buttons.
**Don't**
- No warm/bright color, no playful shapes, no heavy ornament. Keep it cold and spare.

## Motion
- Slow, tense: long fades, subtle parallax, grain shimmer. 350–600ms.
- Reduced-motion: instant, no parallax.

## Stack: web
- Tailwind v4 cold-desaturated tokens; grain + vignette overlays; thin ice-accent lines; cinematic full-bleed imagery; slow fades.
## Stack: react-native
- Cold theme; grain overlay; desaturated `Image`; thin accent; slow fades.
## Stack: flutter
- Cold `ColorScheme`; grain/vignette `CustomPaint`; `ColorFiltered` desaturated imagery; thin accent.
## Stack: swiftui
- Cold asset colors; grain `.overlay`; `.saturation(0.6)` imagery; thin accent; slow `.easeInOut`.
## Stack: compose
- Cold M3; grain overlay; desaturated `ColorMatrix` imagery; thin accent.
