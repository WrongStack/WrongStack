---
id: aurora-gradient
name: Aurora Gradient
aesthetic: Modern SaaS aurora — soft mesh gradients, glow, dark-friendly, dreamy depth.
tags: [gradient, saas, mesh, glow, modern, landing]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: SaaS/AI landing pages, product marketing, hero sections, sign-in screens.
version: 1.0.0
---

# Aurora Gradient

## Overview
The 2026 SaaS hero look: soft, colorful **mesh/aurora gradients** glowing behind clean
typography and crisp UI, with subtle grain to avoid banding. Reads premium and modern,
especially in dark mode where the glow does the work. Used by AI/dev-tool landing pages.

## Rules
1. Aurora backdrop: 2–4 blurred color blobs (mesh gradient) behind content; keep it subtle, not neon soup.
2. Add fine grain/noise over gradients to prevent banding.
3. Content stays clean: high-legibility neutral text on solid/very-translucent panels above the glow.
4. One or two accent hues sampled from the aurora carry buttons/links.
5. Glow accents: soft outer glow on the primary CTA and key cards.
6. Great in dark mode — design dark-first, then a lighter variant.

## Color
- Dark (primary): bg `oklch(16% 0.02 270)`; aurora blobs violet `oklch(60% 0.2 290)`,
  blue `oklch(62% 0.17 250)`, teal `oklch(70% 0.12 200)`; fg `oklch(96% 0.01 270)`.
- Light: bg `oklch(99% 0.005 270)` with pastel aurora (lower chroma); fg `oklch(24% 0.02 270)`.

## Typography
- Sans: Geist / Inter; large tight display for hero; gradient text only on the hero headline.

## Components
**Do**
- Hero: mesh gradient bg + grain + big headline + gradient CTA with soft glow.
- Cards: near-solid surface with thin border + faint inner glow; floating above the aurora.
- Gradient borders (conic/linear) on featured cards; pill nav with blur.

**Don't**
- Don't gradient everything — content panels stay calm. Avoid banding (always add grain).

## Motion
- Slow drifting aurora (very subtle, 8–20s loop); CTA glow pulse; reveal on scroll.
- Reduced-motion: freeze the aurora, static gradient.

## Stack: web
- Tailwind v4 + a mesh gradient (CSS radial-gradients or an SVG/`<canvas>` mesh); `bg-[radial-gradient(...)]`;
  grain via a tiling PNG/SVG `mix-blend-overlay`; gradient text `bg-clip-text`; Motion drift on blobs.

## Stack: react-native
- `expo-linear-gradient` + layered blurred `View`s for blobs; `@react-native-masked-view` for gradient text;
  Reanimated slow loop on blob positions.

## Stack: flutter
- Stacked `Container`s with `RadialGradient`/`ImageFilter.blur` blobs; `ShaderMask` for gradient text;
  `AnimationController` slow drift; grain overlay image.

## Stack: swiftui
- `MeshGradient` (native) or layered blurred `Circle().fill(gradient)`; `.foregroundStyle(LinearGradient)` text;
  `TimelineView` slow animation; `.background` glow via blur.

## Stack: compose
- `Brush.radialGradient` blobs in a `Box` with `blur`; `Brush` on `Text` via `TextStyle`;
  `rememberInfiniteTransition` slow drift; noise overlay.
