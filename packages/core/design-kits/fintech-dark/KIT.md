---
id: fintech-dark
name: Fintech Dark
aesthetic: Trading-grade dark — data-dense, green/red signals, charts, sharp and serious.
tags: [fintech, trading, crypto, dark, data, dashboard]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Trading, crypto, banking, analytics, real-time data and portfolio products.
version: 1.0.0
---

# Fintech Dark

## Overview
A serious, data-dense dark interface for money: deep neutral grounds, crisp tabular numbers,
green/red directional signals, compact charts, and a restrained accent. Built for scanning
real-time data without fatigue. Precision and trust over flair — every pixel serves the data.

## Rules
1. Dark-first deep neutrals; high information density done legibly (clear rows, tabular nums).
2. Semantic directional color: green = up/positive, red = down/negative — plus icon + sign (not color alone).
3. One cool accent for primary actions; charts use a controlled multi-series palette.
4. Crisp hairlines, compact spacing, monospace/tabular figures for prices.
5. Numbers are first-class: alignment, precision, deltas, sparklines.
6. Maintain AA; ensure red/green also distinguishable for color-blind users (shape/sign).

## Color
- Dark: bg `oklch(18% 0.01 250)`, surface `oklch(22% 0.012 250)`, fg `oklch(94% 0.01 250)`, up `oklch(72% 0.17 150)`, down `oklch(64% 0.2 25)`, accent `oklch(66% 0.16 255)`.
- Light: bg `oklch(98% 0.003 250)`, fg `oklch(22% 0.02 250)`, same up/down/accent.

## Typography
- Sans (Inter) for UI + tabular/mono (JetBrains Mono) for figures. Compact, precise.

## Components
**Do**
- Dense tables with sticky headers + tabular nums; sparklines/candlesticks; delta chips (▲/▼ + %); compact toolbars; order tickets.
**Don't**
- No decorative gradients/shadows; don't rely on color alone for up/down; no wasted space where data belongs.

## Motion
- Fast, minimal: value flashes on update (green/red tick), 80–140ms; no flourish.
- Reduced-motion: no flash; instant update.

## Stack: web
- Tailwind v4 dark + semantic up/down tokens; `tabular-nums`; Lightweight-Charts/visx; dense tables; accent ring on CTAs.
## Stack: react-native
- Dark theme; tabular nums; `react-native-svg`/wagmi-charts; dense `FlatList` rows; delta chips.
## Stack: flutter
- Dark `ColorScheme`; `fl_chart`/candlesticks; `DataTable` dense; tabular `TextStyle`; delta chips.
## Stack: swiftui
- Dark; `Charts` framework; `.monospacedDigit()`; dense `List`/`Table`; `.contentTransition(.numericText())`.
## Stack: compose
- Dark M3; Vico charts; monospace digits; dense `LazyColumn`; `animateColorAsState` tick flash.
