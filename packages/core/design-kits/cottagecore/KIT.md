---
id: cottagecore
name: Cottagecore
aesthetic: Soft pastoral — florals, warm cream, sage/rose, handmade nostalgic charm.
tags: [cottagecore, pastoral, floral, soft, nostalgic, handmade]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Crafts, food/bakery, weddings, gardening, slow-living and handmade brands.
version: 1.0.0
---

# Cottagecore

## Overview
Gentle rural nostalgia: warm creams, soft sage and dusty rose, delicate floral motifs,
hand-drawn details, and rounded friendly type. Cozy, romantic, handmade. Everything feels
softly lit, a little vintage, and made with care — like a sunlit cottage kitchen.

## Rules
1. Warm cream base with soft sage, dusty rose, butter-yellow, faded blue accents.
2. Delicate floral/botanical motifs and hand-drawn doodles as decoration.
3. Rounded friendly type; optional handwritten/script accents.
4. Soft, gentle shadows; rounded corners; gingham/floral patterns subtly.
5. Warm, slightly faded/vintage tone throughout.
6. Maintain AA — soft ≠ low-contrast for text.

## Color
- Light: cream `oklch(96% 0.02 90)`, sage `oklch(74% 0.06 145)`, rose `oklch(78% 0.08 15)`, butter `oklch(90% 0.1 95)`, faded blue `oklch(74% 0.05 235)`, fg `oklch(35% 0.03 60)`.
- Dark: warm dusk `oklch(28% 0.02 60)`, fg `oklch(92% 0.02 85)`, muted florals.

## Typography
- Rounded humanist sans + optional script accent; soft serif for headings works too.

## Components
**Do**
- Floral-bordered cards, soft pastel buttons, botanical doodle accents, gingham/floral pattern backdrops, rounded inputs.
**Don't**
- No harsh/neon color, no sharp tech edges, no heavy shadows. Keep it soft and warm.

## Motion
- Gentle, breezy: soft fades, petals/leaves drift subtly. 250–400ms.
- Reduced-motion: static.

## Stack: web
- Tailwind v4 soft pastel tokens; floral SVG borders/doodles; rounded; gingham/floral CSS pattern; script accent font.
## Stack: react-native
- Soft pastel NativeWind; svg florals; rounded; pattern backdrops; gentle Reanimated drift.
## Stack: flutter
- Soft M3 seed; `flutter_svg` florals; rounded `Card`; pattern image; gentle animations.
## Stack: swiftui
- Soft asset pastels; vector florals; rounded shapes; pattern overlay; breezy motion.
## Stack: compose
- Soft M3; vector florals; rounded `Card`; pattern; gentle `tween`.
