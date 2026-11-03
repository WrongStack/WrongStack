<!-- verified: 2026-11-02 | sources: developer.apple.com/documentation/technologyoverviews/liquid-glass.md; developer.android.com/design/ui/wear/guides/get-started/design-language (last updated 2025-05-20); developer.android.com Compose navigation-bar docs; superdesign.dev/blog/ai-design-prompts-2026 (2026-06-14); ionos.com/digitalguide/websites/web-design/webdesign-trends (2026-07-20); theplusaddons.com/blog/neo-brutalism-web-design (2026-09-11); studiomeyer.io/en/blog/bento-grid-layouts (updated 2026-09-30); saasframe.io/blog/the-bento-layout-trend (undated); web-platform-dx web-features explorer (scroll-driven-animations, cross-document-view-transitions) -->

# Dated visual trends

Trends are **not** patterns. A pattern solves a job and ages slowly; a trend is a
visual treatment that signals "current" and then signals "dated". This file is kept
separate so evergreen guidance in the other references never depends on it.

How to use a trend:
1. Choose the evergreen pattern id first (SKILL.md procedure).
2. Apply the trend only to that pattern's **Variables** (surface, color, motion, type).
3. State the trend's risk in the design brief.
4. Re-verify this file if its date is more than ~6 months old; trend status changes fast.

Status legend: **VERIFIED** = checked against the named source on the date above;
**UNVERIFIED** = plausible but not confirmed this session — do not present it as fact.
Evidence quality varies: platform docs and web-features data are primary; design-tool
prompt statistics and agency blogs are indirect signals of taste, not adoption metrics.

---

### trend-bento-feature-grid — Bento feature grids
Maps to: `bento-grid` (page-layouts.md).
Status: VERIFIED as a widely discussed current pattern. saasframe.io says it was
"popularized by Apple's summary slides" and is common on SaaS landing pages;
studiomeyer.io (updated 2026-09-30) lists 4–6 desktop columns, 2×2 hero tiles, 16–24px
gaps, and advises against it for text-heavy content, lists of equivalent products and
tabular data ("Tabular data belongs in tables, not tiles"). studiomeyer.io removed an
unsupported conversion-uplift claim on 2026-09-30 — do not cite engagement numbers for bento.
Risk: ages into "template look" when tiles are icon + title + two lines; fails whenever
items are equivalent. Safe when tile size reflects real importance.
Seen as: mixed col/row spans, 2–3 tile size classes, uniform gaps.

### trend-dark-first — Dark theme as the default request
Maps to: any pattern; a theme Variable.
Status: VERIFIED (indirect). Superdesign's analysis of 210,759 prompts to its AI design
tool (2026-01-08 to 2026-06-14) reports dark theme requests rising from 26.8% (Jan) to
38.1% (May). IONOS (2026-07-20) lists dark mode among ongoing themes. This measures what
people ask an AI tool for, not what ships.
Risk: dark-only builds fail daylight/print use and forced-colors; inverted light themes
look wrong (slop C6). Ship both themes or justify one.
Seen as: body background lightness < ~20% with light text as the default theme.

### trend-gradient-accent — Gradient as the primary visual device
Maps to: surface/color Variables of hero and CTA patterns.
Status: VERIFIED (indirect). Superdesign: gradients are the most-requested visual device
(61,193 prompts across 21,505 projects, Jan–Jun 2026).
Risk: high. Purple→blue gradients are the most recognizable generated-default tell
(design-craft slop C2, C1). Popular demand is exactly why it reads as unconsidered.
Seen as: `linear-gradient`/`radial-gradient` backgrounds on hero/CTA surfaces or text.

### trend-glass-material — Translucent "glass" material for controls
Maps to: chrome of `app-shell`, `top-bar-nav`, `bottom-tab-bar`, `canvas-tool-chrome`.
Status: VERIFIED for Apple platforms. Apple's Liquid Glass overview (with WWDC 2025
session videos) calls it "a new dynamic material" picked up automatically by standard
SwiftUI, UIKit and AppKit controls and navigation, and advises: "Be judicious with your
use of color in controls and navigation so they stay legible and allow your content to
infuse them and shine through." Superdesign reports glassmorphism prompt share rising
from 5.6% to 8.2% (Jan–May 2026).
UNVERIFIED: claims that glassmorphism is fading on the web (seen only in a search-result
summary of a vendor blog, not fetched); the exact accessibility-setting adaptations
(Reduce Transparency etc.) — check Apple HIG before relying on them.
Risk: on the web, translucency over busy content breaks text contrast; it suits the
control/navigation layer, not content cards. Native apps should use the platform
material rather than imitating it in CSS.
Seen as: `backdrop-filter: blur()` on fixed navigation/toolbars with semi-transparent fills.

