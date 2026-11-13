---
id: pixel-8bit
name: Pixel 8-bit
aesthetic: Bitmap UI — fixed palette, hard edges, integer spacing, zero anti-aliasing.
tags: [pixel, 8-bit, retro-game, bitmap, arcade, indie]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Game UIs and game tooling, jam sites, indie communities, and anything that should feel like a cartridge rather than a website.
version: 1.0.0
paper: light 93 110
display: pixel Press Start 2P
accent: warm 30
posture: committed
photo: natural
---

# Pixel 8-bit

## Overview
An interface built on a pixel grid: every measurement is an integer multiple of the
base cell, every edge is hard, nothing is anti-aliased, and the palette is small
enough to name. This is not "retro-flavoured" — the constraints are the design. If
a value cannot land on the grid, the layout changes, not the value.

Distinct from `retro-terminal`, which is phosphor *text* on a CRT. This kit is
pixel *graphics*: blocks, sprites, hard drop shadows, and a bitmap face.

## Rules
1. Everything snaps to the grid. Spacing is 4/8/12/16/24/32/48 **px** — never rem,
   never a fraction, never an arbitrary value.
2. Radius is 0 at every step, pills included. A rounded corner cannot be drawn on
   this grid without anti-aliasing, so it is not drawn.
3. Shadows are hard offsets with zero blur (`4px 4px 0`), in a palette color. They
   read as a second sprite layer, not as light.
4. Borders are 2px or 4px. 1px disappears at the scale this kit is viewed.
5. The palette is fixed and small. Introducing a new hue is a kit change, not a
   component decision.
6. Images render with `image-rendering: pixelated`. A smoothed sprite is a bug.
7. Motion is stepped, never eased — things move in whole cells or not at all.

## Color
Two grounds, both period-correct rather than generic:
- Dark (default): deep indigo ground `oklch(18% 0.02 265)`, surface
  `oklch(24% 0.03 265)`, bone-white fg `oklch(95% 0.02 90)`, bright green primary
  `oklch(72% 0.2 145)`, orange-red accent `oklch(70% 0.2 30)`.
- Light: the handheld-LCD ground `oklch(93% 0.03 110)` with ink
  `oklch(25% 0.04 140)` — a green-grey wash, not white.
- Semantic colors come from the same fixed set; status is icon + text, never hue
  alone (the palette is too small to carry meaning by itself).

## Typography
- Bitmap display face (`Press Start 2P` or equivalent) for headings and labels,
  monospace fallback for body. Bitmap faces are unreadable in long paragraphs —
  body text drops to the mono fallback deliberately.
- Integer sizes only: 10 / 12 / 16 / 20 / 24 / 32 / 48 px. No fluid type, no
  `clamp()` — fractional sizes break the grid.
- Generous line-height (1.6+); bitmap glyphs crowd badly.
- Letter-spacing stays at the face's natural advance. Never track bitmap type.

## Components
**Do**
- Buttons: solid fill, 2px border in a darker palette color, hard `4px 4px 0`
  shadow. Pressed state translates 4px down-right and drops the shadow.
- Panels: filled block, 4px border, hard shadow. Nested panels step the fill.
- Inputs: filled field, 2px border, blinking block cursor.
- Progress: a row of filled cells, not a smooth bar.
- Icons: 8×8 or 16×16 sprites on the grid, never vector line icons.

**Don't**
- No radius, no blur, no gradient, no opacity fade on edges.
- No `1px` anything. No fractional spacing. No smooth easing.
- No bitmap face in a paragraph of body copy — legibility outranks the bit.

## Motion
- Stepped: `steps(4)` or instant. Durations 0–160ms.
- Hover/press moves elements by whole cells (4px, 8px), never by sub-pixel amounts.
- Honor `prefers-reduced-motion`: drop to instant state changes, keep the offsets.

## Stack: web
- Tailwind v4 `@theme`; add `image-rendering: pixelated` globally for `img`.
```css
@theme {
  --color-bg: oklch(18% 0.02 265);
  --color-primary: oklch(72% 0.2 145);
  --radius-lg: 0;
  --shadow-2: 4px 4px 0 oklch(12% 0.02 265);
  --space-4: 16px;
}
img, canvas { image-rendering: pixelated; }
```
- Load the bitmap face with `font-display: block` — a swapped fallback ruins the grid.

## Stack: react-native
- Theme constants plus a numeric `scale` in whole pixels. Shadows are drawn as an
  offset `View` behind the element, because RN shadows always blur.
- `Image` with `resizeMode="contain"` and no smoothing; prefer pre-scaled sprites.

## Stack: flutter
- `ThemeData` with `RoundedRectangleBorder(borderRadius: BorderRadius.zero)`,
  `elevation: 0`, and a manual offset `Container` for the hard shadow.
- `FilterQuality.none` on every `Image` to keep sprites crisp.

## Stack: swiftui
- Asset colors; `.interpolation(.none)` on `Image` for crisp sprites.
- Hard shadow via a second offset `Rectangle` behind the view — `.shadow` blurs.

## Stack: compose
- Material 3 with `RectangleShape`, `tonalElevation = 0.dp`, and a manual offset
  `Box` for the hard shadow. `FilterQuality.None` on `Image`.
