---
id: dopamine-pop
name: Dopamine Pop
aesthetic: Y2K / dopamine design — saturated color, playful shapes, high energy, joyful.
tags: [y2k, vibrant, playful, gen-z, energetic, fun]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Consumer & social apps, events, music, youth brands, promos that need to feel alive.
version: 1.0.0
---

# Dopamine Pop

## Overview
Maximal joy: saturated "dopamine" color, bold rounded shapes, sticker graphics, and
bouncy motion. Y2K nostalgia (chrome, gradients, stars/sparkles) meets modern polish.
Energetic but still usable — keep one clear path through the noise.

## Rules
1. Saturated, high-energy palette: 2–3 vivid hues that clash on purpose, on a bright or inky base.
2. Big rounded shapes (pill buttons, blobby cards), playful iconography, stickers/emoji accents.
3. Chunky type with personality; oversized headlines; occasional outline/sticker text.
4. Motion is springy and fun — bounce, wobble, confetti on key moments.
5. Keep ONE primary CTA visually dominant despite the energy.
6. Maintain contrast/AA — vivid ≠ unreadable; darken text or add solid chips behind it.

## Color
- Light: base `oklch(98% 0.02 320)`, hot pink `oklch(70% 0.24 350)`, electric blue
  `oklch(68% 0.2 250)`, lime `oklch(85% 0.2 130)`, sunny `oklch(88% 0.18 95)`.
- Dark: inky `oklch(20% 0.05 300)` base, same neons cranked, with glow.

## Typography
- Display: Clash Display / Cabinet Grotesk / a rounded heavy sans. Big, tight, bold.
- Rounded sans body (Nunito / Plus Jakarta). Playful but legible.

## Components
**Do**
- Pill buttons with vivid fills + soft colored glow; blobby cards; gradient/holographic accents.
- Sticker badges, sparkle/star motifs, emoji-scale icons; bold tag chips.
- Hover: bounce/scale 1.05 + glow; click: squish + confetti for celebrations.

**Don't**
- Don't let everything scream equally — one hero CTA. Don't sacrifice readability for saturation.

## Motion
- Springy (overshoot) 250–400ms; wobble/jiggle on tap; confetti/sparkle on success.
- Reduced-motion: drop bounce/confetti, simple fade/scale.

## Stack: web
- Tailwind v4 vivid palette + `rounded-full`; gradient utilities; Motion springs (`type:'spring', bounce:0.5`);
  a confetti lib (canvas-confetti) for celebrations; holographic gradient text via `bg-clip-text`.

## Stack: react-native
- NativeWind vivid tokens; Reanimated `withSpring` bounce; `expo-linear-gradient` pills;
  haptics on tap (`expo-haptics`); lottie/confetti for moments.

## Stack: flutter
- M3 with vivid seed + custom bright scheme; `AnimatedScale`/`SpringSimulation`; `StadiumBorder` buttons;
  `confetti` package; gradient containers.

## Stack: swiftui
- Bright asset colors + gradients; `.buttonStyle` custom pill; spring `.animation(.bouncy)`;
  `.sensoryFeedback`; particle/confetti via `TimelineView`/SpriteKit for big moments.

## Stack: compose
- Vivid M3 scheme; `Modifier.clip(CircleShape)` pills; `spring(dampingRatio = Bouncy)`;
  gradient `Brush`; haptics; confetti via custom canvas.
