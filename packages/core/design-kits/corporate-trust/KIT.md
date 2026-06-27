---
id: corporate-trust
name: Corporate Trust
aesthetic: Sober, accessible, enterprise — calm blues, dense forms, dependable and clear.
tags: [enterprise, fintech, corporate, accessible, forms, b2b]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Fintech, healthcare, government, B2B SaaS, admin tools — anywhere trust & compliance lead.
version: 1.0.0
---

# Corporate Trust

## Overview
Calm, credible, and exhaustively accessible. A measured blue-anchored palette,
predictable layouts, clear forms, and conservative typography. Nothing flashy —
the goal is confidence, legibility, and WCAG-AA-or-better across dense data and forms.

## Rules
1. Conservative, anchored palette: a trustworthy blue primary + neutral grays + clear semantic states.
2. Predictable structure: consistent header/sidebar/content; obvious primary actions; no surprises.
3. Forms are first-class: clear labels above fields, helper + error text, inline validation, logical grouping.
4. Accessibility above the floor — aim AAA on body text; visible focus; full keyboard + screen-reader support.
5. Moderate density with clear grouping; generous enough to scan, compact enough to be efficient.
6. Restrained motion; nothing that could feel unserious.

## Color
- Light: bg `oklch(98% 0.004 250)`, surface white, fg `oklch(25% 0.02 255)`, primary
  `oklch(48% 0.13 255)`; success `oklch(55% 0.13 150)`, warning `oklch(70% 0.15 80)`, danger `oklch(53% 0.18 27)`.
- Dark: bg `oklch(19% 0.012 255)`, surface `oklch(23% 0.014 255)`, fg `oklch(94% 0.01 255)`.

## Typography
- Sans: Inter / IBM Plex Sans / system-ui. Clear scale, 16px base min, strong label/value contrast.

## Components
**Do**
- Buttons: solid primary, outline secondary, clear disabled state; never ambiguous.
- Inputs: label above, 1px border, 2px focus ring, helper/error slots; required + validation states.
- Tables/data: sortable headers, zebra optional, clear pagination; status via badge + text (not color alone).
- Banners/alerts for system state with icon + heading + body + action.

**Don't**
- No purely decorative gradients/animation. No color-only meaning. No cramped, label-less forms.

## Motion
- Functional only: 120–200ms ease; focus/expand/validation feedback. Reduced-motion: instant.

## Stack: web
- Tailwind v4 + shadcn/ui (Form, Input, Select, Table, Alert, Tabs); React Hook Form + Zod validation;
  semantic blue token set; `aria-*` wired; focus-visible rings everywhere.

## Stack: react-native
- NativeWind tokens; accessible `TextInput` with labels + `accessibilityLabel`/`accessibilityHint`;
  form libs (react-hook-form); clear error states; large hit targets.

## Stack: flutter
- M3 with a blue `ColorScheme.fromSeed`; `Form`/`TextFormField` with validators; `DataTable`;
  `Semantics` + `MergeSemantics`; `Banner`/`SnackBar` for state.

## Stack: swiftui
- `Form`/`Section` native forms; `.textFieldStyle(.roundedBorder)`; Dynamic Type + VoiceOver labels;
  semantic asset colors; `.accessibilityElement` grouping.

## Stack: compose
- M3 `OutlinedTextField` with `supportingText`/`isError`; `Scaffold` structure; `semantics{}` for a11y;
  blue `ColorScheme`; `DataTable`/lazy lists.
