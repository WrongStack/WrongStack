---
name: vue-nuxt
description: "Vue 3 and Nuxt 4: .vue SFCs, Composition API, composables, Pinia, useFetch/useAsyncData, Nitro server/api routes, routeRules and SSR. Use when building or fixing Vue components, composables, Nuxt pages, server routes, hydration issues or a Nuxt upgrade; distinguish client-only Vue from Nuxt server features. Not for generic TypeScript typing (use typescript-strict) or HTTP contract design (use api-design)."
trigger: "Use when the change touches *.vue files, nuxt.config.*, composables, Pinia stores, server/api routes or Nuxt data fetching."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
paths: ["*.vue", "nuxt.config.*"]
---

# Vue and Nuxt

## Selection card
- Task: Build or repair Vue components and composables, Nuxt pages, data fetching and Nitro server routes.
- Start: Read package.json (Vue-only or Nuxt), nuxt.config.* or the Vite config, the affected page/component and its composables.
- Finish: type checking and the production build pass, the route renders server-side without hydration warnings, and the checks below pass.

## Overview

Vue reactivity breaks silently at boundaries — destructuring, passing a value instead of a ref, a module-level ref shared by every SSR request — so the expert habit is to track where a reactive link is created and where it could be lost.
Checked 2026-11-02: Vue 3.5.44 and Nuxt 4.6.3. Refresh current stable versions, peer/runtime requirements and official migration notes before adding or upgrading.
In Nuxt, every page renders twice (server, then client hydration); anything non-deterministic or request-private needs a deliberate home.

## Rules

1. Identify the stack first: plain Vue (Vite SPA) versus Nuxt, the Nuxt source layout (Nuxt 4 defaults to `app/`), and the rendering mode per route (`routeRules`, `ssr`).
2. Never hold request or user state in module scope in Nuxt: use `useState(key)`, Pinia stores created per request, or `event.context` on the server.
3. Fetch page data with `useFetch`/`useAsyncData` at the top level of `<script setup>` with a stable key; use `$fetch` for user-triggered mutations. Plain `$fetch` during SSR does not forward the visitor's cookies — use `useRequestFetch()` when it must.
4. Derive with `computed`; do not mirror props into refs and sync them with watchers. Local editable copies are explicit and reset on prop change.
5. Cancel stale async work in watchers with `onWatcherCleanup` (or the cleanup callback) so out-of-order responses cannot win.
6. Nitro handlers validate input (`readValidatedBody`, `getValidatedQuery` with a schema) and authorize on the server; route middleware is navigation, not security.
7. Secrets live in private `runtimeConfig` only; `runtimeConfig.public`, Pinia state and `useState` are serialized into the page payload.

## First moves by situation

| Situation | First moves |
|---|---|
| Hydration mismatch warning | Find `Date.now()`, `Math.random()`, locale formatting or `window` checks during render; use `useId()`, `<ClientOnly>`, or compute on mount |
| Data fetched twice (server and client) | `useFetch` called inside a handler or after an `await` that loses context; missing or unstable key |
| Value stops updating | Destructured `reactive`/props without `toRefs` or a getter; `watch(obj.x)` instead of `watch(() => obj.x)` |
| One user sees another's data | Module-level `ref`/object in a composable or plugin; global Pinia store instance reused on the server |
| Server route 500 or missing auth | Check handler validation and `createError({ statusCode, statusMessage })`; confirm cookies reach the handler during SSR |
| Slow or huge page payload | Inspect `useAsyncData` results; use the pick and transform options; avoid deep reactive data for large lists (`shallowRef`) |
| Nuxt or Vue upgrade | Read the official upgrade guide; `npx nuxi upgrade --dedupe`; run the codemods it references; fix type errors before features |
| Component library breaks on SSR | Register it client-only (`.client.vue` or `<ClientOnly>`); check its SSR support claim |

## Patterns and pitfalls

