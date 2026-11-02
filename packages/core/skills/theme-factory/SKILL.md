---
name: theme-factory
description: "Themes and palettes: font pairings, OKLCH color ramps, light and dark modes, Tailwind v4 @theme tokens, contrast-checked accents. Use when choosing or generating a visual theme for a deck, document, web artifact, landing page or app, adding dark mode, or fixing a palette that fails contrast; output semantic tokens with measured ratios. Not for WrongStack's own brand (use brand-guidelines) or extending a project's established tokens (use design-system)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a palette, font pairing or light/dark theme must be chosen, generated or applied to an artifact."
metadata:
  routing-group: design
---

# Theme Factory — WrongStack

## Selection card
- Task: Choose or generate a cohesive theme (type pairing, palette, semantic tokens, light and dark) and bind it to an artifact.
- Start: Name the medium (web, slides, doc), the mood and the lighting (dark-first or daylight); check whether the project already has tokens — if it does, theme inside them.
- Finish: every semantic pair has a measured ratio that meets its threshold in each mode, fonts are licensed and loaded, and the rendered artifact references tokens only.

## Overview

A theme is a set of semantic roles with measured relationships, not a list of hex codes: each role is verified against what it sits on in every mode it ships in. The roles: canvas, surface, text, muted, border, accent, accent-fg and accent-text.
Themes must stay cohesive across web components, presentations, and documents (checked 2026-11-02: Tailwind CSS 4.3.3 `@theme` variables and WCAG 2.2 contrast standards).

## Rules

1. Components reference roles, never colors: canvas, surface, text, muted, border, accent, accent-fg, accent-text and status pairs.
2. An accent used both as a fill and as text needs two values: the fill with an `accent-fg` that passes on it, and an `accent-text` that passes on the canvas; saturated mid-tones (red, amber, green) usually pass neither way with white.
3. Measure every pair in every mode — 4.5:1 text, 3:1 large text and component boundaries; muted text is where themes fail first.
4. Build ramps in OKLCH: keep the hue, step lightness evenly, lower chroma toward both ends to stay in gamut; HSL lightness is not perceptual, so "50% yellow" and "50% blue" differ wildly.
5. Dark mode is designed, not inverted: higher surfaces get lighter, accents lose chroma, and near-black with off-white avoids the halo of pure #000 under pure #fff.
6. A pairing is done only when both fonts are licensed and loaded; pair by role contrast (display, text, mono), not two near-identical sans faces.
7. One token source per theme: CSS custom properties (Tailwind CSS 4.3.3 `@theme`), Office theme slots or document styles; no raw hex in leaf components.

## Curated library (measured on canvas unless noted)

| Theme | Type (licence) | Canvas / text | Muted | Accent fill + fg | Accent as text |
|---|---|---|---|---|---|
| Swiss Modernist | Inter Tight + Inter (OFL); Neue Haas Grotesk / Helvetica Now are commercial | `#F4F4F0` / `#111111` 17.13:1, surface `#FFFFFF` | `#71717A` 4.38:1 fails — use `#63636B` 5.40:1 | `#E63946`: white 4.17:1 (large only), `#111111` 4.53:1; or fill `#C1121F` with white 6.22:1 | `#C1121F` 5.65:1 |
| Editorial Literary | Fraunces or Playfair Display + Source Serif 4 or Newsreader (OFL) | `#FAF7F2` / `#1A1A1A` 16.29:1 | `#736B5E` 4.92:1 | `#8C2D19` with white 8.38:1 | `#8C2D19` 7.85:1 |
| Cyber Minimalist (dark) | Geist Mono or JetBrains Mono + Geist or Plus Jakarta Sans (OFL) | `#0A0D12` / `#E6EDF3` 16.47:1, surface `#121721` | `#8B949E` 6.33:1 (5.83:1 on surface) | `#00FF66` with `#000000` 15.50:1 | `#00FF66` 14.36:1; keep to small areas |
| Neo-Brutalist | Space Grotesk (OFL) or Cabinet Grotesk (Fontshare licence) + Space Mono or Public Sans (OFL) | `#FFFDF5` / `#000000` 20.62:1; borders `#000000` 2–3px | — | `#FFE600` with black 16.57:1 | never `#FFE600` (1.24:1); use `#6B5E00` 6.39:1 |
| Warm Craft Organic | Recursive or Outfit + DM Sans or Mulish (OFL) | `#F9F6F0` / `#2C2723` 13.70:1 | — | `#D97706` with `#2C2723` 4.64:1 (white 3.19:1 fails); sage fill `#047857` with white 5.48:1 | amber `#B45309` 4.66:1; sage `#047857` 5.08:1 |

Borders such as Cyber's `#1F2937` (1.33:1) are decorative; an input needs a second cue (label, fill or a ≥3:1 border).

## Token schema

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

