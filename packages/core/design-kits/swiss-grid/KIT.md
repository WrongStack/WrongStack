---
id: swiss-grid
name: Swiss Grid
aesthetic: International Typographic Style — strict grid, Helvetica, objective, red accent.
tags: [swiss, grid, typographic, minimal, modernist, editorial]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Portfolios, agencies, museums, design-led brands, documentation that values rigor and clarity.
version: 1.0.0
---

# Swiss Grid

## Overview
The International Typographic Style: a rigorous modular grid, objective neutral
typography (Helvetica/Akzidenz lineage), generous white space, flush-left ragged-right
text, and a single bold accent (classically red). Order and hierarchy come from the
grid and type scale alone — no decoration. Reads precise, timeless, and confident.

## Rules
1. Everything snaps to a visible modular grid (12-col, consistent gutters/baseline).
2. Neutral grotesque sans only; objective, not expressive. Flush-left, ragged-right.
3. White space is structural — large margins, clear columns, strong alignment.
4. One accent (red `oklch(55% 0.22 27)`) for emphasis; otherwise black on white.
5. Hierarchy via size/weight/position on the grid, never via color or ornament.
6. Asymmetric balance; align to grid lines deliberately, including imagery.

## Color
- Light: paper `oklch(99% 0 0)`, ink `oklch(15% 0 0)`, accent red `oklch(55% 0.22 27)`, grid hairline `oklch(90% 0 0)`.
- Dark: bg `oklch(14% 0 0)`, fg `oklch(96% 0 0)`, same red (slightly lighter `oklch(62% 0.22 27)`).

## Typography
- Sans: Helvetica Now / Neue Haas Grotesk / Inter as fallback. Tight, neutral.
- Strict modular scale (e.g. 12/16/21/28/37/49). Strong size jumps; few weights (regular + bold).

## Components
**Do**
- Grid-aligned cards/sections; rules (1px) to articulate the grid; numbered/labelled sections.
- Buttons: square-ish, flat, black or red fill; underlined text links.
- Big flush-left headlines spanning grid columns; captions in small grotesque.

**Don't**
- No rounded blobs, gradients, shadows, or centered everything. Don't break the grid for decoration.

## Motion
- Minimal and precise: 120–180ms linear/ease; content snaps in along grid axes.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 with an explicit CSS grid (`grid-cols-12 gap-x-6`); a baseline rhythm; Helvetica/Inter var;
  red accent token; `border` hairlines to express the grid; `text-balance` off (ragged-right is intentional).

## Stack: react-native
- A column system (flex with fixed gutters); grotesque font via expo-font; flat square buttons;
  hairline dividers; left-aligned type hierarchy.

## Stack: flutter
- `LayoutBuilder`/`GridView` modular grid; `TextTheme` neutral scale; `Divider` rules; red `ColorScheme` accent;
  flat `OutlinedButton`/`TextButton`.

## Stack: swiftui
- `Grid`/`LazyVGrid` strict columns; system Helvetica-like font; `Divider()` grid rules; flush-left `Text`;
  red `.tint`; square button styles.

## Stack: compose
- `LazyVerticalGrid` with fixed columns; neutral `Typography`; `Divider`/`HorizontalDivider` rules; red primary;
  flat `OutlinedButton`.
