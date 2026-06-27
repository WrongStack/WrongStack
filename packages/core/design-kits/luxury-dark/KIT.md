---
id: luxury-dark
name: Luxury Dark
aesthetic: Opulent dark — jewel tones, gold, velvet depth, premium nighttime elegance.
tags: [luxury, dark, premium, jewel, gold, elegant]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Premium dark-mode products, spirits, jewelry, hospitality, exclusive memberships.
version: 1.0.0
---

# Luxury Dark

## Overview
Opulence after dark: deep velvety grounds (near-black, charcoal, deep plum/emerald), a
restrained gold/champagne accent, jewel-tone highlights, refined serif/sans pairing, and
generous space. Reads exclusive and premium — the dark counterpart to luxury-serif. Subtle
gold linework and soft glow imply quality without shouting.

## Rules
1. Very dark, slightly warm grounds; deep jewel surfaces (plum/emerald/sapphire) for depth.
2. ONE metallic accent (gold/champagne) used sparingly for lines, CTAs, highlights.
3. Refined type: high-contrast serif display + fine sans body; letter-spaced caps.
4. Generous negative space; restrained, never cluttered.
5. Soft gold glow / fine gradients for depth, not heavy shadows.
6. Maintain AA — light text on dark, gold for accents not body.

## Color
- Dark: bg `oklch(16% 0.01 300)`, surface `oklch(20% 0.02 300)`, gold `oklch(80% 0.1 88)`, plum `oklch(35% 0.1 330)`, emerald `oklch(45% 0.09 165)`, fg `oklch(94% 0.01 90)`.
- Light: ivory `oklch(96% 0.01 90)`, deep ink `oklch(20% 0.02 300)`, gold accent.

## Typography
- Display: high-contrast serif (Didot / GT Sectra). Body: fine sans (Inter Light) or refined serif. Letter-spaced caps.

## Components
**Do**
- Gold-line framed cards; champagne CTAs; jewel-tone accents; letter-spaced uppercase labels; soft gold glow; full-bleed dark imagery.
**Don't**
- No bright/neon, no heavy shadows, no clutter, no flat-gray sameness. Keep gold rare.

## Motion
- Slow and refined: gold lines draw in, soft fades, gentle glow pulse. 400–600ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 dark jewel + gold tokens; serif display var; gold 1px borders + soft `box-shadow` glow; letter-spaced caps.
## Stack: react-native
- Dark jewel theme + gold; serif via expo-font; gold-border cards; soft glow; letter-spaced labels.
## Stack: flutter
- Dark jewel `ColorScheme` + gold; `google_fonts` serif; gold `OutlinedButton`; soft `BoxShadow` glow.
## Stack: swiftui
- Dark jewel asset colors + gold tint; serif `Font`; gold stroke cards; `.shadow` glow; tracking caps.
## Stack: compose
- Dark jewel M3 + gold; serif `FontFamily`; gold outline cards; soft glow.