:root {            /* Editorial Literary, light */
  --canvas: #FAF7F2; --surface: #FFFFFF; --fg: #1A1A1A; --muted: #736B5E;
  --accent: #8C2D19; --accent-fg: #FFFFFF; --accent-text: #8C2D19; --border: #E4DDD2;
}
.dark {            /* measured: fg 15.88:1, muted 7.08:1, accent-text 7.00:1 */
  --canvas: #16130F; --surface: #1F1B16; --fg: #F2EDE4; --muted: #A89F91;
  --accent: #E8846B; --accent-fg: #16130F; --accent-text: #E8846B; --border: #3A332B;
}
@theme inline {
  --color-canvas: var(--canvas); --color-surface: var(--surface);
  --color-fg: var(--fg); --color-muted: var(--muted); --color-border: var(--border);
  --color-accent: var(--accent); --color-accent-fg: var(--accent-fg);
  --color-accent-text: var(--accent-text);
  --font-heading: "Fraunces", ui-serif, Georgia, serif;
  --font-body: "Source Serif 4", ui-serif, Georgia, serif;
}
```

`@theme inline` makes utilities use the variable's value, so `.dark` overrides reach `bg-canvas` and `text-fg`; set `color-scheme: light dark` so form controls and scrollbars follow.

## Patterns and pitfalls

- **Tints without new hexes** — `color-mix(in oklch, var(--accent) 12%, var(--canvas))` for hover and selected backgrounds; measure text on the result.
- **Newer color syntax** — `light-dark()` and relative colors (`oklch(from var(--accent) calc(l - 0.1) c h)`) are recent; check web-platform-baseline before relying on them without fallbacks.
- **Gamut** — high-chroma OKLCH values outside sRGB are gamut-mapped by the browser; check what renders on an sRGB screen, not the number.
- **WCAG 2 vs perception** — the ratio overrates dark-on-dark pairs, so dark-mode muted text can pass and still look dim; view it on a real screen.
- **Neon on dark** — saturated accents vibrate on near-black; reduce chroma or limit them to small marks.
- **Status colors** — success, warning, danger and info each need their own fill and text pairs; do not reuse the brand accent, and never signal by color alone.
- **Fallback metrics** — a fallback with a different x-height shifts layout while the web font loads; tune it with `size-adjust` in `@font-face`.
- **Office documents** — PPTX and DOCX themes have twelve color slots (dk1, lt1, dk2, lt2, accent1–6, hlink, folHlink) plus major and minor fonts; map roles to slots so charts and tables follow, and embed or standardize fonts the viewer may not have.
- **Charts** — categorical colors need distinct lightness as well as hue so they survive grayscale and color-vision deficiency.

## Workflow

1. Diagnose tone (investor deck, developer tool, publication, dashboard) and lighting environment.
2. Pick a library theme or derive one: hue, OKLCH ramp, roles, type roles with licences.
3. Measure every role pair in every mode; fix failures by moving lightness, not by adding a new role.
4. Bind tokens at the single source (`@theme`, Office theme, doc styles) and replace literals in components.
5. Render both modes with real content and check muted text, borders, focus rings and charts.

## Proof

- Contrast: list each pair with its ratio (any WCAG 2 calculator or a short relative-luminance script); no pair below its threshold.
- Literals left behind: `rg -n "#[0-9a-fA-F]{3,8}\b" src/components`.
- Tailwind output: `npx @tailwindcss/cli -i src/app.css -o out.css`, then confirm the `--color-*` variables and the dark variant exist.
- Both modes rendered: Playwright `page.emulateMedia({ colorScheme: 'dark' })` and a screenshot per mode, or toggling the `.dark` class.
- Fonts actually loaded: `document.fonts.check('16px "Fraunces"')` returns true in the page.

## Stop and ask

- The project already has a brand or token system that this theme would replace.
- A chosen font needs a commercial licence the user has not confirmed.
- Domain rules fix certain colors (status, safety, finance up/down conventions, regulatory marks).

## Acceptance checks

- [ ] Contrast ratios for text-to-background and interactive boundaries satisfy WCAG 2.2 AA (`>= 4.5:1` body, `>= 3:1` headings/UI).
- [ ] Typography pairings specify distinct heading, body, and monospace typefaces with concrete weights, line-heights, and tracking.
- [ ] Theme tokens are fully mapped to semantic roles (`canvas`, `surface`, `border`, `text-primary`, `text-secondary`, `accent`, `accent-fg`).
- [ ] Artifact reflects the selected theme consistently across all components and states without raw hex overrides.
- [ ] Accent has separate fill/fg and as-text values where it is used both ways, each measured.
- [ ] Every mode the artifact ships in was rendered and inspected; font licences recorded.

## Skills in scope

- design-system — scalable token architecture, component variants, and Tailwind CSS 4 integration
- brand-guidelines — WrongStack's own brand tokens, logo and voice
- accessibility — WCAG 2.2 AA/AAA contrast verification and forced-colors resilience
- pptx — mapping theme roles onto slide masters and Office theme color slots
