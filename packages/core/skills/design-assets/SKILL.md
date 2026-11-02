---
name: design-assets
description: "Icons, SVG, logos, favicons, responsive images (AVIF/WebP), web fonts: export, optimize, license, accessible markup, no layout shift. Use when importing, generating, converting or optimizing icons, SVG sprites, images, app icons or fonts, or when an asset blurs, shifts layout, ignores dark mode or bloats the bundle; preserve an established icon system. Not for page-level load performance (use web-performance) or poster composition (use canvas-design)."
trigger: "Use when an icon, SVG, image, favicon or font file is added, converted, optimized or renders wrongly."
version: 1.2.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "design"
---

# Design Assets

## Selection card
- Task: Prepare icons, SVGs, images, favicons and fonts for product use with correct rights, formats, sizes and accessible treatment.
- Start: Inventory the pipeline (icon package or sprite, image component, font loading, `public/` assets) and open the actual source file: `viewBox`, intrinsic size, licence.
- Finish: each asset renders crisp at its smallest and largest size in every theme, declares its dimensions, fits its byte budget, and has its licence recorded.

## Overview

An asset is a dependency with a licence, a geometry contract (viewBox, intrinsic size, aspect ratio), a byte cost and an accessibility role — each breaks independently of how it looked in the mockup.
Choose codecs and tools after checking the project and its supported browsers; verify generated or imported assets instead of assuming they fit.

## Rules

1. Record provenance and licence before use: OFL fonts ship with their licence text, commercial webfont licences often cap domains or pageviews, and stock or AI imagery is labelled.
2. One icon family, grid and stroke width per product; extend it by drawing on its grid, never by mixing in a second set.
3. SVG icons keep `viewBox`, drop fixed `width`/`height` (size in CSS); single-color fills and strokes take `currentColor`.
4. Every raster image declares `width` and `height` (or `aspect-ratio`) and serves `srcset` with an accurate `sizes`; the LCP image is never lazy-loaded.
5. Markup follows meaning: decorative images get `alt=""` or `aria-hidden="true"`, informative ones a text alternative of their purpose, icon-only controls a name on the control.
6. Fonts ship as WOFF2, subset to the scripts the product supports, only the weights or axes in use, with a metric-matched fallback.
7. Treat uploaded SVG as code: sanitize it or serve it through `<img>` from a separate origin; never inline untrusted SVG.
8. Keep editable masters apart from delivery files; optimize against measured bytes plus a visual check at 1× and 2×.

## First moves by situation

| Situation | First moves |
|---|---|
| Icon blurry or heavy at 16px | A 24-grid icon at 16px turns a 2px stroke into 1.33px on half-pixels; use a 16px-drawn variant or a fixed stroke (lucide-react `absoluteStrokeWidth`) |
| Icon ignores theme color | Find hard-coded `fill`/`stroke` values in the paths; replace with `currentColor` |
| Two inline SVGs corrupt each other | Duplicate `id`s on gradients, clip paths or masks; prefix ids (SVGO `prefixIds`) or move to a `<symbol>` sprite |
| Optimized SVG stopped scaling | `removeViewBox` ran — default in SVGO 3, not in SVGO 4; check the installed version and config |
| Layout jumps as images load | Add `width`/`height` attributes and keep CSS `height: auto` so the browser reserves the ratio |
| Slow hero (LCP) image | `fetchpriority="high"`, no `loading="lazy"`, preload it if it is a CSS background, AVIF/WebP, correct `sizes` |
| Favicon and app icons | `favicon.ico` (32), `icon.svg` (may carry a `prefers-color-scheme` media query), `apple-touch-icon.png` 180×180, manifest 192 and 512 plus a `maskable` icon inside the central 80% circle |
| Text flashes or shifts on font load | Pick `font-display` deliberately; tune the fallback with `size-adjust`, `ascent-override`, `descent-override`; preload only the critical file with `crossorigin` |

## Patterns and pitfalls

