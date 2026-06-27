---
id: vaporwave
name: Vaporwave
aesthetic: 80s/90s nostalgia — pink/cyan gradients, retro grid sun, chrome, glitch.
tags: [vaporwave, retro, 80s, nostalgia, synthwave, aesthetic]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Music, art, NFT/web3, retro-themed events, playful nostalgic brands.
version: 1.0.0
---

# Vaporwave

## Overview
A dreamy retro-future: sunset gradients (hot pink → cyan → purple), a glowing perspective
grid, a low retro sun, chrome 3D type, statues/palm motifs, and gentle glitch/VHS texture.
Nostalgic and surreal. Keep UI legible above the busy backdrops with solid panels.

## Rules
1. Signature gradient: magenta → violet → cyan, often dusk-to-night.
2. Perspective grid floor + low sun/horizon as a backdrop element.
3. Chrome/3D display type; occasional Japanese katakana or 90s computer motifs.
4. VHS/glitch + scanlines as light texture, not noise.
5. Neon glow on accents; content panels stay solid for contrast.
6. Maintain AA — overlay text on a translucent dark scrim above gradients.

## Color
- Dark: bg `oklch(22% 0.12 300)`, pink `oklch(70% 0.25 350)`, cyan `oklch(80% 0.14 200)`, purple `oklch(55% 0.2 290)`, fg `oklch(96% 0.03 320)`.
- Light: pastel bg `oklch(94% 0.05 320)`, same hues softened.

## Typography
- Display: chrome/3D serif or retro sans (e.g. a glossy italic). Body: clean sans (Inter). Wide tracking, uppercase headers.

## Components
**Do**
- Gradient hero with grid + sun; chrome buttons; neon-outlined cards; glitch on hover; retro window chrome.
**Don't**
- Don't drown text in gradient; no muted/corporate palettes; keep glitch subtle.

## Motion
- Slow gradient drift, grid scroll toward horizon, occasional glitch jitter. 200–500ms.
- Reduced-motion: freeze grid/gradient, no glitch.

## Stack: web
- Tailwind v4 gradient bg + CSS perspective grid (`background` + `transform`); neon `box-shadow`; glitch keyframes guarded by reduced-motion.
## Stack: react-native
- `expo-linear-gradient` backdrop; svg grid; neon borders; Reanimated drift; glitch on press.
## Stack: flutter
- `LinearGradient` + `CustomPaint` perspective grid; neon `BoxShadow`; `ShaderMask` chrome text.
## Stack: swiftui
- `LinearGradient`/`MeshGradient` + `Canvas` grid; neon `.shadow`; gradient `.foregroundStyle` text.
## Stack: compose
- `Brush.linearGradient` + `Canvas` grid; neon shadow; gradient `Brush` on text.
