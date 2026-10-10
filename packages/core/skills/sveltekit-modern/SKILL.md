---
name: sveltekit-modern
description: "Build and upgrade Svelte and SvelteKit applications with reactive state, server loads, actions and deployment adapters. Use when implementing Svelte components or SvelteKit routes; follow the current installed runtime and migration contract."
trigger: "Build and upgrade Svelte and SvelteKit applications with reactive state, server loads, actions and deployment adapters. Use when implementing Svelte components or SvelteKit routes; follow the current installed runtime and migration contract."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
---

# Sveltekit Modern

## Selection card
- Task: Svelte runes and SvelteKit actions.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Svelte and SvelteKit applications with reactive state, server loads, actions and deployment adapters.

Checked 2026-10-09: Svelte 5.57.2 and SvelteKit 3.0.1. Verify supported adapter/runtime and stable peer requirements before upgrading.

## Rules

1. Distinguish component reactivity from server load/action execution; browser APIs cannot run in server paths.
2. Use current supported reactivity conventions for new code; migrate existing code deliberately instead of mixing incompatible examples.
3. Keep per-request private data out of module-global server state.
4. Serialize only appropriate load data and separate public/private environment variables.
5. Validate/authorize form actions and endpoints at the server boundary and model failure feedback.
6. Scope stores/effects/subscriptions to ownership and guard stale async completion.

## Workflow

1. Inspect routes, hooks, state conventions, adapter and lockfile.
2. Read migration deltas for crossed majors and establish the latest compatible target.
3. Implement loading/actions and visible states with existing components.
4. Test direct loads, navigation, hydration, errors and two-user isolation where private data exists.
5. Run configured checks and adapter production build/startup.

## Before returning

Load/action boundaries and private data ownership explicit; reactive cleanup and route behavior verified; adapter evidence scoped.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Svelte docs](https://svelte.dev/docs/svelte/overview), [SvelteKit docs](https://svelte.dev/docs/kit/introduction).

## Skills in scope

- api-design — api design contracts and verification.
- typescript-strict — typescript strict contracts and verification.
- design-system — create and maintain coherent visual tokens, themes and shared component states using the existing project system or WrongStack Design Studio.
- testing — testing contracts and verification.
