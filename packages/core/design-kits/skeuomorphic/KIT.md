---
id: skeuomorphic
name: Skeuomorphic
aesthetic: Real-world textures — leather, metal, felt, realistic depth and materials.
tags: [skeuomorphic, realistic, textured, tactile, retro-ios, depth]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Music/audio apps, games, novelty/retro products, anything that benefits from physical metaphor.
version: 1.0.0
---

# Skeuomorphic

## Overview
The pre-flat era, done tastefully: realistic materials (brushed metal, leather stitching,
felt, glass, wood), real light/shadow that implies physical depth, and controls that mimic
real objects (knobs, switches, sliders, dials). Rich and tactile — best where a physical
metaphor aids understanding (mixers, instruments, tools). Use deliberately, not everywhere.

## Rules
1. Real materials & textures: subtle noise/grain, bevels, gradients implying a light source (top).
2. Controls mimic reality: knobs, toggles, sliders, embossed labels, recessed wells.
3. Consistent global light from top → consistent highlights/shadows.
4. Depth via layered inner/outer shadows + highlights, not flat color.
5. Tasteful, not garish — restraint keeps it premium, not 2008-kitsch.
6. Keep targets large and contrast AA despite textures.

## Color
- Light: surfaces of real materials — graphite metal `oklch(70% 0.01 250)`, leather brown `oklch(40% 0.05 60)`,
  felt green `oklch(45% 0.08 150)`; fg `oklch(20% 0.01 60)`, accent brass `oklch(72% 0.1 85)`.
- Dark: darker metals/leather; warm highlights.

## Typography
- Embossed/letterpress text (subtle inset shadow); classic humanist sans or a slab for labels.

## Components
**Do**
- Knobs/dials, physical toggles, recessed inputs (inner shadow), brushed-metal panels, stitched edges.
- Press = visibly depress (inner shadow deepens); glossy highlights on tappable surfaces.
**Don't**
- No flat solid fills; don't mix flat and skeuo randomly; avoid overdone gloss/bevels.

## Motion
- Physical: knobs rotate, switches flip, surfaces depress on press. 120–220ms with easing that mimics mass.
- Reduced-motion: keep state changes instant (no spin).

## Stack: web
- Tailwind v4 + layered `box-shadow` (inset + outer) + gradient + noise texture image; knobs/sliders via SVG/canvas.
## Stack: react-native
- Texture images + stacked shadow Views; custom knob/slider with Reanimated rotation/gesture.
## Stack: flutter
- `BoxDecoration` gradients + multiple `BoxShadow` + `image` textures; `CustomPainter` knobs/dials.
## Stack: swiftui
- Material textures via images + `.shadow` inner/outer (overlays); custom `Shape`/`Canvas` knobs; gesture rotation.
## Stack: compose
- Gradient + texture `Brush` + layered shadows; `Canvas` knobs/dials; gesture-driven rotation.
