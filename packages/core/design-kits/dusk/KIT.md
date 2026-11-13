---
id: dusk
name: Dusk
aesthetic: Calm twilight fintech — Wix Madefor, smoked slate glass with lit top edge, bone wells, periwinkle signal.
tags: [dusk, fintech, treasury, banking, payments, reconciliation, accounting, ledger, b2b, finance]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Treasury software, banking, reconciliation, billing, accounting ledgers, calm executive financial tools.
paper: dark 17.5 268
display: grotesk-sans Wix Madefor Display
accent: cool 274
posture: committed
material: deep twilight slate ground, smoked glass surfaces with a 1px lit top edge, bone-white wells for light documents, Wix Madefor Display 500 over Wix Madefor Text, tabular balances with muted cents, periwinkle signal
photo: natural con=4 vib=6
pictured: Narrative Workflow, Stage hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Wix+Madefor+Display:wght@500;600&family=Wix+Madefor+Text:wght@400;500;600&display=swap"
version: 1.1.0
---

# Dusk

## Overview
Financial software at the calm end of the day: deep twilight slate in dark mode paired with warm bone-white wells in light mode, Wix Madefor Display at a composed 500 weight, smoked-glass product panes with an inset 1px top highlight, and tabular account rows with muted cents.

## Rules
1. Heads stay composed at weight 500–600 with tight `-0.022em` tracking; balances and timestamps always use `tabular-nums`.
2. Cents and trailing decimals render in `muted` at the same font size (never superscripted) for effortless vertical scanning.
3. Never stack glass on glass or put neon glow behind panels; elevation comes from a 1px inset top edge (`shadow-3`) and slate lightness steps.
4. Avoid grids of disconnected KPI stat cards — present financial state in ruled account lists, reconciliation ledgers, and daily bar strips.

## Surface & Material
- Smoked slate surfaces (`surface` + `border`) with `radius-lg` (18px) outer frames and `radius-md` (10px) inner rows.
- Light mode (and bone document wells) uses warm parchment-tinted neutrals (`hue 75`) so invoices and statements read like real paper.
- Photographs depict calm twilight horizons (`photo: natural con=4 vib=6`) with text placed only over clean scrim regions.

## Range (Non-Photo Sections)
- Reconciliation account list: account initial, muted entry count, status word + icon, right-aligned tabular balance with muted cents.
- Month close strip: 30 slim vertical bars in `primary` (settled) and `accent` (open/pending) above a 4-column ruled summary tally.
- Statement hand-off well: an invoice or approval note framed inside a warm bone well.

## Controls
- Pill primary button (`radius-full`) in `primary` with `bg` text and subtle inset top highlight, paired with a quiet `surface` ghost pill.
-  Ruled vertical list tabs marked by a single `primary` indicator dot instead of heavy segmented boxes.

## Components
**Do**
- Align every currency column right with `font-variant-numeric: tabular-nums` and muted decimal fractions.
- Keep language calm and exact: what settled, when it ran, what remains open.

**Don't**
- Never use neon trading-terminal greens/reds, glowing gradients, or 4-up bento KPI tiles.
- Never nest blurred glass inside blurred glass.

## Motion
- Unhurried cross-fades and staggered row reveals over `duration-base` (200ms) with `ease-standard`; instant under `prefers-reduced-motion`.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Wix+Madefor+Display:wght@500;600&family=Wix+Madefor+Text:wght@400;500;600&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 500; letter-spacing: var(--tracking-tight); color: var(--fg); }
.ledger-num { font-variant-numeric: tabular-nums; }
.ledger-num .cents { color: var(--muted); }
.smoked-pane { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-3); }
.dusk-pill { border-radius: var(--radius-full); background: var(--primary); color: var(--bg); transition: opacity var(--duration-fast) var(--ease-standard); }
```

## Stack: web
- Tailwind v4 dark-first `@theme` with Wix Madefor Display/Text, `.ledger-num` tabular balances, smoked-pane inset top highlights, and pill controls.

## Stack: react-native
- Dark-first twilight slate palette, 18px outer / 10px inner radii, `fontVariant: ["tabular-nums"]` on all currency rows.

## Stack: flutter
- Slate & bone `ColorScheme`, `FontFeature.tabularFigures()` on ledger amounts, 18.0 card radius with 1px top highlight border.

## Stack: swiftui
- `.monospacedDigit()` balances with secondary-colored cents, `.ultraThinMaterial` / slate cards with subtle top stroke.

## Stack: compose
- `RoundedCornerShape(18.dp)` slate surfaces, `fontFeatureSettings = "tnum"` on balances, pill `Button` primary actions.
