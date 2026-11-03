---
name: mobile-design
description: "Mobile UI design: touch targets, safe areas, keyboard insets, tab bars, sheets, gestures, Dynamic Type and phone/tablet/foldable layouts. Use when designing or reviewing a mobile screen or flow, adapting a web design to phones, or fixing cramped, clipped or unreachable mobile UI; device evidence matters alongside visual tokens. Not for platform code mechanics (use swift-ios, kotlin-android, flutter-mobile or react-native-expo) or desktop web layout (use design-craft)."
trigger: "Use when a mobile screen, sheet, tab bar, form or gesture is designed, reviewed or fixed for touch, keyboard, safe-area or large-text behavior."
version: 1.2.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Mobile Design

## Selection card
- Task: Design or fix mobile layouts, navigation and touch behavior for phones, tablets and foldables.
- Start: Name the platform(s), the screen's primary task, the smallest supported device and the existing components and tokens.
- Finish: the measurable acceptance table below holds on a device, simulator or 390/320 px viewport (stated which), with evidence for keyboard-open, large-text and landscape states.

## Overview

A mobile screen succeeds when its primary task stays reachable under the worst conditions — keyboard open, largest text, smallest device, one thumb — so design from those, not the mockup.

Mobile interface design adapts user tasks to thumb zones, dynamic safe-area insets (notches, Dynamic Island, gesture bars), on-screen virtual keyboards, variable window size classes (compact phones, foldables, tablets), and native iOS HIG / Material 3 navigation idioms. High-craft mobile UI keeps primary actions reachable when the keyboard is open and respects OS-level Dynamic Type and gesture expectations.

Use current iOS/Android guidance and the app supported OS/device matrix. Refresh platform/store requirements rather than assuming a framework SDK minimum is the store submission target.

## Rules

1. Design from the task and available window space, not a fixed phone width.
2. Account for safe areas, edge-to-edge content, keyboard insets and reachable primary actions.
3. Respect platform back/navigation, sheets, gestures and focus behavior; provide explicit alternatives for essential gestures.
4. Use touch affordances and spacing suitable for the task/device; web CSS pixels and native logical units are not interchangeable.
5. Support dynamic text, localized content, dark/forced contrast and screen-reader semantics.
6. Preserve drafts and communicate interrupted/network/permission states rather than assuming uninterrupted foreground use.

## First moves by situation

| Situation | First moves |
|---|---|
| Web design ported to phone | Reduce to one primary task per screen; move secondary actions into overflow or sheets; check 320 px width |
| Submit button hidden by keyboard | Pin the primary action above the keyboard inset or scroll the focused field into view; test from the last field |
| Content under notch or home indicator | Apply safe-area insets only where content reaches the edge; check landscape |
| Text truncates at large sizes | Let labels wrap, stack rows vertically at large text, remove fixed heights around text |
| Too many navigation destinations | Bottom tab bar for 3–5 top-level destinations; the rest inside screens; never hide the back path |
| Gesture-only feature | Add a visible alternative (swipe-to-delete also needs an edit or menu action) |
| Tablet or foldable looks stretched | Use width classes: list-detail or two panes above compact width; cap readable line length |

## Patterns and pitfalls

- **Thumb reach** — primary actions low on phones; destructive actions away from the primary one, and undoable or confirmed.
- **Sheets** — partial-height sheets for short tasks, full screens for long forms; a sheet holding unsaved input asks before dismissing.
- **Platform idioms** — iOS swipe-back and large titles, Android system and predictive back; do not imitate one platform's core navigation on the other.
- **Forms** — correct keyboard types, autofill hints, next/done actions, and inline validation that does not jump the layout.
- **Empty, offline and permission states** — designed screens that explain why and offer the next step, not blank space.
- **Motion and haptics** — subtle and consistent; respect reduced-motion settings.

## Workflow

1. Identify platform, primary task, device/window sizes and existing components.
2. Define navigation and key state transitions before composition.
3. Implement with native/adaptive primitives and shared tokens.
4. Test keyboard open, large text, rotation/resizing, back navigation and narrow/short content windows.
5. Inspect on representative devices and record actual behavior.

## Measurable acceptance

| Area | Threshold | Source / how to check |
|---|---|---|
| Touch targets | ≥ 24×24 CSS px is the floor; use 44×44 pt (iOS) or 48×48 dp (Android) for primary controls | WCAG 2.2 SC 2.5.8; Apple HIG; Material. Web: `inspect` rule `a11y.target-size` at 390 |
| Narrow width | No sideways scroll and ≥ 8px gutters at 390 and 320 CSS px | `inspect` with `viewports:[390, 320]`: `layout.horizontal-overflow`, `layout.text-at-edge` |
| Short window | Primary action reachable with the on-screen keyboard open and at ~600px tall | Focus the last input; the submit control stays reachable without a hidden scroll |
| Safe areas | Content clears notches and home indicators; web pages use `viewport-fit=cover` with `env(safe-area-inset-*)` padding only where content reaches the edge | Device or simulator screenshot, landscape too |
| Large text | Layout holds at the largest accessibility text size; essential text wraps instead of truncating | iOS Dynamic Type / Android font scale at max |
| Navigation | A bottom tab bar holds 3–5 destinations; back always works and never loses a draft | design-patterns `bottom-tab-bar`; Android back / iOS swipe |
| Viewport units (web) | Full-height layouts use dynamic or small viewport units (dvh / svh), not 100vh, where the browser chrome resizes | Check support in web-platform-baseline before relying on it |

Web-rendered mobile surfaces should pass `design_reference {action:"inspect", url,
viewports:[390, 320], surface:"app"}` with 0 FAIL. Native screens are outside
`inspect`; use device screenshots and the same table by hand, and say so.

## Before returning

- [ ] Primary interactive targets meet 44×44 pt (iOS) / 48×48 dp (Android) sizing with >= 8px separation
- [ ] Safe-area insets (`SafeArea` / `env(safe-area-inset-*)`), keyboard open state, and 320–390px narrow widths verified with zero horizontal overflow
- [ ] Platform back gesture/button, bottom sheet dismissal, and tab/stack navigation preserve user drafts
- [ ] Dynamic Type / maximum OS font scaling and screen-reader (`VoiceOver` / `TalkBack`) labels verified
- [ ] Observed device/simulator or browser-viewport evidence recorded transparently

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Android mobile design](https://developer.android.com/design/ui/mobile), [Apple HIG](https://developer.apple.com/design/human-interface-guidelines).

## Skills in scope

- interaction-design — form flows, optimistic/offline feedback states, and gesture-to-button fallbacks.
- design-system — platform-adaptive spacing, typography scales, color roles, and component tokens.
- accessibility — VoiceOver/TalkBack focus order, touch target minimums, and high-contrast legibility.
- mobile-performance — keeping scroll lists, sheet transitions, and keyboard animations jank-free on real devices.
