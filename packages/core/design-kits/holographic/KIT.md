---
id: holographic
name: Holographic
aesthetic: Iridescent foil — shifting rainbow sheen, chrome, pearlescent, futuristic premium.
tags: [holographic, iridescent, foil, chrome, futuristic, premium]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Beauty, fashion, music, web3/NFT, product launches, premium-yet-playful brands.
version: 1.0.0
---

# Holographic

## Overview
Iridescent, color-shifting surfaces — like holographic foil or oil-slick: rainbow gradients
that appear to shift with angle, pearlescent sheens, liquid chrome, and soft glow. Futuristic
and luxe-playful. The discipline: iridescence on accents/surfaces only, with calm neutral
content areas so it reads premium, not chaotic.

## Rules
1. Iridescent gradients (multi-hue, smooth) on hero/accents; calm neutral content areas.
2. Pearlescent/chrome sheen with a soft highlight that implies a shifting angle.
3. Soft glow on key elements; rounded, fluid shapes.
4. Restrained text — neutral on solid, iridescence as the "wow" layer.
5. Subtle animated shimmer to suggest the holographic shift.
6. Maintain AA — never put body text directly on the iridescent gradient.

## Color
- Dark: bg `oklch(20% 0.02 280)`, iridescent stops pink `oklch(75% 0.18 350)` → violet `oklch(65% 0.18 300)` → cyan `oklch(80% 0.13 200)` → mint `oklch(85% 0.13 160)`, fg `oklch(96% 0.02 300)`.
- Light: bg `oklch(97% 0.01 300)`, same iridescence, fg `oklch(25% 0.03 300)`.

## Typography
- Clean modern sans (Geist / Inter); optional chrome/gradient display headline only.

## Components
**Do**
- Iridescent hero/cards; chrome buttons with sheen; gradient borders (conic); soft glow; fluid rounded shapes.
**Don't**
- Don't iridescent everything; no body text on the gradient; avoid harsh edges.

## Motion
- Slow shimmer/hue-shift on iridescent surfaces; gentle sheen sweep on hover. 300–700ms loop.
- Reduced-motion: freeze the gradient, no shimmer.

## Stack: web
- Tailwind v4 + conic/linear iridescent gradients with `background-position` animation; `bg-clip-text` chrome; soft glow; reduced-motion guard.
## Stack: react-native
- `expo-linear-gradient` multi-stop + masked text; Reanimated position shimmer; soft shadow glow.
## Stack: flutter
- `SweepGradient`/`LinearGradient` animated; `ShaderMask` chrome text; `AnimationController` shimmer.
## Stack: swiftui
- `AngularGradient`/`MeshGradient` animated; gradient `.foregroundStyle`; `TimelineView` shimmer; `.shadow` glow.
## Stack: compose
- `Brush.sweepGradient` animated; gradient `Brush` text; `rememberInfiniteTransition` shimmer.
