# Modern React (Compact)

<!-- source-version: 2.2.1 -->

## Selection card
- Task: React component state, forms and hooks. / TR: React bileşen durumu, form ve hook.
- Start: Read the component, its parents and the React version and framework setup (Vite, Next.js, Remix or other).
- Finish: The component behaves correctly in tests or the browser with no new effect loops, key warnings or hydration errors.

## Overview

Most React bugs come from the same few places: state that should have been
derived, effects used as event handlers, and data fetching that races. Before
applying any pattern, establish the setup — the React version in package.json,
and whether a framework with Server Components (Next.js App Router, React
Router framework mode) is in play or it is a client-only app (Vite, CRA, Expo).
Several "modern" rules only apply to one of the two.

## Rules

1. **Pre-flight: Inspect repo & live registry versions first.** Check `package.json`
   for the exact React version (`"react"`, `"react-dom"`) and framework setup. Query
   `registry.npmjs.org/react/latest` or online docs to verify current React 19 stable
   capabilities (such as `useActionState`, `useOptimistic`, `use()`, and ref-as-prop without `forwardRef`).
   If the repo is on React 18, identify upgrade steps before applying React 19-only hooks.
2. Match the setup. Server Components, `'use client'`, and server actions exist
   only in RSC frameworks. In a client-only app, fetch through the project's data
   layer (TanStack Query, SWR, a loader) instead.
3. Derive, don't sync. If a value can be computed from props or state during
   render, compute it; don't mirror it into state with an effect.
3. Effects are for synchronizing with external systems (subscriptions, DOM
   APIs, timers, non-React widgets). User-caused changes belong in event
   handlers.
4. Every effect that subscribes or starts work returns a cleanup, and every
   async effect guards against stale responses (abort or ignore flag).
5. Never mutate state or props; update with new objects and arrays.
6. Keys are stable identities from the data — never array indexes for lists
   that reorder, insert, or delete.
7. Memoize after measuring; inspect compiler coverage before adding manual memoization.
   `useMemo`/`useCallback` exist for expensive work and referential stability
   a child or effect actually depends on.
8. Follow the framework's file conventions over style preferences — Next.js
   `page.tsx`, `layout.tsx`, and route files require a default export even when
   the codebase otherwise prefers named exports.
9. Accessible by default: semantic elements, labels on inputs, keyboard
   operability, focus management for dialogs.

## Detailed workflow

Load the full react-modern skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Setup identified: React version, and RSC framework or client-only
- [ ] No state mirrored from props; effects only sync external systems, with cleanup
- [ ] Async work guarded against stale responses
- [ ] Stable keys; no state or prop mutation
- [ ] Framework file conventions respected
- [ ] Inputs labelled, keyboard path works
