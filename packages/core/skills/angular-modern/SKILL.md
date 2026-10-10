---
name: angular-modern
description: "Build and upgrade Angular applications with typed components, reactive state, dependency injection and verified routing. Use when working on Angular forms, signals, rendering or migration; inspect zoneless/zone-based behavior rather than assuming either mode."
trigger: "Build and upgrade Angular applications with typed components, reactive state, dependency injection and verified routing. Use when working on Angular forms, signals, rendering or migration; inspect zoneless/zone-based behavior rather than assuming either mode."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
---

# Angular Modern

## Selection card
- Task: Angular signals and standalone components.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Angular applications with typed components, reactive state, dependency injection and verified routing.

Checked 2026-10-09: Angular core/CLI 22.2.2. Coordinate framework/compiler/CLI packages. Compiler-cli 22.2.2 declares TypeScript >=6.0 <6.1, so current TypeScript 7.0.2 is outside its supported range. Report this blocker; do not force the peer combination.

## Rules

1. Identify bootstrap, standalone/module conventions and change-detection mode.
2. Keep derivation in computed state and side effects at intentional boundaries; do not create circular effect synchronization.
3. Clean up observable subscriptions, async work and component resources using supported ownership/lifecycle APIs.
4. Treat route guards and UI controls as navigation policy, not server authorization.
5. Use typed forms and explicit pending/error states; validation semantics must match the server.
6. Check SSR/hydration and browser-only APIs in the configured rendering mode.

## Workflow

1. Inspect project config, component/data conventions and supported version matrix.
2. Upgrade through official migrations when requested and review generated changes.
3. Implement the narrow feature with existing dependency and state boundaries.
4. Test navigation, forms, change-detection notifications, lifecycle and SSR as applicable.
5. Run configured type/lint/tests and production build.

## Before returning
Version matrix and detection mode recorded; async cleanup and form behavior verified; SSR and build gaps stated.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Angular compatibility](https://angular.dev/reference/versions), [Zoneless](https://angular.dev/guide/zoneless).

## Skills in scope

- typescript-strict — typescript strict contracts and verification.
- api-design — api design contracts and verification.
- testing — testing contracts and verification.
- design-system — create and maintain coherent visual tokens, themes and shared component states using the existing project system or WrongStack Design Studio.
