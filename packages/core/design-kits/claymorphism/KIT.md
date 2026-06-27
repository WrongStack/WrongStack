---
id: claymorphism
name: Claymorphism
aesthetic: Soft 3D clay — puffy inflated shapes, double soft shadows, pastel, tactile.
tags: [clay, 3d, soft, playful, tactile, pastel]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Friendly consumer apps, kids/education, onboarding, fun dashboards, app store-style marketing.
version: 1.0.0
---

# Claymorphism

## Overview
Soft, inflated "clay" UI: big rounded shapes that look puffy and pressable, created with
a pair of soft shadows (one dark outer, one light inner highlight) on pastel surfaces.
Tactile and toy-like — everything invites a tap. Cousin of neumorphism but higher
contrast and more colorful, so it stays accessible.

## Rules
1. Big radii (24–40px) and chunky padding — shapes feel inflated, not flat.
2. The clay effect = outer soft drop shadow + inner top-light highlight + subtle bottom inner shadow.
3. Pastel, slightly desaturated surfaces; a friendly saturated primary for CTAs.
4. Keep enough contrast: unlike neumorphism, text/controls must stay AA (don't bury them in same-tone).
5. Layer depth with shadow strength, not borders. Icons get the same puffy treatment.
6. Press = shape "squishes" (scale down + reduce shadow).

## Color
- Light: bg `oklch(95% 0.03 280)` (soft lilac), clay surface `oklch(97% 0.02 280)`, primary
  `oklch(70% 0.16 295)`, secondary `oklch(78% 0.12 200)`, fg `oklch(30% 0.04 285)`.
- Dark: bg `oklch(26% 0.03 285)`, surface `oklch(31% 0.03 285)`, fg `oklch(94% 0.02 285)`.

## Typography
- Rounded, friendly sans: Quicksand / Baloo / SF Rounded. Medium-bold weights.

## Components
**Do**
- Buttons/cards/inputs: big radius + clay shadow stack; icons in puffy rounded containers.
- Toggles/sliders that look squishy; bottom-nav with inflated active pill.
- Tap: `scale(0.96)` + softer shadow; success with a bouncy puffy checkmark.

**Don't**
- Don't sacrifice contrast for the effect (the neumorphism trap). No sharp corners or hard 1px borders.

## Motion
- Soft springs with slight squish on press (200–300ms). Gentle, bouncy, never harsh.
- Reduced-motion: simple opacity/scale, no bounce.

## Stack: web
- Tailwind v4: `rounded-[2rem]` + a clay shadow utility:
  `shadow-[0_12px_24px_rgba(0,0,0,0.12),inset_0_2px_4px_rgba(255,255,255,0.7),inset_0_-6px_12px_rgba(0,0,0,0.06)]`;
  pastel token surfaces; Motion springs with active scale.

## Stack: react-native
- Layered shadows are limited on RN — approximate with `react-native-shadow-2` or stacked Views;
  big radii; Reanimated squish on press; pastel NativeWind tokens.

## Stack: flutter
- `Container` with multiple `BoxShadow` (outer dark + light highlight) + large `BorderRadius`;
  `AnimatedScale` squish; pastel M3 seed.

## Stack: swiftui
- `RoundedRectangle(cornerRadius: 32)` with `.shadow` (dark) + `.overlay` light highlight gradient;
  spring `.bouncy` press scale; pastel asset colors.

## Stack: compose
- `Modifier.shadow` + inner highlight via `Brush` overlay; `RoundedCornerShape(32.dp)`; `spring(Bouncy)` press;
  pastel M3 scheme.
