---
id: health-calm
name: Health Calm
aesthetic: Reassuring healthcare — soft teal/green, rounded, accessible, trustworthy calm.
tags: [health, medical, calm, accessible, trustworthy, wellness]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Healthcare, telemedicine, mental health, pharmacy, patient apps, insurance.
version: 1.0.0
---

# Health Calm

## Overview
Reassuring and accessible: soft teal/green and gentle blue on calm light grounds, rounded
friendly shapes, large readable type, and generous spacing. Designed to reduce anxiety and
maximize clarity for a wide audience — accessibility is paramount. Trustworthy, gentle,
never clinical-cold or flashy.

## Rules
1. Calming cool palette: soft teal/green primary + gentle blue, on warm-neutral light grounds.
2. Accessibility first: large type, high contrast, big targets, clear focus, simple language.
3. Rounded, friendly shapes; generous spacing; uncluttered, one-task-per-screen flows.
4. Clear status/semantic colors (success/info/caution) with icon + text, never color alone.
5. Gentle, reassuring tone; supportive microcopy; obvious primary actions.
6. WCAG AA minimum, aim AAA on body — this audience needs it.

## Color
- Light: bg `oklch(98% 0.01 180)`, teal `oklch(62% 0.1 185)`, green `oklch(68% 0.12 150)`, blue `oklch(66% 0.1 235)`, fg `oklch(28% 0.02 200)`.
- Dark: bg `oklch(22% 0.01 200)`, fg `oklch(93% 0.01 190)`, calm teal/green.

## Typography
- Highly legible humanist sans (Inter / Source Sans); larger base size; comfortable leading.

## Components
**Do**
- Big readable cards; rounded inputs with clear labels + helper text; prominent primary buttons; status banners (icon+text); progress steps.
**Don't**
- No alarming reds-as-decoration, no tiny text, no clutter, no flashy motion. Keep it calm.

## Motion
- Soft and slow: gentle fades, calm transitions; nothing sudden. 250–400ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 calm teal/green tokens; large type scale; rounded; shadcn Form with strong a11y; status banners; focus rings.
## Stack: react-native
- Calm NativeWind; large accessible `Text`; labelled inputs (`accessibilityLabel`); big buttons; status banners.
## Stack: flutter
- Calm M3 seed; large `TextTheme`; `Form`/`TextFormField` + `Semantics`; rounded; status `Banner`/`SnackBar`.
## Stack: swiftui
- Calm asset colors; Dynamic Type large; `Form` + VoiceOver labels; rounded; clear status views.
## Stack: compose
- Calm M3; large `Typography`; `OutlinedTextField` + semantics; rounded; status banners.
