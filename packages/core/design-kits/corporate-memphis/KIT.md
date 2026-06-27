---
id: corporate-memphis
name: Corporate Memphis
aesthetic: Flat humanist illustration — blobby characters, bold geometric, friendly tech.
tags: [illustration, flat, friendly, tech, startup, humanist]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: SaaS marketing, fintech onboarding, blogs, explainer pages, approachable B2C.
version: 1.0.0
---

# Corporate Memphis

## Overview
The ubiquitous "big tech" flat-illustration style (a.k.a. Alegria): friendly blobby
people with exaggerated limbs, flat bold shapes, simple geometric scenes, and a clean,
rounded sans UI. Approachable, optimistic, and instantly legible. The illustration carries
warmth; the UI stays calm and modern around it.

## Rules
1. Flat vector illustration: simple shapes, no gradients/shadows in art, 2–3 brand colors + skin-tone neutrals.
2. Friendly rounded sans UI; generous spacing; soft (not sharp) corners.
3. A confident brand color + 1–2 supporting hues; flat fills.
4. Geometric decorative shapes (circles, arcs, dots) scattered as accents.
5. Clear hierarchy; illustration paired with short, optimistic copy.
6. Keep it tasteful — restraint separates it from cliché.

## Color
- Light: bg `oklch(98% 0.01 250)`, brand indigo `oklch(58% 0.16 270)`, coral `oklch(72% 0.16 35)`, teal `oklch(72% 0.1 190)`, fg `oklch(28% 0.02 270)`.
- Dark: bg `oklch(20% 0.02 270)`, fg `oklch(94% 0.01 270)`, same brand hues.

## Typography
- Rounded geometric sans: Poppins / Circular / Plus Jakarta. Bold headings, friendly body.

## Components
**Do**
- Hero with a flat illustration + headline; rounded cards; pill buttons; arc/dot decorations; icon scenes.
**Don't**
- No realistic photos mixed with the flat art; no harsh corners; don't over-scatter shapes.

## Motion
- Gentle: illustrations parts can drift/wave subtly; cards lift on hover. 200–300ms ease.
- Reduced-motion: static.

## Stack: web
- Tailwind v4 rounded tokens; SVG illustrations; pill buttons; decorative absolute-positioned shapes; Motion soft lifts.
## Stack: react-native
- NativeWind rounded; svg illustrations; pill `Pressable`; gentle Reanimated drift.
## Stack: flutter
- M3 rounded; `flutter_svg` illustrations; `FilledButton` pills; arc/dot `CustomPaint` accents.
## Stack: swiftui
- Rounded design; SVG/vector assets; capsule buttons; decorative `Shape`s; `.fontDesign(.rounded)`.
## Stack: compose
- M3 rounded; vector illustrations; pill buttons; decorative `Canvas` shapes.
