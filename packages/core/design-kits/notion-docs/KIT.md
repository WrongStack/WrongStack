---
id: notion-docs
name: Notion Docs
aesthetic: Clean knowledge-base — neutral, readable, block-based, calm and content-first.
tags: [docs, knowledge-base, content, neutral, readable, productivity]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Docs, wikis, knowledge bases, note-taking, internal tools, productivity apps.
version: 1.0.0
---

# Notion Docs

## Overview
A calm, content-first document interface in the Notion/Linear-docs lineage: neutral
warm-gray surfaces, highly readable typography, a clear block model (headings, callouts,
toggles, tables, code), and almost-invisible chrome. The content is the design; UI gets
out of the way. Emoji/icon accents add warmth without color noise.

## Rules
1. Neutral, slightly warm grays; one subtle accent for links/active states. Low chroma.
2. Block model: clear heading hierarchy, callout boxes, dividers, checklists, toggles, code blocks, tables.
3. Excellent readability: comfortable measure (~70ch), 1.5–1.65 line-height, real text hierarchy.
4. Invisible chrome: thin/low-contrast borders, hover-revealed controls, generous left margin/gutter.
5. Light icon/emoji accents per page/section; never heavy color blocks.
6. Inline formatting (code, highlight, mentions) is first-class and tasteful.

## Color
- Light: bg `oklch(99% 0.002 90)`, text `oklch(25% 0.01 75)`, muted `oklch(55% 0.01 75)`,
  accent blue `oklch(58% 0.13 250)`, callout tints (low-chroma blue/yellow/red/green), hairline `oklch(92% 0.003 90)`.
- Dark: bg `oklch(20% 0.005 75)`, surface `oklch(23% 0.006 75)`, text `oklch(92% 0.005 90)`.

## Typography
- Sans: Inter / system-ui for UI + body; mono (JetBrains Mono) for code. Clear h1–h3 scale, modest sizes.

## Components
**Do**
- Headings with hover-anchor; callout boxes (icon + tinted bg); toggles/accordions; checklists; tables; code blocks with copy.
- Slash-menu affordance; breadcrumb + sidebar tree; inline mentions/tags; subtle hover backgrounds on rows.

**Don't**
- No bold gradients, heavy shadows, or loud color. Don't crowd — whitespace and hierarchy carry it.

## Motion
- Minimal: 100–160ms ease; toggles expand smoothly; hover backgrounds fade. No flourish.
- Reduced-motion: instant expand/collapse.

## Stack: web
- Tailwind v4 neutral tokens; `prose`/typography for doc bodies; callouts as tinted bordered blocks; mono code;
  hover-revealed row controls; Motion for toggle height.

## Stack: react-native
- Neutral NativeWind; readable `Text` hierarchy; callout `View`s; collapsible sections (Reanimated layout);
  mono code blocks; comfortable padding.

## Stack: flutter
- Neutral M3; `ExpansionTile` toggles; callout `Container`s; `SelectableText`; `DataTable`; mono code; comfortable `TextTheme`.

## Stack: swiftui
- `List`/`Form` doc structure; `DisclosureGroup` toggles; callout backgrounds; `Text` + Dynamic Type; mono code;
  hover/secondary controls.

## Stack: compose
- Neutral M3; `Card`/`Surface` callouts; expandable rows (`AnimatedVisibility`); readable `Typography`; mono code blocks.
