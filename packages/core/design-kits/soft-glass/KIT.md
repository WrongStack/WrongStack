---
id: soft-glass
name: Soft Glass
aesthetic: Refined glassmorphism — frosted translucent layers, depth, vibrant-but-tasteful.
tags: [glassmorphism, depth, modern, premium, blur]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Premium consumer apps, dashboards over imagery, OS-like surfaces, Apple-adjacent products.
version: 1.0.0
---

# Soft Glass

## Overview
2026 glassmorphism done with restraint: translucent frosted panels floating over a
soft, colorful backdrop, with real depth from layered blur, thin luminous borders,
and gentle inner glow. The trick is **intent** — glass for elevated surfaces only
(nav, cards, modals), never for body text containers where contrast suffers.

## Rules
1. Glass = elevated layers only. Keep reading surfaces solid for contrast.
2. Backdrop matters: a subtle gradient/mesh or imagery gives the blur something to do.
3. Thin 1px border at ~30–50% white (light) / 12% white (dark) for the "edge of glass".
4. Layer depth with blur + translucency + soft shadow, not heavy drop shadows.
5. Keep text on glass at AA — add a translucent scrim behind text if needed.
6. Rounded 16–24px corners; airy padding.

## Color
- Backdrop: soft gradient, e.g. `oklch(96% 0.03 280)` → `oklch(94% 0.05 230)` (light),
  deep `oklch(22% 0.05 280)` → `oklch(18% 0.06 250)` (dark).
- Glass fill: `oklch(100% 0 0 / 0.55)` light, `oklch(30% 0.02 270 / 0.45)` dark.
- Accent: vivid violet `oklch(62% 0.2 290)`; secondary cyan `oklch(72% 0.13 220)`.

## Typography
- Sans: SF Pro / Inter. Medium weights read best on translucent surfaces.
- Slightly larger body (16–17px) and increased letter-spacing on labels for legibility.

## Components
**Do**
- Cards/nav/modals: `backdrop-blur` + translucent fill + 1px luminous border + soft shadow.
- Buttons: frosted secondary, solid vivid primary; gentle inner highlight on top edge.
- Use a faint top-edge highlight (`inset 0 1px 0 white/40%`) to fake light refraction.

**Don't**
- Don't stack glass on glass on glass — 2 depth levels max in view.
- Don't put long-form text directly on busy blurred imagery without a scrim.

## Motion
- Smooth springy reveals (scale 0.96→1 + blur-in). 200–320ms. Parallax backdrop on scroll (subtle).
- Reduced-motion: skip scale/parallax, fade only.

## Stack: web
- Tailwind v4: `bg-white/55 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl`.
- Dark: `dark:bg-white/10 dark:border-white/15`. Provide a `--scrim` for text blocks.
- Animate with Motion: `initial={{opacity:0, scale:0.96, filter:'blur(8px)'}}`.

## Stack: react-native
- `expo-blur` `<BlurView intensity={40} tint=...>` for frosted panels; NativeWind for tint/border.
- Reanimated spring scale-in; gradient backdrop via `expo-linear-gradient`.

## Stack: flutter
- `BackdropFilter(ImageFilter.blur(sigmaX:20,sigmaY:20))` inside `ClipRRect`; translucent
  `Container` color `Colors.white.withOpacity(0.5)`, 1px white24 border, M3 seed for accents.

## Stack: swiftui
- `.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))` — native materials
  are the canonical glass; `.overlay(stroke white.opacity(0.3))`; gradient `MeshGradient` backdrop.

## Stack: compose
- `Modifier.blur()`/`graphicsLayer` + translucent `Surface(color = ... .copy(alpha=0.5))`,
  Material 3 accents, `Brush.linearGradient` backdrop, thin border via `border()`.
