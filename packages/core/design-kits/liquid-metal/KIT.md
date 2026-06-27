---
id: liquid-metal
name: Liquid Metal
aesthetic: Chrome & mercury — fluid metallic surfaces, sharp reflections, sleek futurism.
tags: [chrome, metal, fluid, futuristic, reflective, sleek]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Tech/AI, automotive, audio gear, premium product launches, bold futuristic brands.
version: 1.0.0
---

# Liquid Metal

## Overview
Polished liquid chrome: fluid metallic surfaces with sharp specular reflections, mercury-like
gradients (silver/steel with hints of blue), crisp edges, and a sleek dark-futuristic mood.
Cool, premium, and high-tech. The signature is the metallic gradient + hard reflection
highlight; pair with clean type and deep grounds.

## Rules
1. Metallic gradients: silver→steel→graphite with a sharp specular highlight band.
2. Deep, cool grounds (near-black/graphite) so chrome surfaces pop.
3. Crisp edges, subtle bevels, mirror-like reflections; a cool blue tint in highlights.
4. Restrained — chrome on hero/accents, neutral content areas.
5. Clean modern sans; minimal color (the metal is the statement).
6. Maintain AA — chrome buttons need legible label contrast (dark text on light metal or vice versa).

## Color
- Dark: bg `oklch(20% 0.005 250)`, chrome light `oklch(88% 0.01 240)`, chrome mid `oklch(60% 0.015 250)`, chrome dark `oklch(35% 0.01 250)`, blue tint `oklch(75% 0.08 230)`, fg `oklch(95% 0.005 240)`.
- Light: bg `oklch(94% 0.005 240)`, ink `oklch(22% 0.01 250)`, chrome accents.

## Typography
- Clean modern sans (Geist / Inter / a techy grotesque); tight, precise.

## Components
**Do**
- Chrome buttons (metallic gradient + specular band); mirror-surface cards; beveled edges; cool-blue highlight; deep grounds.
**Don't**
- No warm/pastel color, no soft blobs, no flat matte everywhere. Keep reflections crisp, not blurry.

## Motion
- Sleek: specular highlight sweeps across metal on hover; smooth precise transitions. 200–350ms.
- Reduced-motion: static highlight.

## Stack: web
- Tailwind v4 + metallic `linear-gradient` with a bright highlight stop; animated `background-position` sweep; deep ground; cool-blue ring.
## Stack: react-native
- `expo-linear-gradient` metallic + highlight overlay; Reanimated sweep; deep theme.
## Stack: flutter
- `LinearGradient` metallic + highlight `Stack`; `AnimationController` sweep; deep `ColorScheme`.
## Stack: swiftui
- `LinearGradient` metallic + specular `.overlay`; `TimelineView` sweep; deep asset colors.
## Stack: compose
- `Brush.linearGradient` metallic + highlight; `rememberInfiniteTransition` sweep; deep M3.
