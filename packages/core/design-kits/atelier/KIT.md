---
id: atelier
name: Atelier
aesthetic: Limewash paper & cotton card stock — Sentient light serif, pressed type, cool slate signal.
tags: [atelier, editorial, gallery, architecture, craft, ceramics, hospitality, luxury, material]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Design studios, architecture practices, galleries, small-batch makers, boutique hospitality.
paper: light 95 76
display: roman-serif Sentient
accent: cool 248
posture: restrained
material: limewash paper, deep umber ink, Sentient 300 over Hanken Grotesk, cotton card stock with fibre and pressed type, hairlines, one cool slate signal
photo: warm con=-6 vib=-10
pictured: Gallery Hang, Diffusion hero
fontLinks:
  - "https://api.fontshare.com/v2/css?f[]=sentient@300,400&display=swap"
  - "https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500&display=swap"
version: 1.1.0
---

# Atelier

## Overview
The register of a maker’s catalogue held in still air: limewash paper, deep umber ink, Sentient 300 in heads and statements over Hanken Grotesk prose, 1px hairlines, and cotton card stock lit from the top left with pressed type. A cool slate accent stays under 4% of the viewport.

## Rules
1. Heads and large figures set in Sentient 300 (light weight, roman, sentence case, tight 1.05 leading); never bold display.
2. Cotton card stock uses 2px corners, an inset top-left highlight, an inner hairline frame, and subtle fibre grain.
3. Labels and captions use Hanken Grotesk a step smaller in sentence case, untracked — never uppercase eyebrows.
4. Cool slate (`primary`/`accent`) appears only on underlines, drop caps, active indicators, and focus rings.

## Surface & Material
- Cotton stock cards carry `radius-md` (2px), a hairline inner border inset 12–14px, and pressed letterpress text shadow.
- Tables and timetables open on a crisp 1px ink rule (`border-fg`) with quiet hairline row dividers (`border-border`).
- Photographs sit matted in warm daylight (`photo: warm con=-6 vib=-10`) with object-precise wall labels underneath.

## Range (Non-Photo Sections)
- Statement spread: one declarative sentence in Sentient 300 across 9 columns over a prose paragraph opening with a slate drop cap.
- Ruled timetable / ledger: days, editions, or dimensions under an ink top rule with muted closed/unavailable rows (never struck through).
- Pressed booking or enquiry card: cotton stock with ruled underline inputs and engraved chip selectors.

## Controls
- Primary action is hairline-outlined in `fg` at 2–3px radius (fills `fg` with `bg` text on hover) or quiet `primary` fill when salience demands it.
- Inputs on card stock use a clean bottom rule rather than heavy boxed frames.

## Components
**Do**
- Pair Sentient light display heads with crisp Hanken Grotesk body copy and real material facts (dimensions, edition numbers, hours).
- Frame photographs like matted prints with generous margins and plain wall-label captions.

**Don't**
- Never use warm terracotta buttons, bold serif heads, blurred glass panels, or decorative glow blobs.
- Never set running paragraphs in serif or labels in tracked capitals.

## Motion
- Quiet unfurl on `ease-standard` over `duration-slow` (320ms); instant state under `prefers-reduced-motion`.

## Build hint
```html
<link href="https://api.fontshare.com/v2/css?f[]=sentient@300,400&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500&display=swap" rel="stylesheet">
```

```css
h1, h2 { font-family: var(--font-display); font-weight: 300; letter-spacing: var(--tracking-tight); line-height: 1.05; color: var(--fg); }
.ruled-list { border-top: 1px solid var(--fg); }
.ruled-list > * + * { border-top: 1px solid var(--border); }
.cotton-card { position: relative; border-radius: var(--radius-md); background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-2); }
.dropcap::first-letter { float: left; font-family: var(--font-display); font-size: 3.2em; line-height: 0.82; padding-right: 0.12em; color: var(--accent); }
.atelier-btn { border: 1px solid var(--fg); border-radius: var(--radius-md); background: transparent; color: var(--fg); transition: background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard); }
.atelier-btn:hover { background: var(--fg); color: var(--bg); }
```

## Stack: web
- Tailwind v4 `@theme` with Sentient (`--font-display`) + Hanken Grotesk (`--font-sans`), 2px cotton-card surfaces, ruled lists, and `[data-slot]` warm photo treatment.

## Stack: react-native
- Custom Sentient/Hanken fonts via `expo-font`; 2px radius cards with hairline borders and bottom-ruled `TextInput` fields.

## Stack: flutter
- `ThemeData` with Sentient display `TextTheme` (weight 300), warm paper `ColorScheme`, and 1px `Divider` ledgers.

## Stack: swiftui
- Custom serif `Font` at `.light` weight for headlines, `.kerning(-0.4)`, cotton surface cards with `.strokeBorder` hairlines.

## Stack: compose
- Custom `FontFamily` with light display `Typography`, 2.dp `RoundedCornerShape`, and `HorizontalDivider` ruled rows.
