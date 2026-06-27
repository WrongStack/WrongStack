---
id: kids-bright
name: Kids Bright
aesthetic: Playful children's — primary brights, big rounded shapes, mascots, joyful.
tags: [kids, children, education, bright, playful, mascot]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Kids' apps, educational games, children's products, family/parenting, learning tools.
version: 1.0.0
---

# Kids Bright

## Overview
Joyful and safe for young users: bright cheerful colors, big rounded shapes, friendly
mascots, oversized tappable controls, and clear simple iconography. Designed for small
hands and developing readers — large targets, minimal text, lots of visual cues, and
delight at every interaction.

## Rules
1. Bright, cheerful primary/secondary palette; high saturation but warm, not harsh.
2. BIG everything: oversized buttons, large icons, huge tap targets (≥56px) for small hands.
3. Rounded, soft, friendly shapes; a recurring mascot/character.
4. Minimal text; rely on icons, color, and illustration; simple one-action screens.
5. Generous spacing; clear, immediate, rewarding feedback (sounds/animation/stars).
6. Safe contrast + legibility for emerging readers; avoid tiny or thin type.

## Color
- Light: bg `oklch(98% 0.02 95)`, red `oklch(66% 0.2 25)`, yellow `oklch(88% 0.18 95)`, blue `oklch(68% 0.16 240)`, green `oklch(78% 0.18 150)`, purple `oklch(68% 0.16 300)`, fg `oklch(28% 0.03 280)`.
- Dark: bg `oklch(28% 0.04 270)`, fg `oklch(96% 0.02 280)`, same brights.

## Typography
- Big, rounded, friendly sans (Baloo / Fredoka / Quicksand); large sizes, bold weights.

## Components
**Do**
- Giant rounded buttons with icons; mascot reactions; star/reward feedback; big cards; simple progress; bouncy confetti on success.
**Don't**
- No small/thin text, no muted/dark-serious palettes, no dense layouts, no complex flows.

## Motion
- Big and bouncy: spring scale, wiggle, celebration confetti/stars. 250–400ms overshoot.
- Reduced-motion: gentle fade, no bounce/confetti.

## Stack: web
- Tailwind v4 bright tokens; giant `rounded-full` buttons; mascot SVG/Lottie; Motion springs; confetti; large type.
## Stack: react-native
- Bright NativeWind; huge `Pressable`; Lottie mascot; Reanimated bounce; haptics + sound; confetti.
## Stack: flutter
- Bright M3; large `FilledButton`; Rive/Lottie mascot; spring scale; confetti; big `TextTheme`.
## Stack: swiftui
- Bright asset colors; large buttons; mascot (SpriteKit/Lottie); `.bouncy` springs; sensory feedback; confetti.
## Stack: compose
- Bright M3; large buttons; Lottie mascot; `spring(Bouncy)`; haptics; confetti `Canvas`.
