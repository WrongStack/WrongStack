---
id: overprint
name: Overprint
aesthetic: Two-pass screenprint on grey newsprint — wide Anybody 900 capitals, 4px ink bars, teal × orange multiply.
tags: [overprint, music, venue, festival, events, tickets, screenprint, poster, zine, nightlife, material]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Live music venues, festivals, ticketed events, independent labels, print studios, cultural listings.
paper: light 91.5 92
display: grotesk-heavy Anybody
accent: cool 212
posture: full-palette
material: grey newsprint stock, near-black ink, wide heavy Anybody 900 capitals over Archivo, 4px ink bars, flat teal and orange screenprint passes that multiply where they cross
photo: mono con=30
pictured: Marquee Hero, Poster hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@100..150,900&family=Archivo:wght@400;600&family=Archivo+Narrow:wght@600&display=swap"
version: 1.1.0
---

# Overprint

## Overview
A two-colour silkscreen bill pulled on grey newsprint: wide expanded Anybody 900 capitals over plain Archivo prose, heavy 4px ink top bars, zero radius, zero shadows, and two flat screenprint passes (teal `primary` and orange `accent`) that print deep moss where they cross in `multiply` blend.

## Rules
1. Display heads, door times, and ticket prices set in wide Anybody 900 uppercase (`font-stretch: 140%`, `line-height: 1.02`).
2. Zero border-radius and zero drop-shadows; structure comes from 4px ink bars (`--fg`) and flat pass fills.
3. Pass 1 (`primary`) codes on-sale/open states; Pass 2 (`accent`) codes sold-out/urgent states; never invent a third ink.
4. Photographs print hard high-contrast monochrome (`mono con=30`) pulled through a single ink pass.

## Surface & Material
- Grey newsprint ground (`bg`) and darker newsprint bands (`surface`) capped by 4px solid `--fg` bars.
- Two flat screenprint passes (`mix-blend-mode: multiply` on light stock, `screen` on dark stock).
- Square flush photographs with high-contrast monochrome grit and zero border-radius.

## Range (Non-Photo Sections)
- Poster-scale capacity, door time, and ticket figures on alternating screenprint pass blocks.
- Ruled gig/event listing table under a 4px ink bar with wide Anybody act titles and tabular Archivo prices.
- Numbered bill steps across 3–4 flush cells flooded in alternating pass colours.

## Controls
- Square Pass-1 filled primary button that snaps immediately to Pass-2 on hover, paired with a 2px inset ink-outlined secondary.
- Square 2px inset ink-outlined inputs; links carry a 2px Pass-1 underline.

## Components
**Do**
- Cap listings, tables, and figure rows with a decisive 4px solid ink rule.
- Set act names, dates, and prices bold and wide with `tabular-nums`.

**Don't**
- Never add fake misregistration offsets, ghosted text echoes, or neon glow shadows.
- Never use colour photography or rounded pill cards.

## Motion
- Screenpress snap: instant hover pass swap with zero tweening, zero float, and zero scroll reveals.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@100..150,900&family=Archivo:wght@400;600&family=Archivo+Narrow:wght@600&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 900; font-stretch: 140%; text-transform: uppercase; line-height: 1.02; }
.bill-bar { border-top: 4px solid var(--fg); }
.btn { border: 0; border-radius: 0; font-weight: 600; text-transform: uppercase; }
.btn-primary { background: var(--primary); color: var(--bg); }
.btn-secondary { box-shadow: inset 0 0 0 2px var(--fg); color: var(--fg); background: transparent; }
```

## Stack: web
- Materialize newsprint `@theme` tokens; use `font-stretch: 140%` on Anybody 900 heads, 4px `.bill-bar` rules, and `mono con=30` slots.

## Stack: react-native
- Newsprint ground, `borderTopWidth: 4` listing headers, square Pass-1/Pass-2 state blocks.

## Stack: flutter
- Zero-radius `Container` pass blocks, 4px top `BorderSide` on schedule tables, Anybody 900 display headers.

## Stack: swiftui
- Newsprint asset palette, `.rectangle` pass cells with `.blendMode(.multiply)`, heavy uppercase titles.

## Stack: compose
- `RectangleShape` screenprint blocks, 4.dp top divider bars, heavy wide display `Typography`.
