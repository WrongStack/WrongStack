---
id: luxury-serif
name: Luxury Serif
aesthetic: High-end editorial — black/ivory/gold, elegant serif, vast whitespace, restraint.
tags: [luxury, fashion, elegant, serif, premium, editorial]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Fashion, jewelry, hospitality, real estate, premium brands and portfolios.
version: 1.0.0
---

# Luxury Serif

## Overview
Quiet luxury: a refined palette of ivory, charcoal/black, and a single metallic accent
(gold or champagne), high-contrast serif typography, immense whitespace, and slow,
deliberate pacing. Nothing shouts — confidence comes from restraint, scale, and
impeccable spacing. Big imagery, thin rules, letter-spaced small caps.

## Rules
1. Restrained palette: ivory/off-white, near-black, ONE metallic accent. No bright colors.
2. High-contrast serif display (Didone/transitional) + clean serif or fine sans for body.
3. Vast whitespace; let single elements breathe on near-empty canvases.
4. Letter-spaced uppercase small caps for labels/nav; thin hairline rules for structure.
5. Imagery is full-bleed and premium; minimal UI chrome over it.
6. Subtle, slow motion — elegance, never bounce.

## Color
- Light: ivory `oklch(97% 0.01 90)`, ink `oklch(18% 0.005 60)`, gold `oklch(76% 0.1 85)`, hairline `oklch(88% 0.01 85)`.
- Dark: bg `oklch(16% 0.005 60)` (near-black), fg `oklch(94% 0.01 90)`, champagne gold `oklch(80% 0.09 85)`.

## Typography
- Display: Didot / Playfair Display / GT Sectra (high contrast serif). Body: a refined serif or fine sans (e.g. EB Garamond / Inter Light).
- Large display sizes, tight leading; letter-spaced uppercase labels.

## Components
**Do**
- Thin-outline buttons (1px) with letter-spaced uppercase labels; gold on hover.
- Full-bleed imagery with minimal overlay text; hairline dividers; serif numerals.
- Generous section padding; centered or elegantly asymmetric layouts.

**Don't**
- No shadows-heavy cards, gradients, rounded blobs, or bright accents. No crowding.

## Motion
- Slow, refined: 400–600ms ease; long fades, subtle parallax on imagery; gold underline draws in.
- Reduced-motion: instant, no parallax.

## Stack: web
- Tailwind v4 ivory/black tokens + gold accent; serif display var; `tracking-widest uppercase` labels;
  1px outline buttons; full-bleed `<img>`; Motion slow fades.

## Stack: react-native
- Serif via expo-font; ivory/dark theme; thin-outline buttons; letter-spaced labels; large imagery; subtle fades.

## Stack: flutter
- `google_fonts` Playfair/EB Garamond; ivory `ColorScheme` + gold accent; `OutlinedButton` thin; `letterSpacing` labels;
  full-bleed `Image`.

## Stack: swiftui
- Custom serif `Font`; ivory/dark asset colors + gold tint; `.tracking` uppercase labels; thin `.overlay(stroke)` buttons;
  full-bleed imagery; slow `.easeInOut`.

## Stack: compose
- Serif `FontFamily`; ivory/dark M3 scheme + gold; `OutlinedButton` 1.dp; `letterSpacing` labels; full-bleed `Image`;
  slow `tween`.
