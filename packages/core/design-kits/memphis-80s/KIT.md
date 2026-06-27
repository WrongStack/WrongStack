---
id: memphis-80s
name: Memphis 80s
aesthetic: 80s Memphis design — squiggles, confetti, bold primaries, geometric chaos.
tags: [memphis, 80s, geometric, playful, bold, postmodern]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Events, festivals, youth brands, creative agencies, bold playful marketing.
version: 1.0.0
---

# Memphis 80s

## Overview
The postmodern Memphis Group look: clashing bold primaries + black, scattered geometric
confetti (squiggles, triangles, dots, zigzags), terrazzo patterns, and playful asymmetry.
Energetic, fun, deliberately "too much." Keep one clear content path through the chaos so
it stays usable.

## Rules
1. Bold primary palette (red/blue/yellow/teal/pink) + black & white; flat fills.
2. Scatter geometric motifs: squiggles, zigzags, triangles, dots, terrazzo speckle.
3. Asymmetric, playful layout; tilted elements; pattern backgrounds.
4. Chunky type, mixed sizes; black outlines on shapes.
5. Keep ONE clear reading path + obvious CTA amid the decoration.
6. Maintain contrast — text on solid chips, not on busy patterns.

## Color
- Light: bg `oklch(98% 0.01 90)`, red `oklch(62% 0.22 25)`, blue `oklch(60% 0.18 250)`,
  yellow `oklch(88% 0.18 95)`, teal `oklch(75% 0.13 190)`, pink `oklch(75% 0.16 350)`, ink `oklch(15% 0 0)`.
- Dark: bg `oklch(18% 0 0)`, same brights.

## Typography
- Chunky display sans + playful mixed weights; black outlines on headings optional.

## Components
**Do**
- Pattern backdrops; tilted cards with black borders; confetti-shape accents; bold pill buttons; terrazzo fills.
**Don't**
- Don't put text on busy patterns; don't lose the CTA; avoid muted palettes.

## Motion
- Bouncy and playful: shapes wiggle/spin slightly; cards pop in. 180–320ms spring.
- Reduced-motion: static shapes.

## Stack: web
- Tailwind v4 bold tokens; SVG confetti shapes (absolute); tilted `rotate-` cards with `border-black`; pattern bg.
## Stack: react-native
- NativeWind bold; svg shapes; tilted Views; Reanimated wiggle; pattern backdrop.
## Stack: flutter
- Bright `ColorScheme`; `CustomPaint` shapes/terrazzo; `Transform.rotate` cards; bordered containers.
## Stack: swiftui
- Bold asset colors; `Canvas`/`Shape` confetti; `.rotationEffect` cards; black `.border`.
## Stack: compose
- Bright M3; `Canvas` shapes/terrazzo; `Modifier.rotate` cards; border + bold colors.
