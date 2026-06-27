---
id: dark-pro
name: Dark Pro
aesthetic: Dark-first pro tool — deep neutrals, neon accents, terminal/IDE precision.
tags: [dark, developer, pro, terminal, neon, technical]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Developer tools, IDEs, terminals, crypto/trading, technical dashboards, power-user apps.
version: 1.0.0
---

# Dark Pro

## Overview
A dark-first interface built for focus and density: deep, slightly-blue neutrals, a
single electric accent (and a couple of semantic neons), monospace where it counts,
and crisp hairlines. The aesthetic of a great IDE/terminal — precise, fast, low-glare.

## Rules
1. Dark-first: design the dark theme as primary; light is the secondary derivative.
2. Deep neutral base (not pure black) with layered surfaces by subtle lightness steps.
3. One electric accent + restrained semantic neons (green/amber/red) for status.
4. Density is a feature: compact rows, monospace for code/IDs/numbers, tight but legible.
5. Hairline 1px borders define structure; glow only on the accent/active states.
6. Maintain contrast (AA+) despite the dark base — text never dips below 4.5:1.

## Color
- Dark (primary): bg `oklch(17% 0.015 265)`, surface `oklch(21% 0.018 265)`, raised
  `oklch(25% 0.02 265)`, fg `oklch(93% 0.01 265)`, accent electric `oklch(72% 0.18 200)` (cyan)
  or `oklch(70% 0.2 145)` (green); status: ok `oklch(72% 0.17 150)`, warn `oklch(78% 0.15 80)`, err `oklch(66% 0.2 25)`.
- Light: bg `oklch(98% 0.004 265)`, fg `oklch(22% 0.02 265)`, same accent at lower lightness.

## Typography
- UI sans: Inter / Geist. Mono: JetBrains Mono / Geist Mono for code, IDs, metrics. Tabular nums.

## Components
**Do**
- Compact toolbars, command palette (⌘K), keyboard-first; statusable rows; monospace data columns.
- Buttons: subtle filled accent primary, ghost neutral secondary; active = accent glow ring.
- Code/terminal blocks with syntax tints; badges with neon dot + label.

**Don't**
- No pure-black + pure-white (harsh). No heavy color washes. Keep glow tasteful, not gamer-RGB.

## Motion
- Quick and precise: 100–160ms ease-out; subtle accent glow on focus; instant feedback.
- Reduced-motion: drop glows/transitions.

## Stack: web
- Tailwind v4 dark-first (`@theme` dark default, light under `.light`); shadcn/ui dark; `cmdk` palette;
  monospace utility for data; focus glow via `ring` + `shadow-<accent>/30`.

## Stack: react-native
- NativeWind dark theme default; mono font via `expo-font`; compact lists; subtle accent borders;
  command-sheet pattern; Reanimated quick fades.

## Stack: flutter
- M3 `darkColorScheme` primary; `ThemeMode.dark` default; mono `TextStyle` for data; `Material` raised
  surfaces by elevation tint; quick `AnimatedContainer`.

## Stack: swiftui
- `.preferredColorScheme(.dark)`; semantic dark asset colors; monospaced `Font.system(.body, design: .monospaced)`;
  `.tint(accent)`; subtle `.shadow` glow on focus.

## Stack: compose
- `darkColorScheme()` default; `FontFamily.Monospace` for data; tonal elevation surfaces; `.tint` accent;
  quick `animateColorAsState` on focus/active.
