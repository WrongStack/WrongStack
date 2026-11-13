---
id: vellum
name: Vellum
aesthetic: Archival parchment & ultramarine pigment — Grenze Gotisch display over Hanken Grotesk, double rules.
tags: [vellum, archival, publishing, literature, history, coffee, tea, artisan, editorial, heritage]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Literary publishing, archives, heritage brands, specialty coffee/tea/wine, translation & humanities tools.
paper: light 95 82
display: blackletter Grenze Gotisch
accent: cool 262
posture: restrained
material: warm parchment paper with tan fibre bands, deep umber-black ink, Grenze Gotisch display heads over clean Hanken Grotesk prose, hairline and double manuscript rules, one ultramarine pigment signal
photo: warm sepia=14 con=6
pictured: Long Document, Corridor hero
fontLinks:
  - "https://fonts.googleapis.com/css2?family=Grenze+Gotisch:wght@500;600&family=Hanken+Grotesk:wght@400;500;600&display=swap"
version: 1.1.0
---

# Vellum

## Overview
Contemporary archival craft without medieval parody: warm parchment stock (`bg`), deep umber ink (`fg`), expressive Grenze Gotisch headlines balanced by crisp modern Hanken Grotesk body prose, 4px double rules (`border-double`), and one lapis-ultramarine pigment (`primary`).

## Rules
1. Grenze Gotisch appears ONLY in short `h1`/`h2` headlines and folio numerals in sentence case (never all-caps blackletter, never body text).
2. Hanken Grotesk grounds every paragraph, caption, table, and control in modern legibility.
3. Section transitions use classic manuscript double rules (`border-top: 4px double var(--border)`) and margin folio notes.
4. Ultramarine pigment (`primary`) acts like rubricator ink: paragraph marks, primary actions, and active links.

## Surface & Material
- Warm vellum paper (`bg`) and lighter laid sheet (`surface`) with 2–3px corners and subtle fibre warmth.
- Photographs carry a gentle archival warmth (`photo: warm sepia=14 con=6`) framed by 1px rules.

## Range (Non-Photo Sections)
- Side-by-side folio / translation spread: source and commentary in parallel columns separated by a hairline rule.
- Provenance / harvest ledger: lot numbers, origins, dates, and tasting or archival notes under a double rule.
- Colophon & edition subscription block framed like a bookplate.

## Controls
- Ultramarine primary button (`bg-primary text-bg`) at 3px radius beside an ink-outlined secondary button.
- Underline inputs and clean editorial links accented in ultramarine.

## Components
**Do**
- Keep Grenze Gotisch headlines concise (2–6 words, sentence case) so their calligraphic rhythm shines alongside modern Hanken Grotesk.
- Use double rules and marginalia layouts for genuine structural hierarchy.

**Don't**
- Never set ALL-CAPS blackletter (illegible) or faux-aged torn-scroll gimmicks.
- Never pair parchment with generic SaaS purple gradients or rounded bento bubbles.

## Motion
- Calm page-like opacity/transform transitions over `duration-base` (200ms) on `ease-standard`; instant under `prefers-reduced-motion`.

## Build hint
```html
<link href="https://fonts.googleapis.com/css2?family=Grenze+Gotisch:wght@500;600&family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
```

```css
h1, h2 { font-family: var(--font-display); font-weight: 600; line-height: 1.06; color: var(--fg); }
.double-rule { border-top: 4px double var(--border); }
.bookplate { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); }
.vellum-btn { background: var(--primary); color: var(--bg); border-radius: var(--radius-md); transition: opacity var(--duration-fast) var(--ease-standard); }
```

## Stack: web
- Tailwind v4 `@theme` with Grenze Gotisch + Hanken Grotesk, `.double-rule` section dividers, vellum `.bookplate` sheets, and archival warm `[data-slot]` imagery.

## Stack: react-native
- Parchment & umber palette, Grenze Gotisch display headers via `expo-font`, 3px crisp radii, parallel folio rows.

## Stack: flutter
- Parchment `ColorScheme`, Grenze Gotisch `displayMedium` + Hanken Grotesk `bodyLarge`, double-line section headers.

## Stack: swiftui
- Custom Grenze Gotisch `Font` for short titles, warm parchment asset colors, hairline bookplate cards.

## Stack: compose
- Parchment `MaterialTheme`, Grenze Gotisch display `Typography` paired with Hanken sans body, 3.dp `RoundedCornerShape`.
