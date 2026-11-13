---
id: cobalt
name: Cobalt
aesthetic: Technical hairline paper — Familjen Grotesk, bevel-cut panels, tactile 3px-edge keycaps, electric cobalt.
tags: [cobalt, developer, api, sdk, cli, infrastructure, database, webhooks, technical, b2b]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Developer platforms, APIs, SDKs, CLI tools, databases, observability, technical documentation.
paper: light 98.5 250
display: grotesk-sans Familjen Grotesk
accent: cool 258
posture: restrained
material: cool near-white paper, blue-grey ink and hairlines, Familjen Grotesk over IBM Plex Sans, JetBrains Mono code on graphite, cut-corner panels and tactile keycap controls, one electric cobalt signal
photo: duotone fg surface
pictured: Feature Ledger, Field hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap"
version: 1.1.0
---

# Cobalt

## Overview
An exact, technical register built on cool near-white paper ruled with 1px hairlines, Familjen Grotesk 600 display heads over IBM Plex Sans prose, JetBrains Mono strictly reserved for real code and machine metrics, cut-corner panels, and tactile keycap buttons with a physical 3px bottom edge.

## Rules
1. Familjen Grotesk 600 sets headings and large tabular figures; IBM Plex Sans sets prose and UI labels.
2. JetBrains Mono is strictly for real code snippets, endpoints, hashes, and millisecond telemetry — never decorative uppercase labels.
3. Buttons act like physical keycaps: a 3px bottom edge (`shadow-2`) that lifts 1px on hover and presses flush on `:active`.
4. Cobalt (`primary`) stays under 5% of the viewport: one primary keycap, focus rings, and active syntax tokens.

## Surface & Material
- 1px `--border` hairlines frame panels and split API/event rows cleanly without heavy drop shadows.
- Panels use asymmetric cut/chamfered opposite corners (`border-radius: 16px 4px`) where supported, falling back to `radius-lg` (8px).
- Code blocks sit on deep graphite surfaces (`dark` tokens or inverted surface) with restrained two-tone syntax coloring, never a rainbow.

## Range (Non-Photo Sections)
- Full-width ruled API / webhook ledger: endpoints and payloads in mono, latencies in tabular figures, active row highlighted in subtle wash.
- Two-pane input → output transformer connected by crisp hairline rules.
- Millisecond timeline ruler: notched ticks, status codes in Familjen 600, and working copy-command chips.

## Controls
- Keycap button pair: solid cobalt primary keycap beside a crisp neutral keycap; segmented options sit inside a recessed `surface` tray.
- CLI command chip with a working copy button and instant keyboard `:focus-visible` outline.

## Components
**Do**
- Show real, compilable code, real HTTP status codes, and tabular numeric measurements.
- Use hairline grids and physical keycap affordances for interactive controls.

**Don't**
- Never use pill-shaped gradient buttons, neon cyberpunk glows, or fake terminal window traffic-light chrome.
- Never set navigation links or section labels in monospace.

## Motion
- Crisp mechanical travel over `duration-fast` (120ms) with `ease-standard` (`translateY(-1px)` hover, `translateY(2px)` active); zero bounce.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

```css
h1, h2, h3 { font-family: var(--font-display); font-weight: 600; letter-spacing: var(--tracking-tight); color: var(--fg); }
.keycap { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); color: var(--fg); box-shadow: var(--shadow-2); transition: transform var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard); }
.keycap:hover { transform: translateY(-1px); }
.keycap:active { transform: translateY(2px); box-shadow: var(--shadow-1); }
.keycap-primary { background: var(--primary); color: var(--bg); border-color: var(--primary); }
.cut-panel { border: 1px solid var(--border); border-radius: 1rem 0.25rem 1rem 0.25rem; background: var(--surface); }
```

## Stack: web
- Tailwind v4 `@theme` with Familjen Grotesk + IBM Plex Sans + JetBrains Mono, `.keycap` tactile buttons, asymmetric cut-corner panels, and duotone `[data-slot]` imagery.

## Stack: react-native
- Familjen/Plex/JetBrains Mono via `expo-font`; Pressable keycaps animating `translateY` with Reanimated over 120ms.

## Stack: flutter
- Technical `ColorScheme` with 1px `BorderSide` containers, tabular numerals (`FontFeature.tabularFigures()`), and elevated keycap `ButtonStyle`.

## Stack: swiftui
- Crisp hairline `.overlay(RoundedRectangle(...).stroke(...))`, monospaced digits for metrics, tactile press scale/offset ButtonStyle.

## Stack: compose
- `OutlinedCard` with 1.dp cool borders, asymmetric `CutCornerShape(topStart = 14.dp, bottomEnd = 14.dp)`, and tactile keycap elevation.
