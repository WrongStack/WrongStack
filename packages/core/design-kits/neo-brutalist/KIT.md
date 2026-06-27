---
id: neo-brutalist
name: Neo-Brutalist
aesthetic: Raw, bold, anti-design — hard borders, blunt shadows, mono type, high contrast.
tags: [brutalism, bold, edgy, expressive, anti-design]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Creative portfolios, subculture brands, dev tools with attitude, launch/landing pages that must stand out.
version: 1.0.0
---

# Neo-Brutalist

## Overview
Loud, honest, and confident. Thick black borders, flat blocks of saturated color,
chunky offset "hard" shadows, and unapologetic typography. Nothing is soft — corners
are sharp or barely rounded, shadows don't blur, and contrast is maximal. Done well
it reads as designed-on-purpose, not unfinished.

## Rules
1. Thick borders everywhere: 2–4px solid, near-black (or near-white in dark).
2. Hard offset shadows: `4px 4px 0 #000` — zero blur. Shadow is a design element.
3. Flat, saturated color blocks. No gradients, no soft shadows.
4. Big, tight, confident type — often uppercase, mono or grotesque.
5. Visible structure: show the grid, let elements collide and overlap intentionally.
6. Interactions are physical: press = shift toward the shadow (translate + remove shadow).

## Color
- Light: paper `oklch(97% 0.02 95)` (warm off-white), ink `oklch(15% 0 0)`,
  primary electric `oklch(72% 0.2 145)` (lime), accent `oklch(70% 0.2 25)` (red-orange),
  pops of `oklch(80% 0.18 200)` (cyan) / `oklch(85% 0.19 95)` (yellow).
- Dark: bg `oklch(16% 0 0)`, ink `oklch(96% 0 0)`, same saturated accents.

## Typography
- Display: Space Grotesk / Archivo / a heavy grotesque. Mono: JetBrains Mono / Space Mono.
- Big jumps in scale, tight tracking, heavy weights (700–900) for headings; uppercase labels.

## Components
**Do**
- Buttons/cards/inputs: solid fill + 3px border + `4px 4px 0` hard shadow.
- On hover: translate(-2px,-2px) + grow shadow to `6px 6px 0`; on press: translate to shadow, remove it.
- Tag/badge chips with borders; sticker-like overlapping layout.

**Don't**
- No blur, no soft shadows, no subtle grays-on-grays. No timid pastel-only palettes.
- Keep contrast high — borders and text must hit AAA where possible.

## Motion
- Snappy, mechanical: 80–140ms, `steps()` or sharp ease. Things "clack" into place.
- Reduced-motion: keep the shadow/translate state changes instant.

## Stack: web
- Tailwind v4 utility set: `border-[3px] border-black shadow-[4px_4px_0_#000] rounded-none active:translate-x-1 active:translate-y-1 active:shadow-none`.
- Use CSS vars for the accent blocks; avoid shadcn's soft defaults — override radius/shadow tokens.

## Stack: react-native
- NativeWind borders + a manually-drawn offset shadow `View` (RN has no hard-shadow primitive):
  stack a black `View` offset by 4px behind the element. `Pressable` shifts it on press.

## Stack: flutter
- `Container(decoration: BoxDecoration(border: Border.all(width:3), boxShadow:[BoxShadow(offset: Offset(4,4), blurRadius: 0)]))`,
  `Colors`-flat fills, `RoundedRectangleBorder(0)`; press animates offset.

## Stack: swiftui
- `RoundedRectangle(cornerRadius: 0).stroke(.black, lineWidth: 3)` + a `.offset` black shadow rect;
  bold `.font(.system(.title, design: .monospaced).weight(.black))`.

## Stack: compose
- `Modifier.border(3.dp, Color.Black)` + custom offset shadow `Box`; flat `Color` fills;
  `RoundedCornerShape(0.dp)`; mono `FontFamily.Monospace`, `FontWeight.Black`.
