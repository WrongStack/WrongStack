---
name: canvas-design
description: "Posters, prints, book covers, social graphics and editorial one-pagers rendered to PDF, PNG or SVG: grid, type scale, bleed, DPI. Use when composing a single static visual (poster, flyer, cover, event or album art, infographic sheet, 4:5 or 16:9 social image) or preparing one for print. Not for code-driven generative art (use algorithmic-art), slide decks (use pptx) or multi-page documents (use pdf)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when one static composition must be designed and exported at an exact size for print or screen."
metadata:
  routing-group: design
---

# Canvas Design — WrongStack

## Selection card
- Task: Compose and export one static visual (poster, cover, print, social image) at an exact physical or pixel size.
- Start: Fix the output spec before styling — trim size, bleed, color mode, resolution, format, viewing distance — then write a three-line composition intent.
- Finish: the exported file has the stated dimensions, embedded fonts, ≥300 effective PPI images for print, nothing critical outside the safe area, and it was viewed at full size and as a thumbnail.

## Overview

A canvas piece is judged at two distances: one dominant idea that reads as a thumbnail, typographic detail that rewards the close look; the rest is spec — size, bleed, resolution, color, fonts.
Deliver high-DPI vector SVG, print-ready PDF, or crisp raster PNG (minimum 300 DPI for print; checked 2026-11-02: Playwright 1.64.1, pdf-lib 1.17.1, sharp 0.35.5).
Generic template tells — everything centered, a gradient blob behind a card, three equal boxes, low-contrast text on a busy photo — are the failure to avoid.

## Rules

1. Lock the output spec first (trim, bleed, safe margin, color mode, PPI, format); a strong layout at the wrong aspect ratio is a redo.
2. One focal element dominates through scale contrast; a display size only twice the caption size reads as a template, not a poster.
3. Every element sits on one grid (margins and gutters from the same module) or breaks it once, on purpose.
4. Two type families at most; tighten display tracking (−0.02 to −0.04em), open micro-captions (+0.06 to +0.12em), and load the real weights instead of synthesized bold.
5. Text over imagery needs 4.5:1 (3:1 for display ≥24px) at its worst pixel; use a scrim, a solid band or the image's quiet region.
6. Print: 3 mm bleed (0.125 in in US print) on every side, critical text 5 mm or more inside trim (10–20 mm on posters), images ≥300 effective PPI at final size, never upscaled.
7. Browser-made PDFs are RGB; when a press needs CMYK, PDF/X, spot colors or rich black, hand off to prepress and say the file is not press-ready.
8. Use only licensed fonts, photos and logos; label generated imagery as generated.

## Size reference

| Format | Trim | Pixels at 300 PPI (screen: as listed) |
|---|---|---|
| A4 | 210×297 mm (794×1123 CSS px) | 2480×3508 |
| A3 | 297×420 mm | 3508×4961 |
| A2 | 420×594 mm (1190.55×1683.78 pt) | 4961×7016 |
| US Letter | 8.5×11 in | 2550×3300 |
| Poster 18×24 in | 457×610 mm | 5400×7200 |
| Social portrait 4:5 | — | 1080×1350 |
| Story / reel 9:16 | — | 1080×1920 |
| Link / OG card | — | 1200×630 |

Bleed adds to every side: A4 with 3 mm bleed is 216×303 mm.

## Composition vocabulary

Name a movement and its rules before rendering (e.g. *Kinetic Swiss Grid*, *Warm Brutalist Editorial*), in three lines: scale contrast, color restraint, use of space.
- **Swiss / International** — asymmetric 12-column grid, grotesk headlines, flush-left ragged-right text, red/black/cream contrast.
- **Neo-brutalist** — visible frames, monospace metadata, raw blocks, stamp markers, hard offsets.
- **Editorial literary** — high-contrast serif, wide margins, hairline rules, running heads, footnote-style captions.
- **Minimal constructivist** — heavy geometric forms and diagonals with compact technical annotation.
Negative space is an active shape (often 35–50% of the area), not leftover room to fill with badges.

## Patterns and pitfalls

