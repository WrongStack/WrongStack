---
name: code-quality
version: 1.0.1
description: "Find and remove unused code, ghost dependencies, unnecessary coupling and bundle waste with source-confirmed reachability. Use when cleaning exports or packages, reviewing Knip output or reducing dead code; use security-scanner for security findings and preserve public/dynamic entrypoints."
trigger: "cleaning exports or packages, reviewing Knip output or reducing dead code; use security-scanner for security findings and preserve public/dynamic entrypoints."
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [verification.run, web.research, filesystem.write]
metadata:
  routing-group: quality
---

# Code Quality

## Selection card
- Task: Measure dead code, unused dependencies and bundle waste.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Latest checked targets on 2026-10-09: Knip 6.41.0 and Biome 2.5.15.
Use the repo's configured tools and verify migration deltas before upgrading.
Static reachability findings are candidates until real consumers are checked.

## Rules

1. Inspect scripts, package exports, plugin registries, framework conventions,
   generated entrypoints and test/build configuration before declaring code unused.
2. Separate internal unused code from public API: external consumers may not
   exist in this repository. Do not remove a public export merely because local
   references are absent.
3. Verify every removal through import/call sites, dynamic use and relevant
   build output. Explain the evidence rather than dumping scanner results.
4. Fix configuration false positives narrowly; broad ignores hide later defects.
5. Keep behavior changes separate from cleanup and preserve dirty work.
6. Measure bundle/runtime savings against matched builds; deleted lines are
   not proof of a smaller shipped artifact or faster execution.

## Workflow

1. Run the current quality command and record its candidate list/baseline.
2. Group findings by entrypoint/config/dependency/export and confirm reachability.
3. Remove a coherent set of confirmed unused items. Regenerate lockfiles through
   the package manager when dependencies change.
4. Run affected type/build/tests and verify package export/consumer behavior.
5. Rerun the quality scan; report resolved candidates, justified exclusions,
   unknown external usage and measured artifact changes where relevant.

## Sources

[Knip issue resolution](https://knip.dev/guides/handling-issues),
[Biome](https://biomejs.dev/).

## Acceptance checks

- Run the selected analyzer against the scoped source, confirm findings and verify behavioral checks after cleanup.

## Skills in scope

- codebase-navigation — actual consumers.
- refactor-planner — coupling and staged structural changes.
- testing — behavior preservation.
- tech-stack — dependency justification.
