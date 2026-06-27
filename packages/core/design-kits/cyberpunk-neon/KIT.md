---
id: cyberpunk-neon
name: Cyberpunk Neon
aesthetic: Dark futuristic HUD — neon magenta/cyan, glow, glitch, angular tech.
tags: [cyberpunk, neon, futuristic, hud, gaming, dark]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Gaming, crypto/web3, music/streaming, esports, bold tech product launches.
version: 1.0.0
---

# Cyberpunk Neon

## Overview
A dark, high-energy HUD: inky backgrounds drenched in neon magenta and cyan, glowing
borders and text, angular/clipped panels, scan-grid backdrops, and tasteful glitch.
Reads futuristic and loud. The discipline is contrast: neon only POPS against deep dark,
and text must stay readable despite the glow.

## Rules
1. Dark-first, very dark base; neon magenta + cyan (+ optional electric yellow) as the only chroma.
2. Glow = outer + text shadow on accents/active states, never on body copy.
3. Angular geometry: clipped corners (notched/`clip-path`), thin neon outlines, HUD frames.
4. Backdrop texture: faint scan-grid / perspective lines, subtle noise.
5. Glitch sparingly (hover/transition), and behind a `prefers-reduced-motion` guard.
6. Keep AA: neon on near-black is fine; never neon-on-neon for text.

## Color
- Dark: bg `oklch(16% 0.03 280)`, panel `oklch(20% 0.04 285)`, magenta `oklch(68% 0.27 350)`,
  cyan `oklch(78% 0.16 200)`, yellow `oklch(88% 0.18 100)`, fg `oklch(94% 0.02 280)`.
- Light ("daylight HUD"): bg `oklch(96% 0.02 280)`, fg `oklch(20% 0.04 285)`, same accents at lower lightness.

## Typography
- Display: Orbitron / Rajdhani / Chakra Petch (techy). Body: Inter / Rajdhani. Wide tracking on labels, uppercase.

## Components
**Do**
- Clipped-corner cards/buttons with neon outline + inner glow; HUD corner brackets.
- Neon underline/scanline on active nav; glitch text on hover; animated grid background.
- Status with neon dot + uppercase label; progress bars with glow fill.

**Don't**
- Don't glow everything (visual noise). Don't put glowing neon under long-form text. No pastels.

## Motion
- Quick, electric: 100–160ms; glitch jitter on hover, scanline sweep, flicker-in.
- Reduced-motion: drop glitch/flicker; keep static neon + instant transitions.

## Stack: web
- Tailwind v4 dark; `clip-path` notched corners; neon via `box-shadow`/`text-shadow` + ring; grid bg via
  `background-image` linear-gradients; glitch keyframes guarded by `prefers-reduced-motion`.

## Stack: react-native
- Dark theme; neon borders + `shadowColor` glow; angular shapes via `react-native-svg` clip; Reanimated glitch;
  gradient/grid backdrop with svg.

## Stack: flutter
- Dark `ColorScheme`; `ClipPath` notched corners; neon `BoxShadow` glow; `CustomPaint` grid backdrop;
  glitch via `AnimationController`.

## Stack: swiftui
- `.preferredColorScheme(.dark)`; custom `Shape` clipped corners; neon `.shadow` glow + `.overlay` stroke;
  `Canvas` grid; honor Reduce Motion.

## Stack: compose
- `darkColorScheme`; custom `Shape` (CutCornerShape) + neon shadow/border; `Canvas` grid backdrop;
  glitch via `rememberInfiniteTransition`.
