---
name: motion-design
description: "Web UI animation with Motion (motion/react), GSAP, CSS transitions, View Transitions and scroll effects: gestures, layout, exits. Use when adding or fixing hover and press feedback, modal or page transitions, layout animations, scroll reveals, animation jank or reduced-motion issues in a live web app. Not for exported videos (use motion-canvas-video) or rendered 3D scenes (use threejs-3d)."
version: 1.3.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request touches motion/react, framer-motion, gsap, ScrollTrigger, CSS keyframes or transitions, or animation jank in a web UI."
metadata:
  routing-group: media
---

# Motion Design

## Selection card
- Task: Animate live web UI state changes, gestures, layout and scroll with the project's animation stack.
- Start: Read package.json for motion, framer-motion, gsap and tailwindcss versions, the motion tokens (durations, easings), and the component whose states change.
- Finish: every animated state works interrupted, under reduced motion and after unmount; the performance trace shows no per-frame layout from the animation; checks below pass.

## Overview

Good UI motion explains a state change in a few hundred milliseconds, runs on the compositor, can be interrupted at any frame, and steps aside when the user asks for reduced motion.
Latest stable targets checked 2026-11-02: Motion 14.9.0, GSAP 3.15.0 and Tailwind CSS 4.3.3. For new React animation work, Motion imports from motion/react. Inspect existing package APIs and migration notes before upgrading; renaming framer-motion alone is not a validated migration.

## Rules

1. Every animation has a job: feedback, spatial continuity or attention. Core actions work with animation off, and input is never blocked until a decorative sequence ends.
2. Animate transform and opacity on hot paths. Width, height, top, left and margin force layout every frame; reach for transforms, Motion `layout` (FLIP) or a measured one-off, and profile before deciding.
3. Honor `prefers-reduced-motion: reduce`: drop parallax, large travel, zoom and autoplay loops; keep short fades or instant state changes. WCAG 2.2.2 requires a pause for motion lasting over 5 s; 2.3.1 forbids more than three flashes per second.
4. Animations must be interruptible: a rapid toggle reverses from the current value instead of queueing or jumping. CSS transitions and Motion do this; restarted keyframe animations do not.
5. Clean up: GSAP through `useGSAP()` or `gsap.context()` with revert, ScrollTriggers killed on unmount, handlers that create tweens wrapped in `contextSafe`; Strict Mode double mounts must not duplicate anything.
6. Durations come from tokens by role: micro feedback 100-200 ms, panels and dialogs 200-300 ms, route transitions up to about 400 ms; exits faster than entrances; ease-out to enter, ease-in to leave, springs for gesture-driven motion.
7. Preserve focus and semantics: exiting dialogs return focus, backgrounds become inert, status changes are announced with live regions rather than motion.
8. Keep the project's library. CSS first for simple transitions; do not add GSAP to a Motion codebase (or the reverse) for one effect.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| Hover or press feedback | CSS transition on transform and opacity; hover styles inside `@media (hover: hover)`; Motion `whileTap` where Motion is already used |
| Modal, drawer, toast exit | `AnimatePresence` around the conditional, stable `key` on the direct child, exit variant, focus return |
| Reorder or layout change | Motion `layout` or shared `layoutId`; `LayoutGroup` for siblings; `layout="position"` on text children |
| Route transition | View Transitions (`document.startViewTransition`) where Baseline allows with a no-animation fallback, or a keyed `AnimatePresence` at the layout |
| Scroll reveal or progress | CSS `animation-timeline: view()` with a static fallback where unsupported; Motion `useScroll` plus `useTransform`; GSAP ScrollTrigger for pinning |
| Accordion to auto height | `interpolate-size: allow-keywords` where supported, the grid-rows 0fr to 1fr technique, or Motion's `height: "auto"` |
| Popover or dialog entry from display none | `@starting-style` plus `transition-behavior: allow-discrete` on display and overlay |
| Jank or dropped frames | Performance panel with 4x CPU throttle; look for Layout or Recalculate Style each frame, long tasks, oversized layers |
| Reduced-motion bug | Emulate the media feature in DevTools Rendering; inventory every animation and its reduced variant |
| framer-motion to motion upgrade | Switch imports to motion/react, read the upgrade guide's breaking changes, re-run visual and interaction tests |

## Patterns and pitfalls

