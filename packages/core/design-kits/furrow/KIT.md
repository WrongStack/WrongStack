---
id: furrow
name: Furrow
aesthetic: Warm manila field record — Red Hat Display, waterproof notebook grid, moulded keys, tangerine tag.
tags: [furrow, agriculture, field-service, logistics, compliance, inspection, fleet, outdoor, records, material]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Field operations, agriculture & land records, compliance logs, fleet inspections, contractor tools.
paper: light 96 85
display: grotesk-sans Red Hat Display
accent: warm 40
posture: committed
material: warm manila paper, near-black ink in rules, Red Hat Display 600 over Red Hat Text with Red Hat Mono figures, moulded 6px keys, waterproof notebook grid, tangerine signal
photo: natural con=8 sat=-6
pictured: Field Record, Map hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@600&family=Red+Hat+Text:wght@400;500&family=Red+Hat+Mono:wght@400;500&display=swap"
version: 1.1.0
---

# Furrow

## Overview
A working field-records voice: warm manila stock, crisp ink rules, Red Hat Display 600 in sentence case over Red Hat Text, and Red Hat Mono reserved strictly for unit-bearing figures (hectares, doses, batch tags, timestamps). Entries sit on waterproof notebook cards with moulded 6px keys.

## Rules
1. Every measurement carries its explicit unit (`3.6 ha`, `10 ml`, `28 d`) in tabular Red Hat Mono.
2. Labels, tabs, and chips set in Red Hat Text 500 sentence case, untracked — never monospace or uppercase.
3. Lists open under a 1px ink rule with hairline row dividers and a 2px ink rule above totals.
4. Moulded controls carry a subtle top highlight and press down 1px on active state.

## Surface & Material
- Warm manila ground (`bg`) paired with crisp waterproof sheet cards (`surface`) ringed by 1px ink.
- Notebook entry cells use a subtle ruled grid parted by 1px ink dividers.
- Photographs stay natural with slight contrast lift (`natural con=8 sat=-6`), framed at 10px radius.

## Range (Non-Photo Sections)
- Indexed logbook table on a clean sheet with segmented status filters and unit-bearing tabular columns.
- Hourly chronological log rows with timestamp tags and state badges.
- Itemised tariff or compliance schedule set over ruled lines without decorative cards.

## Controls
- Moulded 6px keys (`min-height: 48px`) with top inset highlight; primary fills warm tangerine/terracotta.
- Inputs keep their field label inside the top-left corner of a 52px bordered box; numeric inputs use mono.

## Components
**Do**
- Pair every figure with its unit in `tabular-nums`.
- Use crisp ink rules above lists and totals to structure dense operational data.

**Don't**
- Never set prose labels or navigation tabs in monospace.
- Never use pastoral stock cliches or unlabelled decorative charts.

## Motion
- Crisp field-instrument feedback using `--ease-out` transforms; zero ambient loops.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@600&family=Red+Hat+Text:wght@400;500&family=Red+Hat+Mono:wght@400;500&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 600; line-height: 1.02; letter-spacing: var(--tracking-tight); }
.btn { min-height: 3rem; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 var(--space-4, 1rem); font-weight: 500; background: var(--surface); color: var(--fg); }
.btn-primary { background: var(--primary); color: var(--bg); border-color: var(--primary); }
.ruled { border-top: 1px solid var(--fg); }
.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
```

## Stack: web
- Materialize `@theme` CSS tokens; apply `.ruled` top ink borders on log tables and `tabular-nums` on unit columns.

## Stack: react-native
- Manila `bg` screen container, 1px `fg`-ringed `surface` log cards, `fontVariant: ["tabular-nums"]` on Red Hat Mono values.

## Stack: flutter
- Warm manila `ColorScheme`, Red Hat Display `headlineMedium`, `TableBorder(top: BorderSide(width: 1.5), horizontalInside: BorderSide(width: 1))`.

## Stack: swiftui
- Manila asset background, `.monospacedDigit()` on unit figures, 6pt rounded bordered prominent buttons.

## Stack: compose
- Warm manila `MaterialTheme`, `RoundedCornerShape(6.dp)` moulded buttons, hairline `HorizontalDivider` log lists.
