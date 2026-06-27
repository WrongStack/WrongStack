---
id: material-expressive
name: Material 3 Expressive
aesthetic: Google Material 3 Expressive — dynamic color, bold shapes, lively motion.
tags: [material, android, m3, expressive, dynamic-color, google]
stacks: [compose, flutter, web, react-native]
themes: [light, dark]
bestFor: Android apps and cross-platform products that want Google's expressive, adaptive system.
version: 1.0.0
---

# Material 3 Expressive

## Overview
Material 3 in its expressive form: dynamic, user-personalized color (from a seed or
wallpaper), an expanded **shape** library, flexible type, and physics-based **motion**
that gives the UI character. Components are tonal and adaptive; emphasis comes from
color roles, shape, and motion rather than borders and shadows.

## Rules
1. Color **roles**, not raw colors: `primary`/`onPrimary`/`primaryContainer`/`surface`/`surfaceVariant`/
   `outline`… generated from a seed via tonal palettes (or dynamic color where available).
2. Tonal elevation: surfaces lift via tint/elevation, not heavy drop shadows.
3. Expressive shapes: varied corner families (rounded → larger, some asymmetric); the M3 shape scale.
4. Motion physics: spring-based, emphasized easing; container transforms between states; expressive but purposeful.
5. Components from the M3 set (FAB, extended FAB, chips, navigation bar/rail, cards, split button).
6. Accessibility: dynamic-contrast aware, large touch targets, honor system animation scale.

## Color & type
- Seed-based scheme: light + dark from `ColorScheme.fromSeed` / dynamic color. Roles drive everything.
- Type: Roboto / Google Sans Flex with the M3 type scale (display/headline/title/body/label).

## Components
**Do**
- Navigation bar/rail; FAB & extended FAB; assist/filter/input chips; `Card`/`ElevatedCard`;
  filled/tonal/outlined/text buttons; the new **split button**; large expressive shapes for hero elements.
- Emphasis via `primaryContainer`/`secondaryContainer` fills; tonal surfaces by elevation.

**Don't**
- Don't hard-code hex outside the scheme. Don't lean on shadows/borders for hierarchy — use tone + shape.

## Motion
- Spring physics + emphasized easing; shared-axis / container-transform transitions; expressive overshoot.
- Honor `Settings.Global` animation scale / reduce-motion: fall back to fades.

## Stack: compose
- Jetpack Compose + Material 3 (`androidx.compose.material3`, expressive APIs). `MaterialTheme` with
  `dynamicColorScheme()` (Android 12+) or `lightColorScheme()/darkColorScheme()` from a seed;
  `Scaffold` + `NavigationBar`; `FloatingActionButton`; `MaterialShapes`; `spring()`/`MotionScheme`.

## Stack: flutter
- Flutter 3.41+ `useMaterial3: true`, `ColorScheme.fromSeed(...)` (+ `dynamic_color` package);
  `NavigationBar`, `FilledButton`, `Card`, `Chip`; `MaterialApp` themeMode; expressive shapes via
  `ShapeBorder`; animate with `AnimatedContainer`/implicit + spring curves.

## Stack: web
- Material Web (`@material/web`) or an M3 token system: generate roles from a seed (material-color-utilities),
  expose as CSS custom properties (light/dark), tonal surfaces, M3 shape/type scales; motion via Web Animations.

## Stack: react-native
- `react-native-paper` (Material 3) with `MD3LightTheme`/`MD3DarkTheme` from a seed; `FAB`, `Chip`,
  `Card`, navigation bar; Reanimated springs for expressive transitions; dynamic color where available.
