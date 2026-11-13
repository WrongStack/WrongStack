---
id: darkroom
name: Darkroom
aesthetic: Warm print-black lab & safelight — hairline Sofia Sans Extra Condensed 200, fibre-white ink, amber safelight.
tags: [darkroom, photography, film, cinema, gallery, exhibition, portfolio, archive, monochrome, material]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Photographers, film & cinema portfolios, print editions, galleries, visual archives, monochrome studios.
paper: dark 13 55
display: display-condensed Sofia Sans Extra Condensed
accent: chromatic-amber 58
posture: restrained
material: warm print-black ground, fine light grain, fibre-white ink, hairline Sofia Sans Extra Condensed 200 capitals over Barlow, zero radius, deep monochrome prints, one amber safelight
photo: mono high=-20 shad=-12
pictured: Photographic, Poster hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Sofia+Sans+Extra+Condensed:wght@200;400&family=Barlow:wght@300;400&display=swap"
version: 1.1.0
---

# Darkroom

## Overview
A photographic print room with the lights off: warm print-black ground (`L=13%`) a step lighter than silver-gelatin blacks so photographs sit on it as physical objects, fibre-white ink, hairline Sofia Sans Extra Condensed 200 capitals at poster scale over calm Barlow 400 prose, zero radius, and one scarce amber safelight.

## Rules
1. Hero heads, section heads, and edition numerals set in Sofia Sans Extra Condensed 200 uppercase (`line-height: 1.0`).
2. Depth comes strictly from tonal lightness steps (`bg` → `surface`), never vignettes, blooms, or shadows.
3. Amber safelight (`primary`/`accent`) touches only the primary button, selected edition cell, and hover underlines — never a section wash.
4. Photographs print deep monochrome (`mono high=-20 shad=-12`) with zero radius, zero border, and plate-number captions beneath.

## Surface & Material
- Warm print-black ground (`bg`) with subtle grained `surface` wells for text-only collector sheets.
- Full-width 1px `--border` hairlines divide edition rows and vertical figure columns.
- Zero border-radius and zero drop-shadows throughout.

## Range (Non-Photo Sections)
- Edition figures set in 200-weight extra-condensed hairline numerals at poster scale parted by vertical hairlines.
- Collector’s specification sheet: full-width hairline rows with muted Barlow labels left and display capitals right.
- Contact-strip process steps (exposed, developed, printed, editioned) in hairline numerals across columns.

## Controls
- 1px ink-outlined square secondary button beside an amber safelight-filled primary (`color: var(--bg)`) in 400 condensed capitals.
- Square 1px-bordered inputs on the dark ground with steady amber focus ring.

## Components
**Do**
- Give monochrome photographs full-bleed or wide column span with generous breathing room.
- Use exact lab/edition facts (series, negative, paper, run size) in captions.

**Don't**
- Never add film-strip sprocket holes, sepia tints, or glowing amber halos.
- Never set display headings in heavy bold weights — hairline 200 is the signature.

## Motion
- Tray-still: single slow opacity/translate settle over `--dur-long`; hover turns plate numbers amber.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Sofia+Sans+Extra+Condensed:wght@200;400&family=Barlow:wght@300;400&display=swap" rel="stylesheet">
```

```css
h1, h2, .figure { font-family: var(--font-display); font-weight: 200; text-transform: uppercase; line-height: 1; letter-spacing: var(--tracking-tight); }
h3 { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; line-height: 1; }
.btn { min-height: 3rem; border: 1px solid var(--fg); border-radius: 0; background: transparent; color: var(--fg); font-family: var(--font-display); font-weight: 400; text-transform: uppercase; }
.btn-primary { background: var(--primary); border-color: var(--primary); color: var(--bg); }
```

## Stack: web
- Dark-first `@theme` CSS, hairline 200 extra-condensed uppercase heads, unframed deep-monochrome `[data-slot]` prints.

## Stack: react-native
- Dark print-room `bg`, zero-radius hairline rows, Sofia Sans Extra Condensed 200 headers and amber primary CTA.

## Stack: flutter
- Dark `ColorScheme`, `FontWeight.w200` condensed display text, zero-elevation hairline `Divider` collector sheets.

## Stack: swiftui
- Print-black ground, `.fontWeight(.ultraLight)` condensed titles, unframed monochrome image plates.

## Stack: compose
- Print-black `MaterialTheme`, `FontWeight.ExtraLight` condensed display typography, amber safelight primary button.
