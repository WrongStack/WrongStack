---
id: grid-poster
name: Grid Poster
aesthetic: Big-type poster — oversized headlines, image-led, bold marketing impact.
tags: [poster, big-type, marketing, bold, editorial, hero]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Landing pages, campaigns, events, launches, agency and portfolio hero sections.
version: 1.0.0
---

# Grid Poster

## Overview
Graphic-design poster energy on screen: oversized type that spans the viewport, a strong
underlying grid, big full-bleed imagery, and high-impact contrast. Built to stop the scroll
and make a statement. Type is the hero — set it huge, tight, and confident, anchored to a
visible grid with one bold accent.

## Rules
1. Oversized display type (viewport-scale headlines) set tight; type is the primary visual.
2. Strong visible grid; big full-bleed images; bold asymmetric composition.
3. High contrast; one bold accent against near-mono base.
4. Generous scale jumps (huge headline → small caption); confident whitespace.
5. Marketing rhythm: hero statement → supporting blocks → CTA; each section a "poster".
6. Maintain AA — big type is easy; ensure overlay text on imagery has a scrim.

## Color
- Light: bg `oklch(98% 0.005 90)`, ink `oklch(14% 0 0)`, accent `oklch(60% 0.22 25)` (or any one bold hue), hairline `oklch(86% 0 0)`.
- Dark: bg `oklch(14% 0 0)`, fg `oklch(97% 0 0)`, same bold accent.

## Typography
- A heavy display grotesque (Anton / Druk / Monument); huge sizes, tight tracking. Clean sans for body.

## Components
**Do**
- Viewport-spanning headlines; grid-anchored sections; full-bleed image blocks; oversized CTAs; big numbered indices; bold accent marks.
**Don't**
- No tiny timid type, no busy decoration, no soft pastel palettes. Let type + image dominate.

## Motion
- Bold reveals: big type slides/clips in, images scale on scroll. 250–450ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 huge `clamp()` type scale; CSS grid; full-bleed images; bold accent; `text-balance`; Motion clip/scale reveals.
## Stack: react-native
- Large `Text` scale; grid layout; full-bleed `Image`; bold accent; Reanimated reveals.
## Stack: flutter
- Huge `TextTheme` display; `GridView`/custom; full-bleed `Image`; bold accent; scale-in.
## Stack: swiftui
- Large `Font` display; `Grid`; full-bleed imagery; bold `.tint`; reveal animations.
## Stack: compose
- Large `Typography` display; grid; full-bleed `Image`; bold accent; reveal `tween`.
