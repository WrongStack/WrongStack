---
id: wayfind
name: Wayfind
aesthetic: Public transit signage — Chivo Mono throughout, square 2px ink plates, cobalt live signal.
tags: [wayfind, transit, logistics, timetable, operations, status, travel, mobility, signage, material]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Transit & travel tools, live status boards, logistics & dispatch consoles, schedules, event timetables.
paper: light 95.5 250
display: mono Chivo Mono
accent: cool 264
posture: committed
material: cool grey paper, blue-black ink, Chivo Mono throughout, square 2px ink borders, ink plates, cobalt for what is live
photo: natural sat=-12 con=10
pictured: Station Sequence, Stage hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@400;500;800&display=swap"
version: 1.1.0
---

# Wayfind

## Overview
Public architectural signage set as an interface: cool grey paper, blue-black ink, every glyph in Chivo Mono (400, 500, 800), square 2px ink borders, high-contrast ink plates, and cobalt reserved exclusively for live states and primary actions. Designed to read in daylight from three metres.

## Rules
1. Monospace is the physical board material: set display, body, and figures in Chivo Mono with `tabular-nums` everywhere.
2. Zero border-radius across cards, inputs, and buttons (`0rem`); structure comes from 2px solid ink borders.
3. Keep headings concise and sentence-case so wide monospace glyphs scan in a single glance.
4. Cobalt marks only live indicators, active stops, and the primary action.

## Surface & Material
- Square 2px solid ink borders (`--fg`) frame plates, tables, and navigation bars; 1px `--border` rules divide rows.
- Inverted ink plates (`background: var(--fg); color: var(--bg)`) carry key platform/route numbers.
- Photographs sit square inside a 2px ink frame (`natural sat=-12 con=10`) with captions on a separate plate.

## Range (Non-Photo Sections)
- Departure/status board table with a 2px head rule, line swatches, and 800-weight tabular minute figures.
- Corridor step sequence of three or four square 2px-bordered plates joined by horizontal rules.
- Full-width service status rows with one live cobalt indicator dot on active changes.

## Controls
- Square cobalt-filled primary button beside a 2px ink-bordered transparent secondary, both Chivo Mono 800 sentence case.
- Segmented pickers share 2px square cell borders; selected cell inverts to ink fill with paper text.

## Components
**Do**
- Use 2px solid borders and zero radius consistently across every container and control.
- Set key numerals (minutes, gates, counts) in Chivo Mono 800.

**Don't**
- Never mix a proportional serif or sans-serif into Wayfind.
- Never add soft shadows, rounded cards, or retro split-flap skeuomorphism.

## Motion
- Departure-board crisp: `steps(1)` instant state transitions over `--dur-micro`; zero scroll reveals.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@400;500;800&display=swap" rel="stylesheet">
```

```css
body { font-variant-numeric: tabular-nums; }
h1, h2, h3 { font-family: var(--font-display); font-weight: 800; line-height: 0.98; letter-spacing: var(--tracking-tight); }
.plate { border: 2px solid var(--fg); background: var(--fg); color: var(--bg); }
.btn { border: 2px solid currentColor; border-radius: 0; font-weight: 800; transition: background-color var(--duration-fast) steps(1); }
.btn-primary { background: var(--primary); border-color: var(--primary); color: var(--bg); }
```

## Stack: web
- Zero-radius CSS `@theme`, Chivo Mono across `--font-display` and `--font-sans`, 2px solid ink plates.

## Stack: react-native
- `borderRadius: 0`, `borderWidth: 2`, Chivo Mono 400/500/800 with `tabular-nums` across rows.

## Stack: flutter
- `BeveledRectangleBorder()` / `RoundedRectangleBorder(borderRadius: BorderRadius.zero)` with 2px `BorderSide`.

## Stack: swiftui
- `.rectangle` button and card shapes with `.stroke(fg, lineWidth: 2)` and Chivo Mono custom font.

## Stack: compose
- `RectangleShape` surfaces with `BorderStroke(2.dp, fg)` and Chivo Mono `Typography`.
