---
name: accessibility
version: 1.0.1
description: "Implement and review accessible user interfaces with semantic controls, keyboard and focus behavior, readable content and assistive-technology checks. Use when fixing inaccessible forms, dialogs, navigation, drag interactions or WCAG gaps; distinguish automated findings from tested accessibility."
trigger: "fixing inaccessible forms, dialogs, navigation, drag interactions or WCAG gaps; distinguish automated findings from tested accessibility."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: design
---

# Accessibility

## Selection card
- Task: Fix keyboard, focus and assistive technology behavior.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Start from the actual user task and supported input modes. WCAG 2.2 is the
current Recommendation used here; verify current standards when the required
conformance target changes. A scanner score is not a conformance certificate.

## Rules

1. Prefer native controls and meaningful document structure. Use ARIA when it
   adds the semantics a custom widget actually needs, and keep values synchronized.
2. Every action must work from a keyboard with visible, unobscured focus.
   Dialogs need sensible initial focus, dismissal and return focus.
3. Give controls names, instructions and errors. Associate labels programmatically;
   placeholder text does not replace a label.
4. Test real text and backgrounds for contrast: ordinary text 4.5:1, large text
   3:1, applicable UI/graphics 3:1. Gradients and transparency need rendered values.
5. WCAG 2.2 AA target size is 24 by 24 CSS pixels or a qualifying exception.
   44 by 44 is a useful touch design target and the enhanced AAA criterion,
   not a universal AA requirement.
6. Support zoom/reflow, reduced motion and forced colors as relevant. A drag
   action needs a single-pointer alternative; authentication should allow paste
   and password-manager assistance.

## Workflow

1. Identify route/state/viewport, task, affected shared primitives and conformance
   target. Inspect the actual rendered surface.
2. Run the existing automated checker, then independently test keyboard,
   zoom/reflow, focus, errors and asynchronous updates.
3. Use an available screen reader to check names, landmarks, reading order and
   announcements. If unavailable, record that gap instead of inventing evidence.
4. Fix at the owning primitive where appropriate. Preserve the product's content
   and design intent while improving operation.
5. Recheck the task and stress empty/error/loading states and long labels.

## Before returning
- Findings include affected state, user impact and concrete fix.
- Keyboard and focus journey checked.
- Automated checks separated from assistive-technology evidence.
- Standards/thresholds correctly scoped; remaining gaps stated.

## Sources

[WCAG 2.2](https://www.w3.org/TR/WCAG22/),
[target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

## Skills in scope

- design-system — shared component tokens and states.
- design-critique — rendered evidence.
- testing — interaction regressions.
