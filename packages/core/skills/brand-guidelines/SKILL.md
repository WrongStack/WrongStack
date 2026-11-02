---
name: brand-guidelines
description: "WrongStack brand: five-block logo, signal-pink and orange tokens, warm paper and ink surfaces, Space Grotesk type, voice and OG cards. Use when making WrongStack-branded collateral (README art, social or OG images, slides, release posts, website sections) or checking one against the shipped brand. Not for a user's own product tokens (use design-system) or picking a generic theme (use theme-factory)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when an artifact must look and sound like WrongStack: logo, palette, type, voice, slides or social imagery."
metadata:
  routing-group: design
---

# Brand Guidelines — WrongStack

## Selection card
- Task: Make WrongStack collateral match the shipped brand: logo, color, type, geometry and voice.
- Start: Inside the WrongStack repo, read `website/src/index.css` (`:root` and `.dark`) and the logo files in `website/public/`; elsewhere use the snapshot below and say it is a snapshot.
- Finish: the rendered artifact uses only brand tokens, every text pair meets the measured table, the logo is unaltered with clear space, and each shipped theme was inspected as an image.

## Overview

WrongStack looks like an operator's instrument panel on warm paper: ink text, two brand signals (signal pink, then orange) and status colors — not a neon terminal or a purple gradient.
The code is the source of truth: website tokens in `website/src/index.css`, product UI tokens in `packages/webui/src/index.css`, generated desktop tokens in `apps/desktop-v2/src/brand-tokens.css`. Re-read them before shipping; the table below is a snapshot (checked 2026-11-02: Tailwind CSS 4.3.3 `@theme` token alignment).

## Rules

1. Take every color from a token; a brand hex typed into a component is drift even when it matches today.
2. Pink is the primary brand and action signal, orange the secondary; success, warning, danger and info hues appear only as status, never as decoration.
3. Text uses the `-text` variants: orange `#d97706` measures 2.95:1 on paper, so orange text is `#9b4900`; white on plain orange (3.19:1) fails body text.
4. The logo is the five-block mark — four orange blocks with the second, pink block dropped half a block — and is never recolored, re-spaced, rounded, rotated, outlined or given effects.
5. On light surfaces place the logo on its ink tile (`wrongstack.svg`): bare orange blocks measure 1.92:1 on paper and dissolve.
6. Geometry follows the surface: the website rounds cards (`rounded-2xl`) and pills (`rounded-full`), WebUI is square with every radius token at 0, Desktop v2 uses small 4–8px radii.
7. Numbers in copy (tool, skill and plugin counts, versions) come from the repo at writing time, never from memory or an older post.
8. Ship light and dark when the medium allows; dark is its own token set, not an inversion.

## Snapshot tokens (website)

| Role | Light | Dark | Measured |
|---|---|---|---|
| Background `--bg` | `#f8f6f0` | `#1b1c1a` | — |
| Card `--card` / surface `--surface` | `#fffdf8` / `#f0ede5` | `#292a26` / `#22231f` | — |
| Text `--fg` | `#171714` | `#f5f2e9` | 16.62:1 / 15.28:1 on bg |
| Muted `--muted` | `#646159` | `#b6b2a8` | 5.72:1 / 8.08:1 on bg |
| Brand pink `--brand-pink` | `#d51f4d` | `#fe2e5f` | 4.70:1 / 4.70:1 on bg; dark pink on dark card only 3.97:1 |
| Pink text `--brand-pink-text` | `#bd1744` | `#ff7897` | 5.77:1 / 6.83:1 on bg |
| Brand orange `--brand-orange` | `#d97706` | `#fd9f02` | 2.95:1 / 8.26:1 on bg |
| Orange text `--brand-orange-text` | `#9b4900` | `#fd9f02` | 5.81:1 / 8.26:1 on bg |
| On-brand text `--on-brand` | `#ffffff` | `#121210` | white on pink 5.08:1; ink on dark pink 5.15:1 |
| Primary button | gradient `#b91640` → `#995000`, white text | — | 6.46:1 and 6.00:1 at the two ends |
| Lines `--line` / `--line-strong` | `#dfdbd1` / `#c9c3b7` | `#3b3c36` / `#515249` | decorative only: 1.28–2.16:1 |
| Ink (logo tile) | `#121210` | `#121210` | orange 9.05:1, pink 5.15:1 on ink |

