---
id: newspaper-print
name: Newspaper Print
aesthetic: Classic broadsheet — multi-column, blackletter masthead, rules, print restraint.
tags: [newspaper, print, editorial, columns, classic, journalism]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: News, journals, magazines, long-form publishing, editorial-heavy products.
version: 1.0.0
---

# Newspaper Print

## Overview
The classic broadsheet: a blackletter or high-contrast serif masthead, dense multi-column
text, hairline column rules, datelines and bylines, drop caps, and a strict print grid on
newsprint-white. Authoritative, content-dense, and timeless. Reads like a real front page.

## Rules
1. Multi-column layout with thin vertical column rules; print grid discipline.
2. Masthead in blackletter or bold high-contrast serif; section kickers in small caps.
3. Serif body, tight leading, justified columns; drop caps on lead stories.
4. Newsprint-white/off-white ground; black ink; one restrained accent (classic red) for breaking/labels.
5. Datelines, bylines, captions, pull quotes — real editorial furniture.
6. High contrast; AA easily met.

## Color
- Light: newsprint `oklch(96% 0.005 90)`, ink `oklch(16% 0 0)`, rule `oklch(80% 0 0)`, accent red `oklch(52% 0.2 27)`.
- Dark: bg `oklch(18% 0 0)`, fg `oklch(94% 0.005 90)`, accent red.

## Typography
- Masthead: blackletter (UnifrakturCook) or Didone. Body: a newspaper serif (Georgia / Source Serif). Small-caps kickers.

## Components
**Do**
- Masthead + dateline; multi-column articles with rules; drop caps; bylines; pull quotes; section dividers; classified-style lists.
**Don't**
- No gradients, shadows, rounded cards, or bright color. Keep it print, not webby.

## Motion
- Minimal: subtle fades only; nothing flashy (print doesn't move). 100–180ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 + CSS `columns` for article bodies; vertical rule borders; drop cap via `::first-letter`; serif/blackletter vars; red accent.
## Stack: react-native
- Serif via expo-font; column-ish layout; hairline rules; drop cap text; red accent.
## Stack: flutter
- `google_fonts` serif/blackletter; multi-column via custom layout; `Divider` rules; drop cap `RichText`.
## Stack: swiftui
- Serif + blackletter `Font`; column layout; `Divider` rules; drop-cap `Text` styling.
## Stack: compose
- Serif/blackletter `FontFamily`; column layout; thin dividers; drop-cap styling.
