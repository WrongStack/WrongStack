---
name: interaction-design
description: "Design and implement task-oriented interaction flows, forms, navigation and recovery states. Use when improving onboarding, complex workflows or interaction behavior; use design-system for tokens and design-craft for visual composition."
trigger: "Design and implement task-oriented interaction flows, forms, navigation and recovery states. Use when improving onboarding, complex workflows or interaction behavior; use design-system for tokens and design-craft for visual composition."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "design"
---

# Interaction Design

## Selection card
- Task: Design user journeys, feedback and recovery.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Design and implement task-oriented interaction flows, forms, navigation and recovery states.

Use the current project design system and actual platform conventions. Refresh platform guidance before choosing a new interaction model.

## Rules

1. Describe the user task, entry points, completion and recovery before drawing screens.
2. Map state transitions: loading, empty, partial success, invalid input, retry, cancel and interrupted work.
3. Separate immediate UI state from durable business state; optimistic feedback must reconcile rejected writes.
4. Preserve focus and accessible names through navigation and overlays. Hover or drag cannot be the sole route to an action.
5. Match native/browser navigation expectations. A back action must not unexpectedly repeat a payment or lose draft data.
6. Use progressive disclosure for genuine complexity; do not hide required information solely to make a screen sparse.

## Workflow

1. Trace the current journey and identify where users hesitate, repeat work or become stranded.
2. Specify a small state/transition map and representative content, including long/localized labels.
3. Implement the flow using shared primitives and existing validation/data boundaries.
4. Exercise keyboard/touch, failed submission, retry, duplicate action and interrupted navigation.
5. Inspect the rendered journey and revise the highest-impact observed issue.

## Before returning

Main task and recovery paths work; focus and draft ownership are explicit; observed checks cite the route/state and unresolved gaps.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Android interaction guidance](https://developer.android.com/design/ui/mobile), [ARIA patterns](https://www.w3.org/WAI/ARIA/apg/patterns/).

## Skills in scope

- design-system — tokens and shared component state.
- design-craft — product-specific composition.
- accessibility — keyboard and assistive interaction.
- testing — behavioral and failure-path verification.
