---
name: motion-design
description: "Implement web and React animation, gesture feedback, layout transitions and scroll sequences. Use when working with Motion, GSAP or CSS animation; use motion-canvas-video for exported timeline videos and threejs-3d for rendered 3D scenes."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "working with Motion, GSAP or CSS animation; use motion-canvas-video for exported timeline videos and threejs-3d for rendered 3D scenes."
metadata:
  routing-group: media
---

# Motion Design

## Selection card
- Task: Animate live web UI transitions and gestures.
- Start: Identify the existing engine, scene, timeline and delivery format.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Latest stable targets checked 2026-10-09: Motion 14.0.0, GSAP 3.15.0 and
Tailwind CSS 4.3.3. For new React animation work, Motion imports from motion/react.
Inspect existing package APIs and migration notes before upgrading; renaming
framer-motion alone is not a validated migration.

## Rules

1. Give each animation a purpose: state feedback, spatial continuity, attention
   or storytelling. Keep core actions usable if animation is disabled.
2. Prefer CSS for small transitions; use the existing animation library where
   orchestration, interruption or layout continuity needs it.
3. Prefer transform and opacity on hot paths. Layout animation APIs and occasional
   size transitions can be appropriate; profile their actual cost instead of
   banning all width/height animation.
4. Honor reduced motion. Remove parallax and large travel/zoom; retain necessary
   state feedback through short fades or instant changes.
5. Preserve semantics and focus through enter/exit transitions. Use actual buttons
   and links for actions; hover alone cannot carry information.
6. Clean up timelines, subscriptions and ScrollTrigger instances on unmount.
   Strict Mode, interrupted transitions and route changes must not duplicate them.

## Workflow

1. Define states, interrupted-state behavior, duration/easing roles and mobile
   adaptation using the project tokens.
2. For Motion, consider MotionConfig reducedMotion='user', useReducedMotion and
   AnimatePresence for real exit states. Use stable keys and measure layout
   when geometry changes.
3. For GSAP, scope nodes to the owning component with context or the supported
   React integration. Revert on cleanup; avoid accumulating global triggers.
4. Stress rapid toggle, pending/disabled states, keyboard flow, reduced motion,
   route changes and a representative low-powered device.
5. Inspect traces for long tasks/layout work. Report the measured result instead
   of promising 60/120 fps on every device.

## Sources

[Motion accessibility](https://motion.dev/docs/react-accessibility),
[Tailwind theme variables](https://tailwindcss.com/docs/theme).

## Acceptance checks

- Exercise rendered transitions, reduced motion, focus, cleanup and layout stability.

## Skills in scope

- design-system — motion tokens and theming.
- design-craft — purpose and visual hierarchy.
- accessibility — interaction alternatives and motion preferences.
- web-performance — frame and input latency evidence.
