---
id: kiln
name: Kiln
aesthetic: Fired clay & smoked charcoal — Boska high-contrast serif over Geist, ember signal, tactile warm grain.
tags: [kiln, craft, ceramics, workshop, culinary, roastery, distillery, artisan, dark, atmospheric]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Roasteries, restaurants, ceramic/wood workshops, craft distilleries, culinary & tactile product brands.
paper: dark 16 45
display: high-contrast-serif Boska
accent: warm 34
posture: restrained
material: charcoal-black ground with warm mineral grain, parchment ink, Boska high-contrast serif heads over Geist, smoked stoneware wells, lamp-lit photography, one glowing ember signal
photo: warm con=8 vib=-4
pictured: Split Studio, Poster hero
fontLinks:
  - "https://api.fontshare.com/v2/css?f[]=boska@400,500&display=swap"
  - "https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=swap"
version: 1.1.0
---

# Kiln

## Overview
Tactile warmth forged in low light: charcoal-umber stoneware surfaces, parchment ink, Boska’s sculptural serif headlines paired with clean Geist utility copy, and a single ember-terracotta signal used like kiln heat rather than paint.

## Rules
1. Boska 400/500 carries headlines and batch/firing numbers; Geist 400/500 handles body copy, schedules, and forms.
2. Dark neutrals carry warm mineral chroma (`hue 45`) — never cold blue-black or sterile `#000`.
3. Ember (`primary`) highlights the primary booking/order action and active temperature/batch state; keep surfaces grounded in charcoal and clay.
4. Photographs are warm and high-contrast (`photo: warm con=8 vib=-4`), showing hands, materials, and process up close.

## Surface & Material
- Smoked stoneware wells (`surface`) separated by 1px warm mineral hairlines (`border`) and subtle grain.
- Modest 6px–10px radii (`radius-md`/`radius-lg`) that feel turned and bevelled rather than bubbly.

## Range (Non-Photo Sections)
- Firing / batch schedule: dated rows with Boska batch numerals, material notes in Geist, and remaining seats/pieces.
- Process triptych: raw clay/grain → shaping → finished glaze/roast in plain captioned frames.
- Tasting or material spec table with warm hairline dividers.

## Controls
- Solid ember primary button (`bg-primary text-bg`) paired with a warm hairline-bordered ghost control.
- Inputs sit in recessed `bg` wells with 1px `border` edges and instant `ring` focus.

## Components
**Do**
- Name real materials, temperatures, origins, weights, and session dates.
- Use warm dark surfaces (`hue 45`) and parchment text (`hue 78`) for effortless night-time reading.

**Don't**
- Never pair cream paper + serif + terracotta as a generic SaaS template; ground Kiln in dark charcoal or real workshop content.
- Never add cyan/purple gradients or cold slate borders.

## Motion
- Slow, grounded transitions over `duration-slow` (320ms) on `ease-standard`; instant under `prefers-reduced-motion`.

## Build hint
```html
<link href="https://api.fontshare.com/v2/css?f[]=boska@400,500&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=swap" rel="stylesheet">
```

```css
h1, h2 { font-family: var(--font-display); font-weight: 500; letter-spacing: var(--tracking-tight); line-height: 1.04; color: var(--fg); }
.stoneware-well { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.kiln-btn { background: var(--primary); color: var(--bg); border-radius: var(--radius-md); transition: opacity var(--duration-base) var(--ease-standard); }
```

## Stack: web
- Tailwind v4 dark-first `@theme` with Boska + Geist, stoneware surface wells, warm mineral borders, and `[data-slot]` warm high-contrast photo filter.

## Stack: react-native
- Warm charcoal dark theme, Boska/Geist via `expo-font`, 6px–10px radii, tactile workshop schedule lists.

## Stack: flutter
- Warm dark `ColorScheme`, Boska serif `headlineLarge`, 1px mineral `Divider`, stoneware card containers.

## Stack: swiftui
- Warm charcoal asset colors, custom Boska serif display titles, subtle grain overlay, Dynamic Type prose.

## Stack: compose
- Dark stoneware `MaterialTheme`, Boska display `Typography`, `RoundedCornerShape(6.dp)`, ember `Button`.