- **Physical units in HTML** — Chromium maps 96 CSS px to 1 in. Set `@page { size: 420mm 594mm; margin: 0 }` and export with `preferCSSPageSize: true`; size elements in `mm` so the artboard equals the trim.
- **Missing backgrounds in PDF** — `page.pdf()` drops backgrounds unless `printBackground: true` (or `print-color-adjust: exact` on the element).
- **PNG at print size** — a screenshot is CSS size × `deviceScaleFactor`; 300 PPI needs 300/96 = 3.125 (A4 → 2481×3509). Very large canvases can exceed browser screenshot limits: export a vector PDF and rasterize it with `pdftoppm -r 300 -png poster.pdf poster`.
- **DPI tag** — screenshots carry 72/96 DPI metadata; printers use pixel count, but layout apps read the tag. Set it with sharp's `withMetadata({ density: 300 })`.
- **Fonts silently falling back** — await `document.fonts.ready` before export; Chromium embeds subsets of fonts that loaded, so a failed load ships the fallback. `pdffonts` shows what was embedded.
- **Fragile hairlines** — rules thinner than 0.25 pt can vanish in print; 0.5 pt is safer.
- **Portable SVG** — SVG text renders with whatever fonts the viewer has; outline the text or embed the font, and give print SVGs a `viewBox` plus physical `width`/`height` (`210mm`).
- **Headline wrapping** — `text-wrap: balance` for multi-line display type; check the rag by eye and avoid a single short word on the last line.
- **Optical alignment** — round letters and punctuation overshoot the grid; nudge display type and hang quotation marks into the margin.
- **Busy photography** — check contrast where the text actually sits, not at the image average.

## Workflow

1. Spec: size, bleed, safe margin, color mode, PPI, format and where it is seen (wall, feed, print, screen).
2. Intent: movement name, three rules, one focal element and the reading order; thumbnail sketch first.
3. Build an HTML or SVG artboard in physical units with a toggleable grid overlay.
4. Typeset with the real copy on a modular scale (1.25, 1.414 or 1.618); fix the rag and widows.
5. Export: vector PDF through `page.pdf`, PNG through a screenshot at the computed `deviceScaleFactor`, or SVG.
6. Inspect at 100% and as a ~240 px thumbnail; fix the weakest of focal point, contrast and spacing, then re-export.

## Proof

- `pdfinfo poster.pdf` — page size in points matches the trim plus bleed.
- `pdffonts poster.pdf` — every font row shows `emb yes`.
- `pdfimages -list poster.pdf` — `x-ppi`/`y-ppi` at least 300 for print.
- `magick identify -format "%w x %h %x\n" poster.png` — pixel size and density tag.
- `magick poster.png -resize 240x thumb.png` — open the thumbnail; the focal idea must still read.
- Playwright export: `page.pdf({ path: 'poster.pdf', preferCSSPageSize: true, printBackground: true })`.

## Stop and ask

- The printer requires CMYK, PDF/X, spot colors or a specific ICC profile.
- Fonts, photos or third-party logos lack a licence or source.
- The copy carries facts (dates, prices, names, venues) that were not supplied.
- Size or destination is unstated and cannot be inferred.

## Before returning

- [ ] Output spec (trim, bleed, safe margin, color mode, PPI, format) stated and matched by the exported file
- [ ] Composition intent recorded: movement, rules, focal element, reading order
- [ ] One grid governs placement; at most two type families on a modular scale
- [ ] Text over imagery measured at its worst pixel: 4.5:1, or 3:1 for display type
- [ ] Fonts embedded and images ≥300 effective PPI for print, verified with the proof commands
- [ ] Viewed at 100% and as a thumbnail; RGB-only or prepress limits stated

## Skills in scope

- pdf — vector print-ready PDF generation and pagination geometry
- theme-factory — curated typographic pairings and harmonic color systems
- brand-guidelines — official WrongStack brand tokens and visual standards
- algorithmic-art — generative or code-driven imagery placed inside the composition
- design-assets — image formats, SVG hygiene and font licensing for the exported file
