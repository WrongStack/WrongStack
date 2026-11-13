---
id: grunge-press
name: Grunge Press
aesthetic: Worn screenprint — stamped ink, torn edges, dirty neutrals, oxide red.
tags: [grunge, distressed, punk, zine, texture, streetwear]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Music, streetwear, zines, festivals and event sites — anything that should look printed and worn rather than rendered.
version: 1.0.0
paper: light 88 80
display: display-condensed Oswald
accent: warm 30
posture: committed
photo: duotone fg surface con=18
---

# Grunge Press

## Overview
Printed, not rendered. The surfaces read as ink stamped on cheap stock: misregistered
edges, dirty neutrals, one oxide red doing all the shouting. Every "imperfection" is
deliberate and repeated — a torn edge that appears once is a mistake, the same torn
edge used in one role throughout is a system.

Distinct from `neo-brutalist`, which is clean and hard: raw borders, pure contrast,
nothing dirty. This kit is **dirty** — the contrast is there, but it arrives through
texture and worn ink rather than through crisp geometry.

## Rules
1. Neutrals are never neutral. Every grey carries a little warm chroma — ash, not
   grey. Pure `#000`/`#fff` are the two colors this kit forbids outright.
2. One shouting color (oxide red). It marks the thing that matters and nothing else;
   the dirt does the rest of the work.
3. Edges are stamped, not drawn: hard offset shadows with no blur, thick borders,
   and `clip-path` for torn edges. Never a soft drop shadow.
4. Texture lives in the background layer, never in the text layer. Body copy sits on
   a clean patch of ground — legibility outranks grit, always.
5. Type is condensed and loud for display, plain and readable for body. The display
   face may be beaten up; the body face may not.
6. Irregularity is repeated, not random. Pick two or three rotations/offsets and reuse
   them; randomising every element reads as broken rather than worn.
7. Accessibility is not sacrificed for atmosphere. The floor is the floor: 4.5:1 body
   text, visible focus, and no meaning carried by dirt.

## Color
- Light: ash paper `oklch(88% 0.01 80)`, stock `oklch(92% 0.012 80)`,
  ink `oklch(20% 0.01 60)`, oxide red `oklch(45% 0.16 30)`.
- Dark: soot `oklch(17% 0.01 60)`, surface `oklch(22% 0.012 60)`,
  bone `oklch(90% 0.01 85)`, hot oxide `oklch(62% 0.17 30)`.
- The accent is the only saturated hue. Adding a second one turns worn into
  carnival — if a second is unavoidable, desaturate it to near-neutral.

## Typography
- Display: condensed grotesque (Oswald / Anton / a beaten-up alternative), heavy,
  tight tracking, frequently set in caps — and caps here get their tracking opened.
- Body: a plain workhorse sans. Never set body copy in the distressed face.
- Big jumps between display and body; this kit has no elevation to signal rank, so
  size and weight carry it.

## Components
**Do**
- Buttons: solid oxide fill, thick border, hard offset shadow; pressed translates
  into the shadow.
- Cards: stamped block with a torn edge on one side only, used in the same role.
- Headers: caps display over a textured band; body on a clean patch below it.
- Dividers: a thick rule with a rough mask, not a hairline.
- Tags/labels: inverted ink chips, slightly rotated — the same angle every time.

**Don't**
- No pure black or pure white anywhere.
- No soft shadow, no gradient, no glass.
- No texture under body copy, and no distressed face at body size.
- No randomised per-element rotation.

## Motion
- Abrupt and short: 80–140ms, sharp easing. Things snap into place; nothing floats.
- Hover shifts by a whole pixel step and drops the shadow, as if pressed into paper.
- Honor `prefers-reduced-motion`: keep the state change, drop the movement.

## Stack: web
- Tailwind v4 `@theme` with the kit tokens; texture as a repeating background layer
  on the section, never on the text container.
```css
@theme {
  --color-bg: oklch(88% 0.01 80);
  --color-primary: oklch(45% 0.16 30);
  --shadow-2: 4px 4px 0 oklch(20% 0.01 60);
}
.torn { clip-path: polygon(0 0, 100% 2%, 99% 100%, 1% 98%); }
```

## Stack: react-native
- Theme constants; hard shadows drawn as an offset `View` behind the element, because
  RN shadows always blur. Texture via a tiled `ImageBackground` on the section.

## Stack: flutter
- `elevation: 0` everywhere plus a manual offset `Container` for the stamp shadow;
  `DecorationImage` with `repeat: ImageRepeat.repeat` for the grain layer.

## Stack: swiftui
- Asset colors; a second offset `Rectangle` behind the view for the hard shadow
  (`.shadow` blurs). Texture with a tiled `Image` and `.blendMode(.multiply)`.

## Stack: compose
- Material 3 with `RectangleShape`, `shadowElevation = 0.dp`, and a manual offset
  `Box` for the stamp. Grain via a tiled `Brush.ShaderBrush`.
