---
id: minimal-clarity
name: Minimal Clarity
aesthetic: Restrained, Linear/Vercel-style minimalism — whitespace, one accent, crisp type.
tags: [minimal, saas, product, clean, professional]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Developer tools, SaaS dashboards, docs, and B2B products that must feel precise and calm.
version: 1.0.0
---

# Minimal Clarity

## Overview
Clarity over decoration. Near-neutral surfaces, a single confident accent, generous
whitespace, and a tight type scale. The interface should feel quiet, fast, and
trustworthy — every pixel earns its place. Inspired by Linear, Vercel, and Stripe.

## Rules
1. One accent color. Everything else is a neutral gray ramp.
2. Whitespace is the primary design tool — increase padding before adding borders.
3. Hairline borders (1px, low-contrast) and very soft shadows, never both heavy.
4. Small radii (6–10px). Restrained, not pill-shaped.
5. Type does the hierarchy: weight + size + muted color, not boxes and color blocks.
6. Dense but breathable: 8px rhythm, comfortable line-height (1.5 body).

## Color
- Light: paper-white bg `oklch(99% 0 0)`, ink `oklch(20% 0.02 260)`, hairline
  `oklch(92% 0.004 260)`, accent indigo `oklch(58% 0.16 264)`.
- Dark: bg `oklch(18% 0.01 260)`, surface `oklch(22% 0.012 260)`, fg
  `oklch(95% 0.01 260)`, accent `oklch(68% 0.15 264)`.
- Muted text sits ~`oklch(55% 0.02 260)` light / `oklch(68% 0.02 260)` dark.

## Typography
- Sans: Inter / Geist (system-ui fallback). Mono: Geist Mono / ui-monospace.
- Scale (rem): 0.8125, 0.875, 1, 1.125, 1.5, 2, 2.75. Tight tracking on display.
- Weights: 400 body, 500 UI labels, 600 headings. Avoid 700+.

## Components
**Do**
- Buttons: solid accent primary, subtle neutral secondary, ghost tertiary. 36–40px height.
- Cards: surface bg + 1px hairline, no shadow (or `0 1px 2px` at 4% alpha).
- Inputs: 1px border, accent focus ring (2px, 40% alpha), generous padding.
- Tables: zebra-free, hairline row dividers, muted headers.

**Don't**
- No drop shadows stacked on borders. No gradients. No more than one accent.
- No full-width hero gradients — keep it editorial and quiet.

## Motion
- Subtle: 120–180ms ease-out. Hover = 8% bg tint shift; press = 1px translate.
- Page/route: fade + 4px rise. Honor reduced-motion (opacity only).

## Stack: web
- Tailwind v4 `@theme` with OKLCH variables; shadcn/ui "new-york" with neutral base.
```css
@theme {
  --color-bg: oklch(99% 0 0);
  --color-fg: oklch(20% 0.02 260);
  --color-primary: oklch(58% 0.16 264);
  --color-border: oklch(92% 0.004 260);
  --radius: 0.5rem;
}
.dark { --color-bg: oklch(18% 0.01 260); --color-fg: oklch(95% 0.01 260); }
```
- Buttons via shadcn `<Button variant="default|secondary|ghost">`; Motion for route fades.

## Stack: react-native
- NativeWind tokens mirroring the web `@theme`; `Pressable` with `active:opacity-80`.
- Use `react-native-reanimated` `FadeIn`/`FadeInUp` (8px) entrances; thin `hairlineWidth` dividers.

## Stack: flutter
- `ColorScheme.fromSeed(seedColor: Color(0xFF5B5BD6))`, `useMaterial3: true`, small
  `RoundedRectangleBorder` radii; `FilledButton` primary, `OutlinedButton` secondary.

## Stack: swiftui
- Accent via asset-catalog color; `.buttonStyle(.borderedProminent)` primary, `.bordered`
  secondary; `Divider()` hairlines; generous `.padding()`; SF Pro + Dynamic Type.

## Stack: compose
- Material 3 with a neutral `ColorScheme`, indigo primary; `FilledTonalButton` secondary,
  `Card` with 1.dp outline; small `RoundedCornerShape(8.dp)`.