Lines are below 3:1, so a form field needs more than its border to be identified (a label, a fill or `--line-strong` plus focus ring).

## Type and voice

- Website: Space Grotesk for display and text, JetBrains Mono for code, commands and data. WebUI: Manrope for interface text, Space Grotesk for display headings, IBM Plex Mono for readouts with `tabular-nums`. Desktop v2: Geist.
- All are OFL; the website self-hosts latin and latin-ext woff2 subsets with their licence files in `website/public/fonts/`. Reuse those files rather than a CDN copy in collateral.
- Display tracking stays tight, mono labels may be uppercase with slight positive tracking; prose stays left-aligned with a ~72ch measure (`--site-prose-max`).
- Voice: operator to operator — what it does, the command, the measured result. Headline pattern from the site: "AI coding, under your control." Short imperative triads ("Code. Command. Ship.") are the house rhythm; avoid "revolutionary", "seamless", "supercharge" and unverifiable superlatives.
- Attribution: the product is by OXOGNET OÜ (OxogNet); the site uses MIT license language and links the GitHub repo.

## First moves by situation

| Request | First moves |
|---|---|
| OG or social card | 1200×630 PNG (the site's `og.png` size); logo on ink tile, headline in Space Grotesk, one pink accent; render and view at 600 px wide too |
| Slide deck | Map tokens to the Office theme slots (dark 1 ink, light 1 paper, accent 1 pink, accent 2 orange-text); embed or install the OFL fonts before exporting |
| README or docs image | Light and dark variants via `<picture>` with `prefers-color-scheme` sources; never pink text on dark cards |
| Release post | Pull version and counts from `package.json`, the changelog and the site's JSON-LD at writing time |
| "Looks off-brand" review | Grep for raw hex, purple/indigo gradients, glassmorphism, geometry that does not match the surface, orange text on paper |

## Anti-patterns

- Neon or purple/indigo mesh gradients, glass blur stacks, glow shadows, stock 3D blobs.
- Orange body text on paper, white text on plain orange, pink text on dark cards.
- Status colors as decoration, or a third brand hue invented for "variety".
- Rounded corners in WebUI mockups; square cards on the marketing site where the system rounds them.
- Redrawn, stretched or recolored logo blocks; the mark placed bare on busy imagery.

## Proof

- Contrast: compute every text pair you introduce (any WCAG 2 calculator, or a short script using relative luminance) and compare with the table.
- Tokens: `rg -n "#[0-9a-fA-F]{6}" <artifact sources>` shows hex literals that should be tokens.
- Render: export the PNG/PDF (Playwright screenshot or the deck's exporter), open it, and check both themes plus a small-size view.

## Stop and ask

- The request changes the brand itself (new hue, logo variant, typeface, square/rounded rule): that is an owner decision, not an application of the guidelines.
- The artifact will be published to an official WrongStack channel, or co-branded with another company's logo.
- The live token files disagree with this snapshot in a way that changes a contrast verdict: report the difference and follow the code.

## Before returning

- [ ] Token values re-read from the source files, or the artifact is labelled as using the snapshot
- [ ] Only pink and orange as brand signals; status hues used only for status
- [ ] Every text pair at least 4.5:1 (3:1 for large display text), using the `-text` variants where needed
- [ ] Logo files used unaltered, on the ink tile on light surfaces, with clear space of at least one block width (house default; no documented rule)
- [ ] Geometry matches the surface (rounded website, square WebUI, small-radius Desktop v2)
- [ ] Counts and versions in copy verified against the repo today
- [ ] Rendered output inspected in every theme it ships in

## Skills in scope

- design-system — semantic design tokens, component variants, and CSS-first variables
- theme-factory — multi-theme chromatic palettes and font pairings
- design-critique — anti-slop visual audit and accessibility contrast checks
- design-assets — logo SVG handling, OG image export, and font subsetting
- pptx — branded slide masters and theme-slot mapping
