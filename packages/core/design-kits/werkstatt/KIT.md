---
id: werkstatt
name: Werkstatt
aesthetic: Design-school printed prospectus — warm putty ground, Jost 700 capitals, boxed ink cells, flat primaries.
tags: [werkstatt, school, academy, workshop, course, catalogue, bauhaus, education, prospectus, material]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Design schools, bootcamps, maker workshops, residencies, festival programmes, cultural catalogues.
paper: mid 84 82
display: geometric-sans Jost
accent: cool 264
posture: full-palette
material: warm putty ground with a lighter well, near-black ink, Jost 700 capitals and numerals over Karla, square 2px and 3px ink rules that box cells, flat ultramarine and vermilion primaries
photo: mono
pictured: Catalogue, Settled hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Jost:wght@700&family=Karla:wght@400;600&display=swap"
version: 1.1.0
---

# Werkstatt

## Overview
A printed workshop prospectus pinned to a studio wall: warm mid-tone putty stock (`L=84%`), near-black ink, geometric Jost 700 capitals over plain Karla prose, 2px and 3px ink rules that box facts into flush cells, monochrome documentary shop photography, and flat primary fills that code programme tracks.

## Rules
1. Headings and display numerals set in Jost 700 capitals (`line-height: 1.02`); body and sentence-case labels set in Karla.
2. Zero border-radius and zero drop-shadows everywhere — cells are enclosed strictly by 2px and 3px ink rules.
3. Photographs print strictly monochrome (`photo: mono`) so flat primary cells carry all chromatic signal.
4. Primary colour fills code distinct tracks or categories rather than decorative confetti.

## Surface & Material
- Mid-tone putty paper (`bg`) with lighter ruled wells (`surface`) enclosed by 2px/3px solid `--fg` rules.
- Zero elevation shadows (`shadow: none`); hierarchy comes from rule weight and flat colour blocks.
- Flush black-and-white photographs framed inside 2px ink borders.

## Range (Non-Photo Sections)
- Boxed display figures across a 3px-ruled grid with Karla labels underneath.
- Ruled term/programme schedule setting dates at display scale beside plain workshop descriptions.
- Category-coded flush grid where each track’s flat primary bar carries its title under monochrome shop work.

## Controls
- Square ink-filled primary button beside a 2px ink-bordered transparent button in Karla 600 capitals.
- Links carry a 2px ink underline that thickens to 3px on hover; square 2px-bordered inputs.

## Components
**Do**
- Enclose facts, dates, and tuition figures inside crisp 2px/3px ink-ruled cells.
- Keep all photography black-and-white so flat primary blocks stay unmistakable.

**Don't**
- Never round corners, blur shadows, or tint photographs.
- Never scatter primary colours as decorative geometric confetti.

## Motion
- Printed-prospectus stillness: underline thickness shift on hover; zero scroll or ambient animation.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Jost:wght@700&family=Karla:wght@400;600&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 700; line-height: 1.02; text-transform: uppercase; }
.ruled-box { border-block: 3px solid var(--fg); }
.btn { border: 2px solid currentColor; border-radius: 0; font-family: var(--font-sans); font-weight: 600; text-transform: uppercase; background: transparent; color: inherit; }
.btn-primary { background: var(--fg); border-color: var(--fg); color: var(--bg); }
a { text-decoration-thickness: 2px; }
```

## Stack: web
- Mid-tone putty `--bg`, zero radius, 2px/3px solid `--fg` ruled CSS grid cells, monochrome `[data-slot]` imagery.

## Stack: react-native
- Putty background, `borderWidth: 2` flush cells, uppercase Jost 700 headers over Karla body.

## Stack: flutter
- Zero-elevation `CardTheme` with `Border.all(width: 2)`, Jost uppercase `displaySmall` + Karla `bodyMedium`.

## Stack: swiftui
- Putty ground asset color, `.rectangle` bordered cells, grayscale image modifier on workshop photos.

## Stack: compose
- Zero-tonal-elevation `Surface` with `BorderStroke(2.dp, fg)`, Jost 700 uppercase display typography.
