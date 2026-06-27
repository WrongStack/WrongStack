---
id: frutiger-aero
name: Frutiger Aero
aesthetic: Glossy 2000s optimism — glass, water, sky, bubbles, clean nature-tech.
tags: [frutiger-aero, glossy, 2000s, glass, nature, optimistic]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Nostalgic 2000s revivals, eco-tech, wellness, playful-yet-clean consumer products.
version: 1.0.0
---

# Frutiger Aero

## Overview
The optimistic mid-2000s OS aesthetic (Windows Vista / early iOS / Frutiger): glossy glass
buttons, water droplets and bubbles, clean blue skies and green nature, lens flares, and a
crisp humanist sans. Bright, hopeful, and shiny. Modernize it: keep the gloss tasteful and
the layout clean rather than cluttered.

## Rules
1. Glossy glass UI: top highlight, smooth gradient, soft reflection; rounded "aqua" buttons.
2. Nature + tech imagery: sky blue, leaf green, water; bubbles/droplets, subtle lens flare.
3. Crisp humanist sans (Frutiger/Myriad lineage); clean spacing, optimistic tone.
4. Bright but balanced; white space keeps it from feeling busy.
5. Soft reflections and gentle glow on key elements.
6. Keep AA — text on bright gradients needs a solid backing.

## Color
- Light: sky `oklch(85% 0.08 230)`, fresh green `oklch(75% 0.16 145)`, aqua blue `oklch(68% 0.14 230)`,
  glass white highlight, fg `oklch(25% 0.03 240)`.
- Dark: deep sky `oklch(30% 0.06 240)`, fg `oklch(94% 0.02 230)`, same accents brighter.

## Typography
- Humanist sans (Myriad / Frutiger / Inter). Clean, optimistic, medium weights.

## Components
**Do**
- Aqua glossy buttons (gradient + top highlight + reflection); glass panels; bubble/droplet accents; nature hero imagery.
**Don't**
- Don't clutter (the Vista trap); no flat-only UI; keep gloss subtle and modern.

## Motion
- Smooth, watery: gentle gloss shimmer, bubble float, soft scale. 200–350ms.
- Reduced-motion: static gloss, no float.

## Stack: web
- Tailwind v4 glass gradients + top highlight pseudo-element + reflection; sky/green palette; bubble SVGs.
## Stack: react-native
- `expo-linear-gradient` glossy buttons + highlight overlay; `expo-blur` glass; bubble svg.
## Stack: flutter
- Gradient `Container` + highlight `Stack`; `BackdropFilter` glass; bubble `CustomPaint`.
## Stack: swiftui
- `LinearGradient` glossy buttons + `.overlay` highlight; `.ultraThinMaterial` glass; bubble shapes.
## Stack: compose
- Gradient `Brush` + highlight overlay; translucent glass surface; bubble `Canvas`.
