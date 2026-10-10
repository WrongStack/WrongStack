---
name: visual-regression
description: "Detect unintended UI changes with reproducible rendered screenshots and reviewed baselines. Use when adding screenshot checks or investigating layout/theme regressions; do not approve a changed image merely to make the test green."
trigger: "Detect unintended UI changes with reproducible rendered screenshots and reviewed baselines. Use when adding screenshot checks or investigating layout/theme regressions; do not approve a changed image merely to make the test green."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "design"
---

# Visual Regression

## Selection card
- Task: Compare rendered UI states against screenshot baselines.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Detect unintended UI changes with reproducible rendered screenshots and reviewed baselines.

Current checked targets: Playwright 1.64.0 and Storybook React 10.6.1 (2026-10-09). Refresh registry and browser/tool compatibility before installation.

## Rules

1. Pin viewport, browser, device scale, locale, theme, fonts, test data and rendered state.
2. Wait for actual readiness: fonts/assets/data and known animation completion. Arbitrary sleeps make noisy baselines.
3. Mask only intentionally variable content, with a documented reason; masking the changed feature defeats the test.
4. Separate antialiasing/environment noise from a meaningful geometry, content or state change.
5. Review each changed baseline against the requested outcome and prior image before accepting it.
6. Keep screenshot assertions alongside behavioral checks; pixels alone do not prove accessible or functioning controls.

## Workflow

1. Choose representative routes/components and the states most likely to regress.
2. Capture a deterministic baseline through the configured browser/story workflow.
3. Inspect the diff image and trace the owning component/theme change.
4. Fix the source or accept an intended baseline change with evidence.
5. Rerun the same conditions, then the affected interaction tests.

## Before returning

Inputs and baseline identity recorded; differences inspected; masking justified; intended changes distinguished from regressions.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Playwright snapshots](https://playwright.dev/docs/test-snapshots), [Storybook visual testing](https://storybook.js.org/docs/writing-tests/visual-testing).

## Skills in scope

- testing — behavioral and failure-path verification.
- design-critique — rendered evidence and ranked findings.
- accessibility — keyboard and assistive interaction.
