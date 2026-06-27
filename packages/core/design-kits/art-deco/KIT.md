---
id: art-deco
name: Art Deco
aesthetic: 1920s glamour — geometric symmetry, gold on deep tones, fan/chevron motifs.
tags: [art-deco, luxury, geometric, 1920s, gold, elegant]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Luxury, hospitality, events, spirits/cocktails, premium invites and brands.
version: 1.0.0
---

# Art Deco

## Overview
Gatsby-era glamour: strong geometric symmetry, sunburst/fan/chevron motifs, gold or brass
linework on deep emerald/navy/black, and elegant high-contrast display type. Opulent yet
ordered. Symmetry, fine gold lines, and stepped geometric forms define it.

## Rules
1. Symmetry and geometry: centered, mirrored, stepped/ziggurat forms.
2. Gold/brass fine linework on deep, rich grounds (emerald, navy, black, oxblood).
3. Motifs: sunbursts, fans, chevrons, geometric borders/frames.
4. Elegant display type (geometric or high-contrast serif), letter-spaced.
5. Restrained palette — one metallic + 1–2 deep jewel tones.
6. Maintain AA — gold-on-dark works; avoid gold-on-light for body.

## Color
- Dark: bg emerald/black `oklch(22% 0.05 165)`, gold `oklch(78% 0.11 85)`, ivory `oklch(94% 0.02 90)`, accent oxblood `oklch(40% 0.12 25)`.
- Light: ivory bg `oklch(96% 0.01 90)`, deep ink `oklch(20% 0.03 165)`, gold accent.

## Typography
- Display: geometric deco (e.g. Poiret One / a deco sans) or high-contrast serif; letter-spaced caps.

## Components
**Do**
- Gold-line frames/borders, sunburst dividers, symmetric layouts, stepped headers, thin-rule buttons with gold.
**Don't**
- No asymmetric chaos, no gradients/blobs, no neon. Keep linework fine.

## Motion
- Elegant, measured: gold lines draw in, symmetric reveals. 300–500ms ease.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 deep+gold tokens; SVG deco frames/sunbursts; thin gold borders; letter-spaced caps; symmetric grid.
## Stack: react-native
- Deep theme + gold; svg deco frames; thin-border buttons; centered symmetric layout.
## Stack: flutter
- Deep `ColorScheme` + gold; `CustomPaint` sunburst/frames; `OutlinedButton` gold; symmetric layout.
## Stack: swiftui
- Deep asset colors + gold tint; `Canvas` deco frames; thin stroke buttons; letter-spaced `Text`.
## Stack: compose
- Deep M3 + gold; `Canvas` deco; outlined gold buttons; letter-spaced caps.
