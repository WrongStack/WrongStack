---
id: retro-terminal
name: Retro Terminal
aesthetic: CRT/terminal — phosphor green on black, monospace, scanlines, hacker energy.
tags: [terminal, retro, crt, monospace, hacker, developer]
stacks: [web, react-native, flutter, swiftui, compose]
themes: [dark, light]
bestFor: Dev tools, CLIs-as-web, crypto/security products, hackathon/landing pages with an underground vibe.
version: 1.0.0
---

# Retro Terminal

## Overview
An old-school computer terminal: phosphor green (or amber) text on near-black, fixed
monospace everywhere, blinking cursors, ASCII/box-drawing accents, and a faint CRT
glow + scanlines. Nostalgic and unmistakably "for hackers." Use sparingly — full-screen
terminal is a strong statement; keep real content legible.

## Rules
1. Monospace everywhere; fixed-width alignment is the layout system (columns of glyphs).
2. Dark-first: near-black bg, phosphor green primary text, dim green secondary.
3. Effects with restraint: subtle scanlines + text glow, optional flicker — never enough to hurt reading.
4. ASCII/box-drawing for borders/dividers (─ │ ┌ ┐ ╳), blinking block cursor for inputs.
5. Keep contrast high (green on black is AAA); offer an amber and a "light paper terminal" variant.
6. Interactions read like a shell: prompts (`$`), command echoes, typed responses.

## Color
- Dark: bg `oklch(15% 0.02 150)` (near-black green-tinted), primary `oklch(85% 0.18 145)` (phosphor green),
  dim `oklch(60% 0.12 145)`, amber alt `oklch(80% 0.15 75)`, danger `oklch(65% 0.2 25)`.
- Light ("paper terminal"): bg `oklch(96% 0.01 145)`, fg `oklch(25% 0.08 150)`.

## Typography
- Mono: JetBrains Mono / IBM Plex Mono / VT323 (display). Tight line-height, generous tracking on headings.

## Components
**Do**
- Prompt lines (`$ command`), blinking cursor, typewriter reveal for "output".
- Box-drawing panels/tables; status as `[ OK ]` / `[FAIL]`; progress as ASCII bars (`[####----]`).
- Glow on focus; scanline overlay via a fixed pseudo-element.

**Don't**
- No rounded cards, gradients, or proportional fonts. Don't overdo flicker/glow (accessibility + headaches).

## Motion
- Typewriter text, blinking cursor (~1s), occasional scanline sweep. 60–120ms steps.
- Reduced-motion: no flicker/typewriter — render text instantly, static cursor.

## Stack: web
- Tailwind v4 dark; mono font var; scanlines via `repeating-linear-gradient` overlay + `text-shadow` glow;
  blinking cursor with a `steps()` keyframe; box-drawing chars in borders. Respect `prefers-reduced-motion`.

## Stack: react-native
- Mono via expo-font; dark theme; cursor blink with Reanimated; ASCII dividers; avoid heavy overlays on low-end devices.

## Stack: flutter
- Mono `TextStyle`; dark `ColorScheme`; `CustomPaint` scanline overlay; blinking cursor `AnimationController`;
  box-drawing in `Text`.

## Stack: swiftui
- `Font.system(.body, design: .monospaced)`; dark; `TimelineView` cursor blink; subtle `.shadow` glow;
  honor Reduce Motion.

## Stack: compose
- `FontFamily.Monospace`; `darkColorScheme`; `Modifier.drawWithContent` scanlines; blinking cursor via
  `rememberInfiniteTransition`.
