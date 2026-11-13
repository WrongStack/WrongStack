---
id: terrazzo
name: Terrazzo
aesthetic: Architectural aggregate — wide Syne heads over Onest, ruled cards with hard ink offset, rust signal.
tags: [terrazzo, architecture, industrial, commerce, furniture, materials, catalog, modern, hardware]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Material libraries, industrial design, furniture & hardware shops, architecture studios, modern e-commerce.
paper: light 96.5 75
display: geometric-sans Syne
accent: warm 32
posture: committed
material: warm off-white aggregate ground, crisp white cards ruled in 1.5px ink over a hard 3px offset, wide Syne 700 heads over Onest, JetBrains Mono for SKUs and millimetres, one rust-terracotta signal
photo: natural
pictured: Catalogue, Counter hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Syne:wght@600;700&family=Onest:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
version: 1.1.0
---

# Terrazzo

## Overview
Tactile architectural specification: warm off-white aggregate paper (`bg`), crisp white specification cards (`surface`) framed in a 1.5px ink border over a hard 3px zero-blur offset (`shadow-2`), wide sculptural Syne headlines over clean Onest prose, JetBrains Mono strictly for SKUs and millimetre tolerances, and one iron-rust accent.

## Rules
1. Syne 700 sets architectural headlines at tight measure (`<= 18ch`); Onest carries body copy, filters, and controls.
2. JetBrains Mono is reserved for SKU codes, dimensions (`240 × 120 × 18 mm`), weights, and unit prices.
3. Cards use crisp 4px corners (`radius-md`), visible `border`, and hard 3px offset `shadow-2` — softer than brutalism thanks to warm stone paper and generous padding.

## Surface & Material
- Specification cards combine crisp white `surface`, 1.5px `border`, and `3px 3px 0` offset shadow.
- Material swatches and overhead flat-lay photographs render in true natural color (`photo: natural`) flush to card edges above a ruled spec bar.

## Range (Non-Photo Sections)
- Material / product spec grid: overhead sample photo, Onest name, mono dimension & SKU row, unit price.
- Tolerance & finish comparison matrix: ruled rows comparing thickness, finish, load rating, and lead time.
- Cut-to-size calculator: live millimetre inputs updating total area and price in display Syne numerals.

## Controls
- Rust-filled primary button (`bg-primary text-bg`) with 1.5px ink border and 2px press travel into its hard shadow.
- Filter chips snap cleanly with 1.5px borders and active rust indicator.

## Components
**Do**
- Pair sculptural Syne titles with crisp mono dimensions/SKUs and clean Onest descriptions.
- Keep borders crisp and shadows zero-blur offset.

**Don't**
- Never let Syne run in long multi-line paragraphs or tiny labels — use Onest below heading level.
- Never mix soft blurred drop shadows with hard ink offsets.

## Motion
- Mechanical 120ms (`duration-fast`) press translation into the 3px offset shadow; zero blur or floaty fades.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700&family=Onest:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

```css
h1, h2 { font-family: var(--font-display); font-weight: 700; letter-spacing: var(--tracking-tight); line-height: 1.02; color: var(--fg); }
.spec-card { background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-2); }
.spec-code { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.spec-btn { background: var(--primary); color: var(--bg); border: 1.5px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-2); transition: transform var(--duration-fast) var(--ease-standard); }
.spec-btn:active { transform: translate(2px, 2px); }
```

## Stack: web
- Tailwind v4 `@theme` with Syne + Onest + JetBrains Mono, `.spec-card` 1.5px bordered + 3px hard-offset cards, and natural flat-lay `[data-slot]` imagery.

## Stack: react-native
- 4px radius cards with 1.5px border, hard offset shadow view, Syne/Onest/JetBrains Mono via `expo-font`.

## Stack: flutter
- 4px `RoundedRectangleBorder` with 1.5px `BorderSide`, hard `BoxShadow(offset: Offset(3, 3), blurRadius: 0)`, mono SKU specs.

## Stack: swiftui
- 4pt corner radius with `.strokeBorder` + zero-blur `.shadow(radius: 0, x: 3, y: 3)` and monospaced millimetre specs.

## Stack: compose
- `RoundedCornerShape(4.dp)` with `BorderStroke(1.5.dp, border)`, custom offset drawBehind shadow, Syne headlines.
