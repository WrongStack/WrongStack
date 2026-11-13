---
id: flat-design
name: Flat Design
aesthetic: Pure flat — solid color blocks, zero elevation, hierarchy by color and scale.
tags: [flat, metro, solid, color-block, geometric, enterprise]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Dashboards, kiosks, enterprise tools, and any interface that must stay legible with no depth cues at all.
version: 1.0.0
paper: light 97 0
display: roman-serif Inter
accent: warm 40
posture: committed
photo: natural
---

# Flat Design

## Overview
The post-skeuomorphic school, taken seriously: no shadows, no gradients, no bevels,
no texture. Hierarchy comes from **solid color blocks, size, and position** — the
three things that survive at any resolution and any zoom. Descended from Windows
Metro and iOS 7, and still the right answer when depth cues are noise: kiosks seen
from three metres, dashboards on cheap panels, tools used all day.

Flat is not "minimal with the shadows deleted". Minimal uses whitespace and
hairlines to separate; flat uses **filled areas that touch**. That difference
decides every component below.

## Rules
1. Zero elevation. The shadow ramp is `none` at every step — if something must
   read as above the page, it gets a different fill, not a shadow.
2. Separation by color block, not by border. Adjacent surfaces differ in fill and
   sit edge to edge; reach for a border only when two blocks share a fill.
3. Square by default. Radius is 0 everywhere except pills (`radius-full`).
4. Saturated, confident color used in quantity — flat earns its hierarchy from
   color area, so the accent is allowed to cover whole panels, unlike every other
   kit here.
5. Geometric, single-weight line icons. No detail that implies a light source.
6. Type does the rest: one humanist sans, wide size jumps, heavy weights for
   headings rather than color changes.

## Where this kit fights a kiosk

Rule 2 — separation by fill, with blocks touching edge to edge — is correct on a
pointer-driven screen and **dangerous on a public terminal**. Two 64px targets
separated by a 1px seam means a mis-tap selects the neighbour, and the person at a
ticket machine cannot undo a purchase as easily as they can move a mouse.

On kiosk and public-terminal surfaces: keep fill separation as the visual
language, but put a real gap — one full spacing step — between adjacent
*interactive* targets. Non-interactive blocks may still touch. Measured on a fare
kiosk built with this kit: `gap-px` between zone buttons passed every token check
and every craft axis, and still failed the physical mis-tap test.

The general form of this: a kit's aesthetic rule is scoped to the surfaces the kit
was chosen for. When the surface changes the physics, the physics wins.

## Color
- Light: bg `oklch(97% 0 0)`, surface `oklch(100% 0 0)`, fg `oklch(22% 0.01 250)`,
  primary `oklch(52% 0.19 250)` (confident blue — L is 52%, not higher, because
  flat puts body text directly on this fill and 4.5:1 is the floor), accent
  `oklch(65% 0.2 40)` (orange),
  success `oklch(65% 0.18 145)`, danger `oklch(58% 0.22 27)`.
- Dark: bg `oklch(20% 0.01 250)`, surface `oklch(25% 0.012 250)`,
  fg `oklch(95% 0.005 250)`, primary `oklch(68% 0.17 250)`, accent `oklch(72% 0.17 45)`.
- Dark mode is a re-tune, not an inversion: the fills stay saturated, the ground
  darkens, and contrast is re-checked per pair.
- Because the accent covers large areas, check text-on-accent contrast at 4.5:1 —
  this is the one kit where that pairing appears constantly.

## Typography
- Humanist sans (Inter / Segoe UI / system-ui). One family, no serif pairing.
- Wide jumps between steps — flat has no depth to signal importance, so size does.
- This kit adds a step the shared ramp does not have: **`text-4xl` (3rem / 48px)**,
  for the one number or state a kiosk must be readable from two metres away. The
  shared ramp stops at `text-3xl` (30px), which is a fine display size at a desk
  and too small standing in a station. Use it for exactly one element per screen.
- Weights 400 body / 600 headings / 700 display. Avoid muted-color de-emphasis as
  the only tool; prefer size and weight.

## Components
**Do**
- Buttons: solid fill, square, no border, no shadow. Hover shifts the fill darker.
- Cards: a filled block. If two cards sit side by side, the gap is the separator.
- Inputs: filled field with a 2px underline or a solid surface change on focus.
- Nav: a filled bar; the active item is a different fill, not an underline.
- Status: filled banner with an icon and text.

**Don't**
- No shadow, ever — not even a "subtle" one. That is the whole kit.
- No gradient, no glass, no rounded card corners.
- No hairline border where a fill difference would do the job.

## Motion
- Fast and linear-ish: 100–160ms, `cubic-bezier(0.4, 0, 0.6, 1)`. Movement is
  positional or a fill change, never a scale or a shadow bloom.
- Honor `prefers-reduced-motion`: drop to instant fill changes.

## Stack: web
- Tailwind v4 `@theme` with the kit tokens; every `shadow-*` resolves to `none`.
```css
@theme {
  --color-bg: oklch(97% 0 0);
  --color-primary: oklch(58% 0.19 250);
  --radius-lg: 0;
  --shadow-1: none;
}
```
- shadcn/ui primitives work once the theme is imported; override their radius to 0
  at the token level rather than per usage.

## Stack: react-native
- Theme constants only; never set `shadowOpacity`/`elevation` — the ramp is `none`
  by design. Separation comes from `backgroundColor` differences and `scale` gaps.
- `Pressable` with `android_ripple` disabled; use a pressed-fill style instead.

## Stack: flutter
- `ColorScheme.fromSeed` with the blue primary, `useMaterial3: true`, then set
  `elevation: 0` on every surface (`CardTheme`, `AppBarTheme`, `ButtonStyle`).
- `RoundedRectangleBorder(borderRadius: BorderRadius.zero)`.

## Stack: swiftui
- Asset-catalog colors; `.buttonStyle(.borderedProminent)` with
  `.buttonBorderShape(.roundedRectangle(radius: 0))`; no `.shadow` modifiers.
- Separate sections with background fills, not `Divider()`.

## Stack: compose
- Material 3 with `shape = RectangleShape` and `tonalElevation = 0.dp`,
  `shadowElevation = 0.dp` on `Surface` and `Card`.
