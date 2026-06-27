---
id: comic-pop
name: Comic Pop
aesthetic: Comic book pop-art — halftone dots, bold outlines, Ben-Day, POW! energy.
tags: [comic, pop-art, halftone, bold, fun, retro]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Entertainment, games, kids/teens, promos, playful bold marketing.
version: 1.0.0
---

# Comic Pop

## Overview
Lichtenstein/comic-book pop art: thick black outlines, Ben-Day halftone dot textures,
primary pop colors, speech bubbles, action bursts ("POW!"), and bold condensed lettering.
High-energy and fun. Outlines + halftone are the signature; keep one clear focal panel.

## Rules
1. Thick black outlines on everything; flat primary pop fills.
2. Ben-Day halftone dot textures as shading/backdrop.
3. Speech bubbles, action bursts/starbursts, motion lines, "POW/BAM" lettering.
4. Bold condensed display type; comic lettering for accents.
5. Panel-grid layouts (like comic pages); one clear hero panel.
6. Keep text legible on solid fills (not on halftone).

## Color
- Light: bg `oklch(97% 0.02 95)`, red `oklch(60% 0.22 27)`, yellow `oklch(88% 0.18 95)`, blue `oklch(58% 0.18 250)`, ink `oklch(15% 0 0)`.
- Dark: bg `oklch(18% 0 0)`, same pops.

## Typography
- Display: bold condensed (Bangers / Anton) + comic lettering for bursts; clean sans for body.

## Components
**Do**
- Outlined cards/buttons; halftone backdrops; speech bubbles; burst badges; panel grids; motion lines on hover.
**Don't**
- No gradients/soft shadows; don't put text on halftone; avoid muted palettes.

## Motion
- Punchy: pop/scale-in, burst flashes, shake on action. 120–250ms spring.
- Reduced-motion: static, no shake.

## Stack: web
- Tailwind v4 pop tokens; thick `border-black`; halftone via `radial-gradient` dot pattern; speech-bubble SVG; comic font vars.
## Stack: react-native
- Pop palette; thick borders; halftone svg; speech bubbles; Reanimated pop/shake.
## Stack: flutter
- Pop `ColorScheme`; bordered containers; `CustomPaint` halftone + bursts; comic `google_fonts`.
## Stack: swiftui
- Pop asset colors; thick `.border`; `Canvas` halftone/bursts; comic `Font`; pop animations.
## Stack: compose
- Pop M3; border; `Canvas` halftone/bursts; comic `FontFamily`; spring pop.
