---
id: formwork
name: Formwork
aesthetic: Cast concrete & site-office board — mid grey speck ground, Oswald 700 capitals, hard 6px ink shadow, safety orange.
tags: [formwork, construction, industrial, engineering, architecture, fabrication, hardware, heavy, concrete, material]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Civil engineering, fabrication shops, industrial hardware, architecture & construction, heavy tooling.
paper: mid 76 80
display: display-condensed Oswald
accent: warm 38
posture: restrained
material: warm grey concrete paper with speck grain, near-black ink, Oswald 700 capitals over Archivo, square cast edges and hard 6px ink shadows, hard black-and-white concrete photography, one safety orange signal
photo: natural sat=-100 con=35 exp=8
pictured: Site Board, Poster hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Oswald:wght@700&family=Archivo:wght@400;500&family=Archivo+Narrow:wght@500&display=swap"
version: 1.1.0
---

# Formwork

## Overview
A site-office specification board cast in warm grey concrete: straight zero-radius edges, Oswald 700 condensed capitals over plain Archivo prose, hard unblurred 6px ink plate shadows, high-contrast black-and-white photographs, and a single safety-orange signal held below 5% of the viewport.

## Rules
1. Oswald 700 uppercase sets every heading and giant plate numeral; Archivo 400/500 sets prose and sentence-case labels.
2. Zero border-radius and zero blurred shadows; cast plates use a 3px ink border and hard `6px 6px 0` offset shadow.
3. Safety orange stays under 5% of any screen — primary button, focus ring, and one active marker.
4. Photographs print hard black-and-white (`natural sat=-100 con=35 exp=8`) inside a 2px ink outline.

## Surface & Material
- Poured concrete mid-tone ground (`bg`) with lighter cast plates (`surface`) carrying 3px ink borders and hard shadows.
- 3px ink bars cap sections and specification tables; 1px `--border` hairlines divide rows.
- Subtle speck grain at 0.05 opacity gives the concrete paper tactile mass.

## Range (Non-Photo Sections)
- Single real project metric cast at poster scale in Oswald 700 on a hard-shadowed plate.
- Pour/build sequence across 3–4 columns under a 3px top bar with Oswald stage numerals.
- Side-by-side specification plates comparing scopes or tolerances on hairline rows.

## Controls
- Safety-orange primary button on a hard `0 3px 0` ledge that presses down 3px on `:active`, paired with an inset-shadowed 2px-bordered secondary.
- Inputs sit pressed-in with 2px ink borders and zero radius.

## Components
**Do**
- Pair every dimension or capacity figure with its engineering unit.
- Keep photography high-contrast monochrome so safety orange is the sole chromatic accent.

**Don't**
- Never draw hazard stripes, faux cracks, or blurred drop shadows.
- Never flood an entire section background in safety orange.

## Motion
- Mechanical press-in (`translate: 0 3px`) over `--dur-micro`; concrete never floats or bounces.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@700&family=Archivo:wght@400;500&family=Archivo+Narrow:wght@500&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 700; text-transform: uppercase; line-height: 1.02; }
.plate { background: var(--surface); border: 3px solid var(--fg); box-shadow: var(--shadow-2); }
.btn { border-radius: 0; font-family: var(--font-display); font-weight: 700; text-transform: uppercase; }
.btn-primary { background: var(--accent); color: var(--fg); box-shadow: 0 3px 0 var(--primary); }
```

## Stack: web
- Materialize concrete `@theme` tokens; use `.plate` 3px borders + hard 6px offset shadow and high-contrast grayscale `[data-slot]` photos.

## Stack: react-native
- Zero-radius views with `borderWidth: 3` and hard offset sibling shadow views; Oswald 700 uppercase headers.

## Stack: flutter
- Square `Container` plates with `BoxShadow(offset: Offset(6, 6), blurRadius: 0)` and Oswald `displayMedium`.

## Stack: swiftui
- `.rectangle` plates with `.background(fg.offset(x: 6, y: 6))` hard cast shadow and safety-orange prominent CTA.

## Stack: compose
- `RectangleShape` cards with custom unblurred 6.dp offset drawBehind shadow and Oswald 700 display type.
