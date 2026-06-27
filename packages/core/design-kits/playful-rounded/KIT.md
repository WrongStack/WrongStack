---
id: playful-rounded
name: Playful Rounded
aesthetic: Friendly & warm — soft rounded shapes, cozy colors, approachable and human.
tags: [friendly, rounded, consumer, warm, approachable, mobile]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Consumer mobile apps, onboarding, education, wellness, communities — anything that should feel kind.
version: 1.0.0
---

# Playful Rounded

## Overview
Soft and welcoming. Big border radii, pillowy cards, warm friendly colors, rounded
typography, and gentle illustrations/mascots. Reads approachable and human — great
for consumer mobile where the product should feel like a friend, not a tool.

## Rules
1. Generous radii everywhere (16–28px); pillowy cards with soft, diffuse shadows.
2. Warm, slightly desaturated palette; soft pastel surfaces with a friendly primary.
3. Rounded sans typography; comfortable sizes; emoji/illustration accents welcome.
4. Big, tappable, obvious controls — mobile-first ergonomics, thumb-reachable CTAs.
5. Soft depth: layered soft shadows + tints, never hard edges.
6. Encouraging microcopy + delightful but gentle micro-interactions.

## Color
- Light: bg `oklch(98% 0.01 80)` (warm cream), surface white, fg `oklch(30% 0.03 40)`,
  primary coral `oklch(70% 0.16 40)`, secondary mint `oklch(80% 0.1 160)`, sky `oklch(80% 0.1 230)`.
- Dark: bg `oklch(24% 0.02 40)`, surface `oklch(28% 0.02 40)`, fg `oklch(94% 0.01 60)`.

## Typography
- Rounded sans: Nunito / Quicksand / Baloo / SF Rounded. Friendly weights 500–700.

## Components
**Do**
- Pillowy cards: big radius + soft shadow + subtle tint. Pill buttons; large rounded inputs.
- Bottom-nav / FAB for mobile; soft segmented controls; rounded avatars; gentle empty-state illustrations.
- Tap feedback: soft scale + spring; success states with friendly checkmarks.

**Don't**
- No sharp corners or hard shadows. Avoid clinical grays. Don't crowd — keep it airy and tappable.

## Motion
- Gentle springs (low overshoot) 200–300ms; soft scale on tap; playful but calm transitions.
- Reduced-motion: simple fades.

## Stack: web
- Tailwind v4 `rounded-3xl`, soft `shadow-lg shadow-<accent>/20`; rounded font var; Motion gentle springs;
  large touch targets; mobile bottom-nav pattern.

## Stack: react-native
- NativeWind big radii + soft shadows; `Pressable` spring scale (Reanimated); bottom tab navigator;
  SF Rounded / custom rounded font; haptics on tap.

## Stack: flutter
- M3 with warm seed; `Card(shape: RoundedRectangleBorder(28))`; `FilledButton.tonal` pills;
  `NavigationBar` bottom nav; soft `BoxShadow`; gentle `AnimatedScale`.

## Stack: swiftui
- `RoundedRectangle(cornerRadius: 24)` cards with soft `.shadow`; SF Rounded `.fontDesign(.rounded)`;
  `TabView` bottom tabs; spring `.animation(.snappy)` taps; sensory feedback.

## Stack: compose
- M3 warm scheme; `RoundedCornerShape(24.dp)` cards; `NavigationBar`; soft shadow via `Modifier.shadow`;
  `spring()` tap scale; rounded `FontFamily`.