### trend-expressive-shape-motion — Expressive shape and motion (Material 3 Expressive)
Maps to: control Variables (shape, motion, type axes) on Android surfaces.
Status: VERIFIED. Android's Wear OS "Material 3 Expressive design language" page (last
updated 2025-05-20) describes deeper tonal palettes and a wider token set, variable font
axes for expression, and flexible container shapes whose corner radius changes to
support shape-morphing lists and button states.
UNVERIFIED: research-scale and rollout figures circulated by secondary sites (study
counts, specific device/OS rollout dates).
Risk: morphing shapes and springy motion become noise in dense tools; respect reduced
motion; on non-Android web surfaces it reads as borrowed platform style.
Seen as: corner radius changing on state; variable-font weight/width animation.

### trend-neo-brutalist — Neo-brutalism
Maps to: surface/border/shadow Variables of landing sections and cards.
Status: VERIFIED as persisting but narrowing. theplusaddons.com (2026-09-11) describes
2–5px near-black borders, zero-blur hard offset shadows, flat high-chroma fills, 0–8px
radius and hover states that move into the shadow (~100ms or less); says its useful range
is narrower than its popularity, poor for long-form reading, trust-driven sectors and
dense data; and notes Gumroad, the most-cited example, no longer uses it. Superdesign
reports brutalism under 1% of monthly prompts.
Risk: reads as a costume outside consumer/creator brands; examples in articles are often stale.
Seen as: borders ≥ 2px with `box-shadow` offsets and 0 blur; saturated flat fills.

### trend-oversized-type — Oversized, distinctive typography
Maps to: `hero-editorial`, `hero-claim-product-shot` type Variables.
Status: VERIFIED (single editorial source). IONOS (2026-07-20) lists "bold and unique
typography" — oversized, distinctive type as a central element.
Risk: breaks at 320px (mid-word breaks, 6-line headlines); low information density.
Evergreen part: a real type-ramp jump (design-craft typography).
Seen as: `h1` ≥ 4× body in the first viewport; custom display face.

### trend-nostalgia-y2k — Retro / Y2K nostalgia
Maps to: brand Variables only.
Status: VERIFIED (single editorial source). IONOS (2026-07-20) lists nostalgic web design:
retro visuals, pixel elements, Y2K styles, custom cursors.
Risk: high; strongly time-stamped and often hurts legibility. Custom cursors must not
hide the pointer position.
Seen as: pixel fonts, bevelled UI, custom `cursor` images.

### trend-immersive-3d — Interactive 3D elements
Maps to: media slot of `hero-demo-first`/`hero-split`.
Status: VERIFIED as listed by IONOS (2026-07-20): interactive 3D worlds and elements
explored by scrolling, clicking or touching.
Risk: performance and battery cost; must have a static fallback and must not hold the
primary CTA hostage to loading.
Seen as: WebGL `canvas` in the first viewport; large 3D asset downloads.

### trend-scroll-driven-narrative — Scroll-linked animation
Maps to: `feature-sticky-narrative`.
Status: VERIFIED platform status: web-features lists scroll-driven animations as
**Limited availability** — Chrome/Edge 115 (2023-07), Safari 26 (2025-09-15), not in
Firefox. IONOS (2026-07-20) lists scrolling design / parallax as a theme.
Risk: requires `@supports` gating and a no-animation path; scroll-jacking harms
usability regardless of support.
Seen as: `animation-timeline: scroll()/view()` or JS scroll listeners driving transforms.

### trend-cross-document-transitions — Animated page-to-page transitions
Maps to: navigation between any patterns.
Status: VERIFIED platform status: web-features lists cross-document view transitions as
**Limited availability** — Chrome/Edge 126 (2024-06), Safari 18.2 (2024-12-11), not in
Firefox. (Same-document view transitions: see web-platform-baseline `references/css.md`.)
Risk: low when used as progressive enhancement; respect reduced motion.
Seen as: `@view-transition { navigation: auto }` and `view-transition-name` declarations.

### trend-chat-surfaces — Chat and assistant surfaces
Maps to: `list-detail`/`split-pane` (conversation + artifact), `faq-accordion` replacement.
Status: VERIFIED (indirect). IONOS (2026-07-20) lists AI chatbots acting as shopping
assistants or replacing traditional FAQ sections; Superdesign counts 3,302 distinct
"chat" projects among requested surfaces (Jan–Jun 2026).
UNVERIFIED: that a large prompt input as the landing-page hero is an established trend
(only a commercial component listing was found; no adoption data).
Risk: a chatbot replacing the FAQ hides answers from search and skimmers; keep the
static answers. A prompt-box hero must work, or say what happens, without sign-in.
Seen as: fixed chat launcher in a corner; a large textarea as the first-viewport focal point.

### trend-neumorphism — Neumorphism
Maps to: none recommended.
Status: VERIFIED as conflicting. IONOS (2026-07-20) still lists neumorphism (with stronger contrast);
Superdesign counts only 522 lifetime prompt mentions and calls it "effectively extinct".
Treat as not current; its low-contrast default fails WCAG 1.4.11 non-text contrast unless
re-tuned.

---

## Re-verification checklist

- Re-fetch each named source; update dates; mark anything not re-confirmed UNVERIFIED.
- Re-check Baseline status for any CSS feature a trend depends on via the web-features data.
- Do not copy a statistic from a search-result summary; fetch the page it came from.
