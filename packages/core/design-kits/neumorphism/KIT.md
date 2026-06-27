---
id: neumorphism
name: Neumorphism
aesthetic: Soft UI — monochrome extruded surfaces, dual soft shadows, subtle and quiet.
tags: [neumorphism, soft-ui, monochrome, subtle, minimal, tactile]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Calm dashboards, smart-home/IoT controls, music players, minimal utility apps.
version: 1.0.0
---

# Neumorphism

## Overview
"Soft UI": elements appear extruded from — or pressed into — a single monochrome surface,
using paired light + dark soft shadows on a same-tone background. Quiet, modern, tactile.
The classic risk is contrast; this kit fixes it by keeping TEXT and key controls high-contrast
while only containers use the soft effect.

## Rules
1. One background tone; elements raised (outer light+dark shadow) or inset (inner shadows).
2. Same-hue surfaces — the effect IS the differentiation, not color.
3. CRITICAL: text, icons, and primary actions stay high-contrast (AA) — never bury them in same-tone.
4. Soft, large blur shadows; medium radii (12–20px).
5. A single accent only for the primary action / active state.
6. Press toggles raised ↔ inset.

## Color
- Light: surface `oklch(92% 0.004 250)` (the one tone), fg `oklch(28% 0.02 255)`, accent `oklch(60% 0.16 255)`,
  shadow-dark `oklch(80% 0.01 250)`, shadow-light `oklch(99% 0 0)`.
- Dark: surface `oklch(28% 0.01 255)`, fg `oklch(90% 0.01 255)`, accent `oklch(68% 0.15 255)`.

## Typography
- Clean geometric sans (Inter / Poppins). High-contrast text on the soft surface.

## Components
**Do**
- Raised buttons/cards (dual shadow); inset inputs/wells; toggles that depress; soft pill sliders.
**Don't**
- Don't make text low-contrast same-tone (the neumorphism trap); no busy color; no hard borders.

## Motion
- Gentle: raised↔inset transition on press (150–220ms); soft.
- Reduced-motion: instant state swap.

## Stack: web
- Tailwind v4 single surface token + dual `box-shadow` (`-x -y light, x y dark`); inset variant; AA text colors.
## Stack: react-native
- `react-native-shadow-2` / stacked Views for dual shadows; raised/inset toggle on press.
## Stack: flutter
- `Container` dual `BoxShadow` (light + dark offsets); inset via inner-shadow package or layered.
## Stack: swiftui
- `.shadow` light + dark offsets (overlays); inset via inner stroke/blur; accent `.tint`.
## Stack: compose
- Dual `Modifier.shadow`/custom; inset via inner brush; medium `RoundedCornerShape`.