- **Stroke scaling** — an icon scaled from 24 to 48 doubles its stroke; `vector-effect: non-scaling-stroke` or an absolute stroke width keeps it constant.
- **SVG names** — a meaningful inline SVG needs `role="img"` plus `<title>` as first child or `aria-label`; SVGO 4 keeps `<title>` by default, older presets strip it.
- **Missing `sizes`** — it defaults to `100vw`, so a three-column grid downloads three times the width it shows.
- **Format choice** — AVIF is usually smallest for photos but slower to encode; lossless WebP or PNG suits flat UI graphics and screenshots; `<picture>` `type` sources give AVIF → WebP → JPEG fallback, `media` sources give art-directed crops.
- **Orientation and metadata** — phone photos rely on EXIF orientation; auto-orient (sharp `.rotate()` without arguments) before stripping metadata, strip GPS for privacy, and convert wide-gamut images to sRGB instead of dropping their ICC profile.
- **Subsetting away a language** — a Latin-1 subset drops Turkish ğ, ş, ı and İ; include latin-ext and split files with `unicode-range`.
- **Variable fonts** — one file for many weights; declare the range (`font-weight: 100 900`) in `@font-face` or the browser synthesizes.
- **Hostile SVG** — scripts, event handlers, `<foreignObject>` and external `href` survive in SVG; an uploaded SVG served same-origin as `image/svg+xml` is stored XSS. Sanitize with an SVG-aware sanitizer (DOMPurify's SVG profile) or rasterize.
- **Generated imagery** — inspect for garbled text, extra fingers and fake UI; never present a mockup as a real product screenshot.

## Workflow

1. Inventory the asset pipeline, naming conventions and existing icon family.
2. Inspect the real source: viewBox, ids, hard-coded colors, intrinsic pixels, ICC profile, font coverage and licence.
3. Convert and optimize from the master into delivery formats; keep the master untouched.
4. Integrate with the right semantic treatment (decorative, informative, control name).
5. Render at the smallest and largest display size, 1× and 2× DPR, light and dark themes, fallback font.
6. Measure bytes, natural versus rendered size and layout shift; record licence and provenance.

## Proof

- SVG optimize: `npx svgo --multipass -f src/icons -o dist/icons`, then re-render at 16px and 48px.
- Missing viewBox: `rg --files-without-match viewBox -g "*.svg" src/`.
- Hard-coded colors: `rg -n "fill=\"#|stroke=\"#" -g "*.svg" src/icons`.
- Oversized images, in the browser console: `[...document.images].map(i => [i.currentSrc, i.naturalWidth, i.clientWidth])` — natural width should be at most about 2× rendered.
- Font subset: `pyftsubset Font.ttf --unicodes="U+0000-024F" --flavor=woff2 --layout-features="*"` (fonttools with brotli), then check every supported language renders.
- Rendered checks: `design_reference {action:"inspect", url, surface:"page"}` media and type rules, plus a Lighthouse layout-shift reading.

## Measurable acceptance

| Asset | Check | How |
|---|---|---|
| Images | Every `<img>` has `width`/`height` (or an `aspect-ratio`) so loading does not shift the layout; `srcset`/`sizes` deliver at most ~2× the rendered size; below-the-fold images lazy-load | `inspect` rules `media.unsized-image`, `media.broken-image`; compare natural vs rendered size in the browser |
| Formats | Modern formats (AVIF/WebP) with a fallback only where the support matrix requires it | Check web-platform-baseline before claiming support |
| Icons | One icon family, one stroke width and one grid size per product; icon-only controls have an accessible name; decorative icons are `aria-hidden` | Grep the icon imports; inspect accessible names with browser_snapshot |
| SVG | `viewBox` present, no fixed `width`/`height` unless intended, `currentColor` for single-color icons, no external references or scripts | Open the file; render at 16px and 48px in both themes |
| Fonts | At most 2–3 text families (`inspect` `type.family-count`); only the weights in use are loaded; a fallback stack with similar metrics; `font-display` chosen deliberately | Network panel: loaded font files vs weights used |
| Rights | Licence and provenance recorded per asset; generated or stock imagery labelled as such; no third-party logos as social proof | Asset manifest or `.design/brief.md` |

When imagery comes from a reference site (design-reference-read), its screenshots
are evidence for measurement only; never ship them or the brand's illustrations.

## Stop and ask

- A font, icon set, photo or logo has no known licence or source.
- The change replaces the established icon family or brand marks.
- Lossy conversion would overwrite originals with no master kept.
- User-uploaded SVG or images need a sanitization or hosting decision.

## Before returning

- [ ] Asset license/provenance recorded and no fabricated third-party logos or unverified stock claims used
- [ ] Every `<img>` declares intrinsic `width`/`height` (or `aspect-ratio`) with responsive `srcset`/`sizes` where appropriate
- [ ] SVGs include a valid `viewBox`, apply `currentColor` for monochrome theming, and omit inline scripts or colliding IDs
- [ ] Decorative icons carry `aria-hidden="true"` while semantic/interactive icons provide an accessible name
- [ ] Web fonts subsetted to used weights/scripts with metric-compatible fallbacks and rendered in both light/dark themes
- [ ] Rendered at smallest and largest size, 1× and 2×, with bytes and natural-vs-rendered size reported

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[SVG](https://developer.mozilla.org/en-US/docs/Web/SVG), [Responsive images](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images), [SVGO v3→v4 migration](https://svgo.dev/docs/migrations/migration-from-v3-to-v4/).

## Skills in scope

- design-system — aligning icon grids, stroke tokens, font stacks, and theme-adaptive color tokens.
- design-craft — integrating photography, illustration, and typography into a cohesive visual hierarchy.
- accessibility — alt-text authoring, icon-button accessible names, and contrast across image overlays.
- web-performance — LCP hero image prioritization, AVIF/WebP byte budgets, and zero-CLS font/image loading.
