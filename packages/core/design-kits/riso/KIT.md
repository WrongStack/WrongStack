---
id: riso
name: Riso
aesthetic: Two-drum Risograph print — indigo ink drum + fluorescent pink drum, Cabinet Grotesk 800 over Literata.
tags: [riso, risograph, print, zine, indie, poster, art-book, studio, creative, editorial]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Print studios, independent publishers, art fairs, cultural festivals, creative tools, zines.
paper: light 97 90
display: grotesk-heavy Cabinet Grotesk
accent: chromatic-pink 356
posture: committed
material: uncoated warm stock with zero pure black, medium indigo-blue drum for all type and rules, fluorescent pink drum for fills, multiplied purple intersections, Cabinet Grotesk 800 over Literata, fine ink speck grain
photo: duotone fg surface con=14
pictured: Job Sheet, Stage hero
fontLinks:
  - "https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@800&display=swap"
  - "https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,500&display=swap"
version: 1.1.0
---

# Riso

## Overview
A small-press run pulled from two ink drums and nothing else: warm uncoated stock, an indigo-blue drum that prints every word and rule, and a vivid pink drum for fills — crossing in overprint purple (`mix-blend-mode: multiply`). Cabinet Grotesk 800 display heads pair with Literata optical-size prose.

## Rules
1. Zero neutral grey or pure black: every rule, icon, and paragraph prints in the indigo drum (`fg`); fills and highlights use the pink drum (`primary`/`surface`).
2. Sharp 2px corners (`radius-md`) and zero soft blur shadows; depth comes from overprint multiplication and 2–3px registration offsets.
3. At most ONE focal word in the hero headline may carry a 2px pink registration offset shadow; every other heading stays clean.
4. Photographs print as two-drum duotones (`photo: duotone fg surface con=14`) with Literata captions underneath.

## Surface & Material
- Paper screens (`bg` uncoated stock and `surface` light pink screen) alternate across bands without soft drop shadows.
- Fine SVG `feTurbulence` speck grain overlays solid bands and photographs at 0.08 opacity, never obscuring body text.
- 1.5px rules in `fg` frame price tables, edition sheets, and order forms.

## Range (Non-Photo Sections)
- Two-ink overprint figures: huge Cabinet Grotesk 800 numbers where a multiplied `accent` block crosses part of the glyph.
- Color-separation process strip: blue plate, pink plate, and combined sheet in hairline frames.
- Ruled order/price sheet on the light pink `surface` screen with tabular Literata numerals.

## Controls
- Sharp 2px-radius primary button in `primary` alongside a 1.5px `fg`-outlined secondary button; `:active` shifts `translate(1px, 1px)`.
- Links carry a 2px `accent` underline that thickens to 4px on hover.

## Components
**Do**
- Commit to the two-drum discipline: blue ink for reading, pink screens for fills, multiplied overlaps for depth.
- Keep corners crisp (2px) and copy tactile, concrete, and verb-led.

**Don't**
- Never introduce neutral slate greys, smooth multi-stop gradients, glass blur, or pill radii.
- Never repeat misregistered text on more than one word per page.

## Motion
- One initial registration settle over `duration-slow` (320ms); controls shift 1px on press over `duration-fast`. Static under `prefers-reduced-motion`.

## Build hint
```html
<link href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@800&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,500&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 800; letter-spacing: var(--tracking-tight); line-height: 0.96; color: var(--fg); }
.overprint-chip { background: var(--accent); color: var(--bg); mix-blend-mode: multiply; }
.riso-btn { border-radius: var(--radius-md); border: 1.5px solid var(--fg); padding: 0.625rem 1.25rem; font-family: var(--font-display); font-weight: 800; transition: transform var(--duration-fast) var(--ease-standard), background-color var(--duration-fast) var(--ease-standard); }
.riso-btn:active { transform: translate(1px, 1px); }
a { text-decoration-color: var(--accent); text-decoration-thickness: 2px; }
a:hover { text-decoration-thickness: 4px; }
```

## Stack: web
- Tailwind v4 `@theme` with Cabinet Grotesk 800 + Literata, `mix-blend-multiply` overprint accents, 2px sharp radii, and duotone `[data-slot]` photos.

## Stack: react-native
- 2px sharp `borderRadius`, 1.5px indigo borders, offset registration card shadow, and Cabinet Grotesk / Literata via `expo-font`.

## Stack: flutter
- Two-ink `ColorScheme`, `BeveledRectangleBorder` / 2px `RoundedRectangleBorder`, zero elevation blur, bold display `TextTheme`.

## Stack: swiftui
- 2pt corner radii, 1.5pt indigo strokes, `.blendMode(.multiply)` accent overlaps in light mode, Literata body prose.

## Stack: compose
- `RoundedCornerShape(2.dp)`, `BorderStroke(1.5.dp, fg)`, bold Cabinet Grotesk display headers, and flat two-drum surface cards.