- **Props destructure (3.5)** — `const { size = 'md' } = defineProps<Props>()` stays reactive in templates and computed, but `watch(size, ...)` needs a getter: `watch(() => size, ...)`.
- **`defineModel()`** — the supported two-way binding helper; replaces the manual `modelValue` prop plus `update:modelValue` emit pair.
- **`useTemplateRef()` and `useId()`** — typed template refs and SSR-stable ids for labels and ARIA attributes.
- **Large or foreign objects** — `shallowRef` for big immutable data replaced wholesale; `markRaw` for class instances (editors, maps, chart objects) that must not become proxies.
- **`v-if` with `v-for`** — on the same element `v-if` wins in Vue 3 and cannot see the loop variable; filter in a computed or use a wrapping `<template>`.
- **Stable keys** — `:key` with ids, never the index, for lists that reorder or contain inputs.
- **Nuxt 4 data defaults** — fetch results default to `undefined` rather than `null` and data is shallow by default; check the installed version's docs before relying on deep mutation of fetched data.
- **Shared fetch keys** — calls with the same key share one data ref; conflicting options on the same key are a bug source.
- **Pinia setup stores** — return every state ref you need serialized; a store used outside setup (plugins, middleware) must receive the Nuxt app's Pinia instance.
- **Typed injection** — `provide`/`inject` with an `InjectionKey<T>`; a string key loses types and collides across libraries.
- **`routeRules`** — per-route `prerender`, `isr`, `swr`, `ssr: false` and headers; a caching rule on a personalized route serves one user's page to everyone.
- **Server-only code** — keep database clients and secrets under `server/`; shared types and pure helpers in `shared/` when the layout uses it.

## Workflow

1. Determine Vue-only or Nuxt, layout and rendering mode; read neighbouring components and composables for conventions.
2. For data: define the server route with validation first, then consume it with keyed `useFetch`/`useAsyncData`.
3. Build components with `<script setup lang="ts">`, typed props/emits/models, computed derivation and cleaned-up watchers.
4. Keep request state in `useState`/Pinia; check that payload contains nothing private.
5. Test components and composables; render the page server-side and hydrate it in a browser.
6. Build and run the production output.

## Proof

- Types: `npx nuxi typecheck` (Nuxt) or `npx vue-tsc --noEmit` (Vue)
- Tests: the project's runner, e.g. `npx vitest run`
- Production build: `npx nuxi build` (or `npx vite build` for Vue-only)
- Run it: `node .output/server/index.mjs`, then `curl -fsS localhost:3000/<route>` and check the HTML contains server-rendered content
- Static output: `npx nuxi generate` when the site is prerendered
- Bundle: `npx nuxi analyze` when size is the concern

## Stop and ask

- The change implies moving between SPA, SSR and static generation for the whole app.
- A secret or per-user value would end up in `runtimeConfig.public`, the payload or a cached route.
- An upgrade requires a Nuxt module that has no compatible release.

## Before returning

- [ ] Vue-only versus Nuxt, layout and rendering mode identified
- [ ] Reactivity preserved across destructuring, props and composable boundaries
- [ ] No request state in module scope; payload free of secrets
- [ ] Data fetching keyed, top-level and not duplicated on hydration
- [ ] Server routes validate input and authorize on the server
- [ ] Type check, tests and production build pass; SSR output checked with no hydration warnings

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Vue guide](https://vuejs.org/guide/introduction.html), [Nuxt docs](https://nuxt.com/docs/4.x/getting-started/introduction), [Nuxt data fetching](https://nuxt.com/docs/4.x/getting-started/data-fetching), [Nuxt upgrade guide](https://nuxt.com/docs/4.x/getting-started/upgrade).

## Skills in scope

- typescript-strict — typed `defineProps`, `defineEmits`, composables and Nitro handlers.
- api-design — Nitro `server/api` endpoints, validation schemas and error payloads.
- authentication-sessions — cookie sessions forwarded through SSR.
- design-system — shared visual tokens, themes and component states.
- testing — Vue components, composables and Nuxt SSR hydration behavior.