- **Layout distortion** — `layout` animates with scale transforms, so child text stretches; add `layout` or `layout="position"` to children and set border radius through `style` so Motion can correct it.
- **Scroll containers** — layout animations inside scrollable ancestors need `layoutScroll`, and fixed containers need `layoutRoot`, or measured positions are wrong.
- **Exit never runs** — the direct child of `AnimatePresence` needs a stable unique key (not an index), and the presence wrapper itself must stay mounted.
- **Per-frame React state** — scroll or pointer values in `useState` re-render the tree every event; motion values (`useMotionValue`, `useTransform`, `useSpring`) update without rendering.
- **`will-change` everywhere** — permanent layer promotion on many elements burns GPU memory; scope it to the animation (Motion manages this itself).
- **Expensive paints** — animating `filter: blur()` or `box-shadow` repaints each frame; fade a pre-rendered pseudo-element instead.
- **First-render transitions** — CSS transitions do not run on mount; use `@starting-style` or a keyframe animation.
- **GSAP `from()` under Strict Mode** — the second mount animates from the already-animated state; `useGSAP()` reverts between mounts.
- **ScrollTrigger positions** — computed at creation; late images and fonts shift them, so call `ScrollTrigger.refresh()` once layout settles. A transformed ancestor breaks pinned fixed positioning.
- **GSAP plugins** — since 3.13 the former bonus plugins (SplitText, MorphSVG and others) ship free on npm; register each with `gsap.registerPlugin`.
- **Layout shift** — entrances that animate margin or insert content push neighbours; animate from a transform offset and reserve space so CLS stays 0.
- **Tailwind v4** — custom animations are `--animate-*` theme variables with `@keyframes` inside `@theme`; gate decorative motion with the `motion-safe:` and `motion-reduce:` variants.

## Workflow

1. Inventory installed library versions and motion tokens; sketch the component's states and transitions, including interrupted ones.
2. Choose the mechanism: CSS, Motion, GSAP or View Transitions, matching the codebase.
3. Implement with tokens and write the reduced-motion variant at the same time.
4. Stress: rapid toggles, interrupt mid-animation, navigate during an animation, Strict Mode, keyboard only, 4x CPU throttle.
5. Record a performance trace and confirm no per-frame layout or long paints from the animation; measure CLS.
6. Report what was measured; do not promise 60 or 120 fps on every device.

## Proof

- Project checks: the repo's typecheck, lint and test scripts (for example `npm run typecheck` and `npm test`).
- Reduced motion in tests: Playwright `page.emulateMedia({ reducedMotion: 'reduce' })`, then assert the end state is visible immediately.
- Stable screenshots: `expect(page).toHaveScreenshot({ animations: 'disabled' })` for visual regression around animated components.
- Cleanup: mount and unmount the route ten times; `ScrollTrigger.getAll().length` and listener counts return to baseline.
- Performance: DevTools trace with CPU throttling, Paint flashing and Layer borders on; `npx lighthouse http://localhost:3000 --only-categories=performance` for CLS.

## Stop and ask

- Adding an animation library, or a major upgrade of the existing one.
- A brand requirement conflicts with reduced motion or WCAG flash limits.
- Scroll hijacking or smooth-scroll libraries that replace native scrolling.
- Autoplaying video or looping hero animation without a pause control.

## Before returning

- [ ] Imports and APIs match the installed motion, gsap and tailwindcss versions
- [ ] Animated properties are transform and opacity on hot paths, or a measured exception is documented
- [ ] Reduced-motion variant exists and was checked with emulation
- [ ] Rapid interruption, unmount cleanup and Strict Mode double mount verified
- [ ] Focus order, focus return and announcements preserved through enter and exit
- [ ] Performance trace shows no per-frame layout from the animation; CLS unchanged
- [ ] Durations and easings come from project tokens

## Sources

[Motion accessibility](https://motion.dev/docs/react-accessibility),
[Tailwind theme variables](https://tailwindcss.com/docs/theme),
[GSAP React guide](https://gsap.com/resources/React/),
[prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion).

## Skills in scope

- design-system — shared duration, easing and spring tokens across components.
- design-craft — choreographing hierarchy, spatial continuity and restraint.
- interaction-design — state models, feedback timing and gesture behavior.
- accessibility — reduced-motion adaptation and focus preservation in animated dialogs and menus.
- web-performance — compositor promotion, main-thread frame times and layout-shift regressions.
