---
id: almanac
name: Almanac
aesthetic: Cool slate reference stock — Hanken Grotesk over Newsreader prose, mono tabular figures, chart magenta.
tags: [almanac, reference, research, data, documentation, handbook, directory, catalog, statistics, editorial]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Research portals, benchmarks, data journalism, documentation, directories, datasets, technical handbooks.
paper: mid 84 245
display: grotesk-sans Hanken Grotesk
accent: chromatic-magenta 350
posture: restrained
material: cool slate outer stock with a pale printed reading sheet, blue-black ink, Hanken Grotesk heads over Newsreader prose with Geist Mono figures, two rule weights (2px and 1px), zero radius, one chart magenta signal
photo: muted
pictured: Workbench, Stage hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&family=Geist+Mono:wght@400;500&display=swap"
version: 1.1.0
---

# Almanac

## Overview
Built like a printed statistical yearbook: cool slate outer stock holding a crisp pale reading sheet (`surface`), Hanken Grotesk structural heads over Newsreader long-form prose, Geist Mono strictly for figures and indices, square corners, two rule weights (2px section top rule, 1px row hairlines), and one chart-magenta datum signal.

## Rules
1. Invert the usual pairing: crisp grotesk (`Hanken Grotesk`) for headings and index navigation; optical serif (`Newsreader`) for sustained reading; `Geist Mono` for numeric cells.
2. Square corners (`0`–`2px`) and zero drop shadows; hierarchy comes from the contrast between slate `bg` and crisp `surface` sheets plus 2px/1px rules.
3. Chart magenta (`primary`) marks the active series, benchmark delta, or primary action — never decorative washes.

## Surface & Material
- Outer viewport sits on cool slate stock (`bg`), while reading columns and data tables sit on crisp `surface` sheets framed by 1px `border` and topped by a 2px `fg` bar.
- Photographs are desaturated (`photo: muted`) and treated as archival plates with numbered figure captions.

## Range (Non-Photo Sections)
- Indexed specification / benchmark table: 2px `fg` header rule, mono numeric columns, inline magenta bar proportion.
- Two-column glossary or directory index with sticky section letters.
- Annotated methodology sheet with side-margin citations.

## Controls
- Square-cornered buttons (`radius-none`), solid `fg` or `primary` fill, crisp 1px outlined secondary controls, and search/filter bars with tabular result counts.

## Components
**Do**
- Use two distinct rule weights (2px `border-fg` section openers, 1px `border-border` row dividers) and square corners.
- Set prose at 60–70ch in Newsreader and numbers in Geist Mono.

**Don't**
- Never use rounded pill cards, drop shadows, gradient text, or unlabelled chart axes.

## Motion
- Near-instant `duration-fast` (120ms) state flips; data tables and index filters respond immediately with zero decorative animation.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 600; letter-spacing: var(--tracking-tight); color: var(--fg); }
.sheet { background: var(--surface); border-top: 2px solid var(--fg); border-bottom: 1px solid var(--border); }
.datum { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.datum-bar { background: var(--accent); height: 0.5rem; transition: transform var(--duration-fast) var(--ease-standard); }
```

## Stack: web
- Tailwind v4 `@theme` with Hanken Grotesk + Newsreader + Geist Mono, square `.sheet` containers on cool slate `bg`, 2px/1px rules, and muted archival `[data-slot]` imagery.

## Stack: react-native
- Zero-radius reference cards on cool slate background, Hanken/Newsreader/Geist Mono via `expo-font`, 2px top header rules.

## Stack: flutter
- Square `RoundedRectangleBorder(borderRadius: BorderRadius.zero)`, dual-weight `Border(top: BorderSide(width: 2))`, tabular mono data cells.

## Stack: swiftui
- Rectangle sheets over cool slate background, 2pt top header bar, Newsreader reading prose, `.monospacedDigit()` tables.

## Stack: compose
- `RectangleShape` sheets, 2.dp top `HorizontalDivider(color = fg)`, Newsreader body + Geist Mono tabular figures.
