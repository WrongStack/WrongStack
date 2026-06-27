---
id: japandi
name: Japandi
aesthetic: Japanese + Scandinavian — zen minimalism, natural materials, muted, balanced.
tags: [japandi, zen, minimal, natural, muted, wabi-sabi]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [light, dark]
bestFor: Wellness, tea/ceramics, architecture, premium lifestyle, mindful productivity.
version: 1.0.0
---

# Japandi

## Overview
The fusion of Japanese wabi-sabi and Scandinavian function: profound restraint, natural
materials (wood, stone, paper, clay), muted earthy neutrals, asymmetric balance, and ample
negative space (ma). Calm, intentional, and quietly premium. Imperfection and emptiness are
features, not flaws.

## Rules
1. Deeply muted earthy palette: warm grays, clay, charcoal, moss; near-monochrome.
2. Negative space (ma) is structural — let elements breathe with asymmetric balance.
3. Natural textures: paper grain, wood, stone, subtle and tactile.
4. Fine lines, low contrast accents, restrained type; nothing loud or fast.
5. Asymmetry over centered symmetry; horizon-like horizontal rhythm.
6. Maintain AA for body text despite the muted feel.

## Color
- Light: paper `oklch(95% 0.01 75)`, charcoal `oklch(32% 0.01 60)`, clay `oklch(65% 0.05 45)`, moss `oklch(60% 0.04 130)`.
- Dark: sumi `oklch(22% 0.005 60)`, fg `oklch(90% 0.01 75)`, muted clay/moss.

## Typography
- Refined humanist sans + optional fine serif; generous leading; quiet hierarchy.

## Components
**Do**
- Spacious cards with hairline borders; muted accent buttons; horizontal rules; paper/wood texture; asymmetric layout.
**Don't**
- No bright color, no busy patterns, no heavy shadows. Don't fill the space — leave ma.

## Motion
- Very slow, serene: long gentle fades; nothing abrupt. 350–600ms.
- Reduced-motion: instant.

## Stack: web
- Tailwind v4 muted-earth tokens; hairline borders; paper texture overlay; generous spacing; fine serif/sans.
## Stack: react-native
- Muted neutrals; spacious layout; hairline dividers; subtle texture.
## Stack: flutter
- Muted M3 seed; spacious; `Divider` hairlines; paper texture image.
## Stack: swiftui
- Muted asset colors; generous padding; `Divider`; subtle texture; slow fades.
## Stack: compose
- Muted M3; spacious; thin dividers; texture; serene `tween`.
