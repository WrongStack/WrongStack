---
id: linear-dark
name: Linear Dark
aesthetic: Refined product dark — Linear/Vercel-grade, subtle gradients, crisp, fast.
tags: [product, dark, refined, saas, modern, polished]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Modern SaaS apps, dev/product tools, startups wanting a polished dark-first product UI.
version: 1.0.0
---

# Linear Dark

## Overview
The current gold-standard product-dark aesthetic (Linear, Vercel, Raycast): deep near-black
neutrals with the faintest cool tint, hairline borders, subtle radial/linear gradients for
depth, a single refined accent, crisp small type, and fast micro-interactions. Looks
expensive and effortless — restraint + precision over decoration.

## Rules
1. Dark-first: deep neutral grounds with a faint cool tint; layered surfaces by tiny lightness steps.
2. Hairline 1px borders (low-contrast) define structure; almost no shadows.
3. Subtle gradients (radial glow behind hero, faint top-light on cards) for depth.
4. One refined accent (indigo/violet) for primary actions + focus; everything else neutral.
5. Crisp, smallish type; tight spacing; keyboard-first (⌘K) affordances.
6. Maintain AA; fast 100–160ms micro-interactions.

## Color
- Dark: bg `oklch(16% 0.008 270)`, surface `oklch(19% 0.01 270)`, raised `oklch(23% 0.012 270)`, fg `oklch(95% 0.008 270)`, accent `oklch(66% 0.17 275)`, border `oklch(27% 0.01 270)`.
- Light: bg `oklch(99% 0.002 270)`, fg `oklch(22% 0.015 270)`, accent `oklch(56% 0.17 275)`.

## Typography
- Inter / Geist; small crisp UI sizes; medium weights; tabular nums for data.

## Components
**Do**
- Hairline-bordered cards with faint top-light; subtle radial hero glow; refined accent buttons; ⌘K palette; compact toolbars; toasts (sonner).
**Don't**
- No heavy shadows/gradients, no loud color, no large rounded blobs. Keep it crisp and restrained.

## Motion
- Fast and subtle: 100–160ms ease; gentle accent glow on focus; smooth menu/popover transitions.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 dark-first `@theme`; hairline borders; radial-gradient hero glow; shadcn/ui dark + `cmdk` + `sonner`; refined accent ring.
## Stack: react-native
- Dark theme; hairline borders; subtle gradient hero; refined accent; command sheet; fast fades.
## Stack: flutter
- `darkColorScheme`; thin `OutlineInputBorder`/dividers; subtle gradient; accent `FilledButton`; fast `AnimatedContainer`.
## Stack: swiftui
- `.preferredColorScheme(.dark)`; thin strokes; subtle gradient bg; accent `.tint`; `.regularMaterial` popovers; quick transitions.
## Stack: compose
- `darkColorScheme`; thin borders/dividers; subtle gradient; accent `FilledButton`; fast `tween`.
