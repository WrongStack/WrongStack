---
id: bento-dashboard
name: Bento Dashboard
aesthetic: Modular bento grid — data-dense cards, clean rhythm, product-OS polish.
tags: [dashboard, bento, data, product, cards, saas]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Dashboards, analytics, admin panels, app home screens, marketing feature grids.
version: 1.0.0
---

# Bento Dashboard

## Overview
The bento grid as a layout system: tiles of varying size packed into a clean modular
grid, each a self-contained module (stat, chart, list, action). Calm neutral chrome
lets data and accent highlights pop. The Apple/Microsoft/Google product-page idiom,
applied to real product UI.

## Rules
1. Modular grid: 12-col responsive; tiles span 1–2 rows / 1–4 cols. Consistent gap (16–24px).
2. Every tile is a rounded card with clear title, a primary metric/visual, and optional action.
3. One neutral surface system + a small set of semantic data colors (positive/negative/neutral).
4. Hierarchy by tile size and a single accent — not by many colors.
5. Numbers are first-class: tabular figures, clear units, trend deltas with direction + color + icon.
6. Reflow gracefully: tiles stack to single column on mobile in priority order.

## Color
- Light: bg `oklch(97% 0.003 250)`, card `oklch(100% 0 0)`, fg `oklch(24% 0.02 260)`,
  accent `oklch(60% 0.17 255)`; positive `oklch(65% 0.17 150)`, negative `oklch(62% 0.2 25)`.
- Dark: bg `oklch(17% 0.01 260)`, card `oklch(21% 0.012 260)`, fg `oklch(95% 0.01 260)`.

## Typography
- Sans: Inter / Geist; tabular-nums for metrics. Large metric numerals (28–40px), small muted labels.

## Components
**Do**
- Stat tile: label (muted, small) → big number → delta chip (▲/▼ + %). 
- Chart tile: title + compact legend + responsive chart; List tile: scannable rows w/ avatars.
- Hover: subtle lift (shadow + 1px). Drag-reorderable feel; skeleton tiles while loading.

**Don't**
- Don't cram — whitespace inside tiles. Don't use a rainbow of accent colors. No heavy borders + heavy shadows.

## Motion
- Tiles fade/scale-in staggered on mount (150–220ms). Numbers count-up on first paint.
- Reduced-motion: no count-up/stagger, instant.

## Stack: web
- Tailwind v4 `grid grid-cols-12 gap-4 auto-rows-[minmax(0,1fr)]`; tiles `col-span-* row-span-*`;
  shadcn `Card`; Recharts/visx for charts; Motion for stagger; `tabular-nums` utility.

## Stack: react-native
- Flex/`FlatList` grid of card `View`s; `react-native-svg` charts; NativeWind tiles;
  reanimated entrance stagger; priority-ordered single column on small screens.

## Stack: flutter
- `GridView`/`StaggeredGrid` (flutter_staggered_grid_view) of `Card`s; `fl_chart` for charts;
  M3 surfaces; `AnimatedSwitcher` for value changes.

## Stack: swiftui
- `LazyVGrid` with adaptive `GridItem`s, varying spans via custom layout; `Charts` framework;
  `.background(.regularMaterial)` cards; `.contentTransition(.numericText())` for metrics.

## Stack: compose
- `LazyVerticalGrid`/`LazyVerticalStaggeredGrid`; M3 `Card`/`ElevatedCard`; Vico/MPAndroidChart;
  `animateIntAsState` for count-up.
