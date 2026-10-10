---
name: mobile-design
description: "Design and implement mobile interfaces for touch, keyboards, safe areas and native navigation. Use when creating phone/tablet/foldable screens or adapting web ideas to mobile; platform behavior and device evidence matter alongside visual tokens."
trigger: "Design and implement mobile interfaces for touch, keyboards, safe areas and native navigation. Use when creating phone/tablet/foldable screens or adapting web ideas to mobile; platform behavior and device evidence matter alongside visual tokens."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Mobile Design

## Selection card
- Task: Design native touch layouts and safe-area behavior.
- Start: Identify the platform, screen, device and native integration boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Design and implement mobile interfaces for touch, keyboards, safe areas and native navigation.

Use current iOS/Android guidance and the app supported OS/device matrix. Refresh platform/store requirements rather than assuming a framework SDK minimum is the store submission target.

## Rules

1. Design from the task and available window space, not a fixed phone width.
2. Account for safe areas, edge-to-edge content, keyboard insets and reachable primary actions.
3. Respect platform back/navigation, sheets, gestures and focus behavior; provide explicit alternatives for essential gestures.
4. Use touch affordances and spacing suitable for the task/device; web CSS pixels and native logical units are not interchangeable.
5. Support dynamic text, localized content, dark/forced contrast and screen-reader semantics.
6. Preserve drafts and communicate interrupted/network/permission states rather than assuming uninterrupted foreground use.

## Workflow

1. Identify platform, primary task, device/window sizes and existing components.
2. Define navigation and key state transitions before composition.
3. Implement with native/adaptive primitives and shared tokens.
4. Test keyboard open, large text, rotation/resizing, back navigation and narrow/short content windows.
5. Inspect on representative devices and record actual behavior.

## Before returning

Primary action remains reachable; navigation/keyboard/insets work; large text and assistive behavior checked; rendered device evidence recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Android mobile design](https://developer.android.com/design/ui/mobile), [Apple HIG](https://developer.apple.com/design/human-interface-guidelines).

## Skills in scope

- interaction-design — task/state transition design.
- design-system — tokens and shared component state.
- accessibility — keyboard and assistive interaction.
- mobile-performance — release-device profiling.
