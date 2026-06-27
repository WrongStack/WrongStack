---
id: _foundations
name: Foundations (mandatory baseline)
aesthetic: Cross-cutting rules every UI must satisfy regardless of kit.
tags: [responsive, accessibility, theming, motion, baseline]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: The non-negotiable quality floor applied under every design kit.
version: 1.0.0
---

# Foundations — the quality floor

These rules apply to **every** UI you build, on top of whichever design kit is
active. They are not optional and not stylistic — they are correctness.

## Responsive & adaptive
- **Mobile-first.** Design the smallest viewport first, then enhance upward.
- Fluid layout: use a 4/8px spacing scale, `clamp()`/min-max for type and gutters,
  container queries where supported instead of only viewport breakpoints.
- Respect device safe areas (notches, home indicators, status bars).
- Touch targets ≥ 44×44px; never rely on hover for essential actions.
- Test at 320px, 768px, 1024px, 1440px. No horizontal scroll at any width.

## Theming — light AND dark from one token set
- Define **semantic** tokens (`bg`, `surface`, `fg`, `muted`, `primary`, `accent`,
  `border`, `ring`, `success`, `warning`, `danger`) — never hard-code raw colors in
  components.
- Ship light and dark values for every token. Dark is not "invert"; re-tune
  lightness/chroma so contrast and hierarchy survive.
- Prefer **OKLCH** for perceptually even ramps. Respect `prefers-color-scheme`
  and allow a manual override.

## Accessibility (WCAG 2.2 AA)
- Semantic structure: real landmarks/roles, one `h1`, ordered headings, labelled
  controls, `alt` text.
- Contrast: ≥ 4.5:1 body text, ≥ 3:1 large text and meaningful UI/icon edges.
- Visible `:focus-visible` ring on every interactive element. Full keyboard
  operability; logical tab order; manage focus for dialogs/menus.
- Don't encode meaning in color alone. Announce async state with live regions.

## Motion
- Motion clarifies, never decorates. Default 150–250ms, eased (`ease-out` enter,
  `ease-in` exit). Animate transform/opacity, not layout.
- **Always** honor `prefers-reduced-motion`: drop to instant/﻿opacity-only.

## Performance & polish
- No layout shift: reserve space for images/media (width/height or aspect-ratio).
- Skeletons/optimistic states over spinners for known shapes.
- Ship empty, loading, and error states for every data view — not just the happy path.

## Stack: web
- React 19 + TypeScript, Tailwind v4 (`@theme` + OKLCH custom properties), shadcn/ui
  primitives (data-slot, `sonner` for toasts), Motion for animation.
- Theme via CSS variables on `:root` / `.dark`; never inline color literals.
- Use `next/image` or `<img>` with explicit dimensions + `loading="lazy"`.

## Stack: react-native
- Expo SDK 56+ (New Architecture), NativeWind v5 (Tailwind v4 engine), Reanimated v4
  for motion, `react-native-safe-area-context` for insets.
- Theme via NativeWind `dark:` + a color-scheme context; tokens in `tailwind.config`.

## Stack: flutter
- Flutter 3.41+ Material 3 (`useMaterial3: true`). Drive light/dark from a single
  `ColorScheme.fromSeed`; respect `MediaQuery` for text scaling and reduced motion.
- `LayoutBuilder`/`MediaQuery` for adaptivity; `Semantics` widgets for a11y.

## Stack: swiftui
- Follow the Human Interface Guidelines. Support Dynamic Type, Dark Mode
  (`@Environment(\.colorScheme)`), and Reduce Motion (`accessibilityReduceMotion`).
- Semantic colors (`Color.primary`, asset-catalog colors with light/dark variants),
  SF Symbols, safe-area aware layout.

## Stack: compose
- Jetpack Compose with Material 3 (`MaterialTheme` + dynamic color where available).
- Light/dark via `darkColorScheme()`/`lightColorScheme()`; honor system contrast and
  `Settings.Global` animation scale for reduced motion. Use semantics modifiers.
