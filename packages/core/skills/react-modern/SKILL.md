---
name: react-modern
description: |
  Use this skill when writing, reviewing, or debugging React components and hooks — state, effects, data fetching, forms, Server and Client Components — in whatever React setup the project uses.
  Triggers: user mentions "React", "component", "hook", "useState", "useEffect", "re-render", "Server Component", "use client", "Suspense", "useTransition", "useActionState", "Next.js", "JSX", "TSX".
version: 2.1.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, browser.interact]
trigger: "Use this skill when writing, reviewing, or debugging React components and hooks \u2014 state, effects, data fetching, forms, Server and Client Components \u2014 in whatever React setup the project uses."
metadata:
  routing-group: frontend
---

# Modern React

## Selection card
- Task: React component state, forms and hooks.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

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

## Patterns

```tsx
// Derived value — no state, no effect.
function Cart({ items }: { items: CartItem[] }) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return <p>Total: {formatMoney(total)}</p>;
}

// Effect that syncs with an external system, with cleanup.
function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

// Client-only fetch without a data library: abort stale requests.
function useUser(id: string) {
  const [state, setState] = useState<{ user?: User; error?: Error }>({});
  useEffect(() => {
    const controller = new AbortController();
    fetchUser(id, controller.signal)
      .then((user) => setState({ user }))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ error });
      });
    return () => controller.abort();
  }, [id]);
  return state;
}
```

```tsx
// RSC frameworks only: server data in a Server Component, interactivity in a leaf.
export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser(id); // runs on the server
  return <ProfileHeader user={user} />;
}

// React 19 form action with pending and error state.
'use client';
function RenameForm({ rename }: { rename: (prev: State, data: FormData) => Promise<State> }) {
  const [state, action, pending] = useActionState(rename, { error: null });
  return (
    <form action={action}>
      <label htmlFor="name">Name</label>
      <input id="name" name="name" required />
      <button type="submit" disabled={pending}>Save</button>
      {state.error ? <p role="alert">{state.error}</p> : null}
    </form>
  );
}
```

## React 19 notes

- `ref` is a regular prop for function components; new code doesn't need
  `forwardRef`.
- `use(promise)` suspends on a promise, which must be created outside render
  (passed from a Server Component, or cached) — a promise created during render
  is recreated on every render.
- Actions (`useActionState`, `useFormStatus`, `useOptimistic`) replace most
  hand-rolled pending and error state for forms.

## Debugging re-renders and stale values

| Symptom | Usual cause | Fix |
|---|---|---|
| Effect runs in a loop | Object or function dependency recreated each render | Move it inside the effect, or derive a primitive dependency |
| Handler sees an old value | Closure captured stale state | Functional update `setX((prev) => …)`, or read the latest value inside the effect |
| Input loses focus while typing | Component defined inside another component, or unstable key | Hoist the component; stable keys |
| List items swap state | Index keys on a reordering list | Keys from item identity |
| Hydration mismatch | Rendering time, randomness, or browser-only values on the server | Render those after mount, or pass them from the server |

## Anti-patterns

- **An effect that sets state from props** — derive it, or reset with a `key`.
- **Fetching in an effect without abort or ignore** — responses arrive out of order.
- **`'use client'` at the top of a whole route tree** in an RSC app — it ships
  everything to the browser.
- **Memoizing everything by default** — cost without a measured benefit.
- **Class components or `forwardRef` in new code** on React 19.

## Before returning

- [ ] Setup identified: React version, and RSC framework or client-only
- [ ] No state mirrored from props; effects only sync external systems, with cleanup
- [ ] Async work guarded against stale responses
- [ ] Stable keys; no state or prop mutation
- [ ] Framework file conventions respected
- [ ] Inputs labelled, keyboard path works

## Current React and async semantics

Target React/react-dom 19.3.0, checked from npm on 2026-10-09; upgrade the pair
with the framework and type packages after checking peer requirements.
Keep rendering pure, make cleanup work under Strict Mode and distinguish
optimistic state from persisted success. Server Action authorization belongs
server-side even when useActionState provides UI feedback.
useEffectEvent is for non-reactive logic called from Effects; it is not a way
to hide reactive dependencies or create an ordinary click handler.
Check its [current semantics](https://react.dev/reference/react/useEffectEvent).

## Skills in scope

- `typescript-strict` — for component and hook typing
- `design-system` — for styling against the project's tokens
- `testing` — for behaviour-level component tests
