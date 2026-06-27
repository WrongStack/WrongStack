---
id: monochrome
name: Monochrome
aesthetic: Strict black & white + one accent — gallery-grade contrast, photography-forward.
tags: [monochrome, black-and-white, gallery, portfolio, high-contrast, minimal]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Photography, portfolios, galleries, fashion lookbooks, bold minimal brands.
version: 1.0.0
---

# Monochrome

## Overview
Pure black and white with a single, deliberate accent used almost like punctuation.
Maximum contrast, gallery-grade restraint: imagery and typography carry everything,
the UI is reduced to type, rules, and space. Bold size contrast, full-bleed media,
and confident negative space. The accent appears rarely — and therefore lands hard.

## Rules
1. Grayscale system only (true black → true white) + ONE accent used sparingly.
2. Maximum, intentional contrast; no mid-gray mush for text.
3. Imagery is hero: full-bleed, edge-to-edge, often duotone/B&W; text overlays with care.
4. Big type-size contrast (tiny labels vs huge display); thin rules for structure.
5. The accent is punctuation — a link, an active state, one CTA — never decoration.
6. Switching light/dark is a true invert of the system (black↔white), accent constant.

## Color
- Light: bg `oklch(100% 0 0)`, fg `oklch(12% 0 0)`, hairline `oklch(85% 0 0)`, accent (choose one) e.g. electric `oklch(60% 0.24 25)`.
- Dark: bg `oklch(10% 0 0)`, fg `oklch(98% 0 0)`, hairline `oklch(30% 0 0)`, same accent.

## Typography
- A strong grotesque or a high-contrast serif — pick ONE and commit. Inter/Helvetica or a Didone for display.
- Extreme size range; tight display leading; small letter-spaced labels.

## Components
**Do**
- B&W cards = type + hairline + space; buttons solid black/white invert; accent only on the primary CTA/links.
- Full-bleed image grids; duotone hover; oversized headlines; numbered indices.

**Don't**
- No gradients, no colored surfaces, no soft shadows. Don't dilute with multiple accents or grays-as-color.

## Motion
- Crisp: 120–200ms ease; image reveals (clip/scale), invert on hover; accent draws in.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 grayscale + one accent token; invert button styles (`bg-black text-white` ↔ dark);
  full-bleed image grids; duotone via `mix-blend`/filter; Motion clip reveals.

## Stack: react-native
- Pure B&W theme + single accent; invert buttons; full-bleed `Image` grids; crisp fades; minimal chrome.

## Stack: flutter
- Grayscale `ColorScheme` + one accent; invert `FilledButton`; full-bleed `Image`; duotone via `ColorFiltered`;
  crisp `tween`.

## Stack: swiftui
- Black/white asset colors + one accent `.tint`; invert button styles; full-bleed imagery; `.colorMultiply` duotone.

## Stack: compose
- B&W `ColorScheme` + single accent; invert buttons; full-bleed `Image`; `ColorMatrix` duotone; crisp animations.
