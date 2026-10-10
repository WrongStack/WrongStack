---
name: vue-nuxt
description: "Build and upgrade Vue or Nuxt applications with reactive state, server rendering and typed data boundaries. Use when implementing Vue components, composables or Nuxt routes; distinguish client-only Vue from Nuxt server/runtime features."
trigger: "Build and upgrade Vue or Nuxt applications with reactive state, server rendering and typed data boundaries. Use when implementing Vue components, composables or Nuxt routes; distinguish client-only Vue from Nuxt server/runtime features."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
---

# Vue Nuxt

## Selection card
- Task: Vue components and Nuxt server routes.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Vue or Nuxt applications with reactive state, server rendering and typed data boundaries.

Checked 2026-10-09: Vue 3.5.43 and Nuxt 4.6.0. Refresh current stable versions, peer/runtime requirements and official migration notes before adding or upgrading.

## Rules

1. Identify Vue-only versus Nuxt, installed composition/options conventions and rendering mode.
2. Preserve reactivity when destructuring values; use computed derivation instead of mirrored mutable state.
3. Scope watchers/subscriptions and invalidate stale async responses when their inputs/owner change.
4. Keep request-private state isolated during SSR; module singletons can leak across users.
5. Use supported Nuxt data/loading APIs and runtime config separation; public config is browser-visible.
6. Validate/authorize server operations independently of route middleware and client controls.

## Workflow

1. Inspect app config, composables, routing/data layer and workspace lockfile.
2. Resolve latest compatible targets and implement within existing conventions.
3. Exercise direct route load, navigation, error/empty states and mutation refresh.
4. Check hydration, account/locale isolation and repeated component cleanup.
5. Run configured type/lint/tests and production build/startup.

## Before returning

Framework/rendering mode explicit; reactivity and request isolation preserved; hydration/navigation/build evidence recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Vue guide](https://vuejs.org/guide/introduction.html), [Nuxt docs](https://nuxt.com/docs/4.x/getting-started/introduction).

## Skills in scope

- typescript-strict — typescript strict contracts and verification.
- design-system — create and maintain coherent visual tokens, themes and shared component states using the existing project system or WrongStack Design Studio.
- api-design — api design contracts and verification.
- testing — testing contracts and verification.
