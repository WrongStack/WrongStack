---
id: e-ink
name: E-Ink
aesthetic: Paper-like reading — high-contrast grayscale, no glow, calm and legible.
tags: [e-ink, paper, reading, grayscale, minimal, low-distraction]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Reading apps, blogs, documentation, note-taking, focus/distraction-free tools.
version: 1.0.0
---

# E-Ink

## Overview
The calm of an e-reader: pure paper-white (or true dark) with crisp black text, zero glow,
zero color (or one muted accent at most), and typography tuned purely for sustained reading.
Distraction-free, restful, and supremely legible. Looks like ink on paper, not a screen.

## Rules
1. Grayscale only (optionally ONE very muted accent); no saturated color, no glow/shadows.
2. Reading-first typography: serif or high-legibility sans, ~65ch measure, 1.6 line-height.
3. Flat surfaces, hairline rules; no gradients, no elevation.
4. High contrast (near-black on near-white) for effortless reading.
5. Minimal chrome; controls are quiet, text-led, and out of the way.
6. Dark mode is a true high-contrast invert (light text on near-black).

## Color
- Light: paper `oklch(98% 0.002 85)`, ink `oklch(18% 0 0)`, muted `oklch(50% 0 0)`, hairline `oklch(88% 0 0)`, optional accent `oklch(45% 0.04 250)`.
- Dark: bg `oklch(15% 0 0)`, fg `oklch(92% 0 0)`, hairline `oklch(32% 0 0)`.

## Typography
- A reading serif (Newsreader / Source Serif) or a legible sans (Inter); generous measure + leading.

## Components
**Do**
- Long-form text with clear hierarchy; hairline dividers; quiet text buttons; flat lists; toggle for serif/sans + size.
**Don't**
- No color blocks, gradients, shadows, or glow. Don't decorate — clarity is the design.

## Motion
- Minimal/instant — like a page turn at most (subtle fade). 80–150ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 grayscale tokens; reading typography (`prose`); hairline borders; no shadows; serif/sans toggle.
## Stack: react-native
- Grayscale theme; reading `Text` hierarchy; hairline dividers; flat; size/serif toggle.
## Stack: flutter
- Grayscale `ColorScheme`; reading `TextTheme`; `Divider`; flat; `SelectableText`.
## Stack: swiftui
- Grayscale asset colors; reading `Font` + Dynamic Type; `Divider`; flat lists.
## Stack: compose
- Grayscale M3; reading `Typography`; thin dividers; flat surfaces.
