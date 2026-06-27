---
id: editorial
name: Editorial
aesthetic: Magazine typography — serif display, asymmetric grids, big type, content-forward.
tags: [editorial, typography, magazine, content, elegant]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Blogs, publications, agencies, brand storytelling, marketing sites where words lead.
version: 1.0.0
---

# Editorial

## Overview
Typography is the interface. Big expressive serif (or contrast serif/sans pairing),
asymmetric editorial grids, generous measure, and restrained color so the words and
imagery carry the page. Think a well-set magazine spread: rhythm, hierarchy, and pace.

## Rules
1. Lead with a display serif at large sizes; let headlines breathe.
2. Asymmetric, column-based layouts — not everything centered; use the grid expressively.
3. Long-form measure 60–75ch; line-height 1.6–1.75 for body.
4. Minimal palette: ink, paper, one accent for links/marks. Color comes from imagery.
5. Real typographic detail: drop caps, pull quotes, hanging punctuation, small caps for labels.
6. Big, edge-to-edge imagery with captions.

## Color
- Light: warm paper `oklch(98% 0.01 85)`, ink `oklch(22% 0.01 60)`, accent `oklch(52% 0.16 25)` (vermillion).
- Dark: `oklch(20% 0.01 60)` bg, `oklch(94% 0.01 85)` fg, accent `oklch(70% 0.14 25)`.

## Typography
- Display serif: Fraunces / Playfair / GT Sectra. Body: Newsreader / Source Serif, or
  a clean sans (Inter) paired with the serif display for contrast.
- Expressive scale: 0.875, 1, 1.25, 1.75, 2.75, 4. Italics for emphasis, not bold.

## Components
**Do**
- Article hero: oversized serif headline, kicker (small caps), byline, lead paragraph.
- Pull quotes set large with hanging quotation marks; drop cap on first paragraph.
- Underline-on-hover links in the accent color; figure + caption pairs.

**Don't**
- Don't box everything in cards. Don't over-color. Avoid cramped measure / tight leading.

## Motion
- Quiet: text fades/rises 6–10px on scroll-in (staggered). 300–500ms ease-out.
- Reduced-motion: reveal instantly.

## Stack: web
- Tailwind v4 with a serif `--font-display`; `prose` (typography plugin) for article bodies;
  CSS `columns`/grid for asymmetric layouts; `text-balance`/`text-pretty` on headings.

## Stack: react-native
- Custom serif via `expo-font`; large `Text` hierarchy; generous `lineHeight`; reanimated FadeInUp on scroll.

## Stack: flutter
- `google_fonts` (Fraunces/Newsreader); `TextTheme` with strong display/headline scale;
  `RichText` for pull quotes/drop caps; `CustomScrollView` slivers for editorial flow.

## Stack: swiftui
- Custom serif `Font`; `Text` with `.kerning`/`.lineSpacing`; Dynamic Type respected;
  `ScrollView` with large headlines, `.italic()` for emphasis.

## Stack: compose
- `FontFamily` serif via resources; expressive `Typography` in `MaterialTheme`;
  `Text` with `lineHeight`/`letterSpacing`; lazy column with big hero items.
