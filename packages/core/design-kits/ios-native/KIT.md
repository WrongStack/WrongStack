---
id: ios-native
name: iOS Native (HIG)
aesthetic: Apple Human Interface Guidelines — clarity, deference, depth, native materials.
tags: [ios, apple, hig, native, mobile, liquid-glass]
stacks: [swiftui, react-native, web, flutter]
themes: [light, dark]
bestFor: iOS apps that should feel truly native, plus web/RN that wants an Apple-grade feel.
version: 1.0.0
---

# iOS Native (HIG)

## Overview
The Apple idiom: content-first clarity, deference (UI defers to content), and depth via
translucent **materials** and layering. Uses system semantics — SF Pro + SF Symbols,
Dynamic Type, system colors, standard navigation patterns, and the modern translucent
("Liquid Glass") chrome. The result feels at home on iOS, not ported to it.

## Rules
1. Clarity, deference, depth. Let content lead; chrome is translucent and recedes.
2. Use **system semantics**: SF Pro text styles (Dynamic Type), SF Symbols, semantic colors
   (`label`, `secondaryLabel`, `systemBackground`, `tint`). Don't hard-code grays.
3. Standard navigation: large titles, nav bars, tab bars, sheets, swipe-back, context menus.
4. Materials for depth (`ultraThin`…`thick`), not heavy shadows. Respect safe areas.
5. Controls follow platform metrics & a11y: 44pt targets, VoiceOver, Reduce Motion/Transparency.
6. One tint color drives interactive elements; otherwise neutral system surfaces.

## Color & type
- Semantic system colors with automatic light/dark; a single app `tint`.
- SF Pro (Text/Display) via system fonts; Dynamic Type text styles (`.largeTitle`…`.caption`).

## Components
**Do**
- `NavigationStack` with large titles; `TabView`; `.sheet`/`.presentationDetents`; `List` (inset grouped);
  `Form` for settings; `Menu`/context menus; `.searchable`.
- Buttons: `.borderedProminent` primary, `.bordered`/`.plain` secondary; SF Symbols in controls.
- Materials: `.regularMaterial`/`.ultraThinMaterial` toolbars and cards; `.background` safe-area aware.

**Don't**
- Don't reinvent native controls or navigation. Don't fight Dynamic Type. Avoid custom non-semantic grays.

## Motion
- Native, physics-based (`.snappy`/`.bouncy`/`.smooth`); standard push/sheet transitions.
- Honor Reduce Motion (cross-fade instead of slide) and Reduce Transparency (solid fallback).

## Stack: swiftui
- SwiftUI is the native target. `NavigationStack`, `List(.insetGrouped)`, `.toolbar`, `.sheet`,
  `.tint`, `Label("...", systemImage: "...")`, `@Environment(\.colorScheme)`, `.dynamicTypeSize`.
- Materials via `.background(.regularMaterial)`; `@ScaledMetric` for adaptive spacing.

## Stack: react-native
- Match HIG: large-title header, native-feeling tab bar, action sheets, swipe-back; SF Symbols via
  `sf-symbols`/`expo-symbols`; `expo-blur` for materials; respect Dynamic Type (`allowFontScaling`),
  safe-area insets; haptics on key actions.

## Stack: web
- Apple-like web: SF Pro/`-apple-system` stack, translucent sticky headers (`backdrop-blur`),
  inset-grouped list styling, generous spacing, `prefers-reduced-transparency`/`-motion` fallbacks.

## Stack: flutter
- Use `cupertino` widgets: `CupertinoApp`/`CupertinoNavigationBar`/`CupertinoButton`/`CupertinoListSection`;
  `CupertinoColors` semantic; SF font; respect `MediaQuery` text scale + reduce-motion.
