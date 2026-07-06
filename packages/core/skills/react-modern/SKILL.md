---
name: react-modern
description: |
  Use this skill when writing or reviewing React 19+ code in WrongStack.
  Triggers: user mentions "React", "component", "useState", "useEffect",
  "Server Component", "Client Component", "Suspense", "useTransition", "use hook".
version: 1.1.0
---

# Modern React (19+) — WrongStack

## Overview

React 19+ patterns: Server Components by default, `use` hook for promises, `useTransition` for non-blocking updates, and clean client boundary management. WrongStack uses TypeScript throughout.

## Rules

1. Default to Server Components — mark `'use client'` only for interactive code.
2. Keep the client boundary minimal — avoid unnecessary serialization errors.
3. Don't use `useEffect` for data fetching — use Server Components or `use(promise)`.
4. Don't use `forwardRef` in new code — `ref` is a regular prop in React 19.
5. Use named exports for components — default exports hinder refactoring.
6. Event handlers must have explicit types: `React.MouseEvent<HTMLButtonElement>`.

## Patterns

### Do

```tsx
// ✅ Server Component — direct await
async function Profile({ userId }: { userId: string }) {
  const user = await fetch(`/api/users/${userId}`).then(r => r.json());
  return <div>{user.name}</div>;
}

// ✅ Client Component — use(promise) for thenables
import { use } from 'react';
function UserData({ promise }: { promise: Promise<User> }) {
  const user = use(promise);
  return <div>{user.name}</div>;
}

// ✅ useTransition for non-urgent updates
const [isPending, startTransition] = useTransition();
startTransition(() => setPage(page + 1));
```

### Don't

```tsx
// ❌ Bad — useEffect for data fetching
useEffect(() => { fetchData().then(setData); }, []);

// ❌ Bad — forwardRef in new code
const Button = forwardRef<HTMLButtonElement, ButtonProps>(...)

// ❌ Bad — default export
export default function Button() { ... }
```

## Component types

```tsx
// ✅ Server Component (default) — for data fetching and static UI
async function UserList() {
  const users = await db.query('SELECT * FROM users');
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}

// ❌ Client Component — mark only when needed
'use client';
import { useState } from 'react';
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```

Rule: Default to Server Components. Mark `'use client'` only for interactive code. Keep the client boundary minimal.

## Data fetching

```tsx
// ✅ Server Component — direct await
async function Profile({ userId }: { userId: string }) {
  const user = await fetch(`/api/users/${userId}`).then(r => r.json());
  return <div>{user.name}</div>;
}

// ✅ Client Component — use(promise) for thenables
import { use } from 'react';
function UserData({ promise }: { promise: Promise<User> }) {
  const user = use(promise);
  return <div>{user.name}</div>;
}

// ❌ Bad — useEffect for data fetching
useEffect(() => { fetchData().then(setData); }, []);
```

## State management

```tsx
// ✅ useState for local state
const [count, setCount] = useState(0);

// ✅ useTransition for non-urgent updates
const [isPending, startTransition] = useTransition();
startTransition(() => {
  setPage(page + 1);
});

// ✅ useReducer for state machines
const [state, dispatch] = useReducer(reducer, initialState);

// ❌ useEffect for derived state
// Bad: compute during render instead
const fullName = firstName + ' ' + lastName;
```

## Hook rules

| Hook | When to use | Anti-pattern |
|------|-------------|--------------|
| `useState` | Local component state | Don't sync with props via useEffect |
| `useReducer` | Complex state logic | Don't chain useState for related state |
| `useTransition` | Non-blocking updates | Don't use for urgent state changes |
| `useDeferredValue` | Deferring expensive rendering | Don't use for urgent state changes |
| `useCallback` | Stable function references for deps | Don't memoize everything — measure first |
| `useMemo` | Expensive computations | Don't memoize trivial calculations |
| `use` | Awaiting promises in render | Don't use outside component render |
| `useEffect` | Side effects only | Don't use for data fetching or derived state |

## Patterns

### Do

```tsx
// ✅ useDeferredValue for expensive search
function SearchResults({ query }: { query: string }) {
  const deferredQuery = useDeferredValue(query);
  // deferredQuery lags behind query — renders are non-blocking
}

// ✅ useCallback for stable deps in child
const handleClick = useCallback(() => {
  setCount(c => c + 1);
}, []);

// ✅ useMemo for expensive transformations
const sorted = useMemo(
  () => items.slice().sort((a, b) => a.name.localeCompare(b.name)),
  [items]
);
```

### Don't

```tsx
// ❌ useMemo for trivial operations
const doubled = useMemo(() => count * 2, [count]); // not worth it

// ❌ useCallback when deps change every render
const handleClick = useCallback(() => {
  doSomething(obj); // obj changes every render — no benefit
}, [obj]);

// ❌ useDeferredValue for simple state
const [name, setName] = useState('');
const deferredName = useDeferredValue(name); // overkill
```

### Common React 19 changes

- `ref` is a regular prop — no more `forwardRef`
- Server Components can be nested without serialization
- `use(promise)` — await thenables directly in components
- Actions — server functions callable from client

## Anti-patterns

| Anti-pattern | Why bad | Fix |
|---|---|---|
| `useEffect` to sync props to state | Causes extra render, stale data | Use controlled component or lift state |
| Class components in new code | Deprecated | Use function components + hooks |
| `forwardRef` in new code | `ref` is a regular prop in React 19 | Pass `ref` as a normal prop |
| Default exports for components | Hinders refactoring | Named exports |
| Mixing Server/Client boundaries | Serialization errors | Keep boundary clean |

## TypeScript patterns

```tsx
// ✅ Props with explicit type
interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
}

// ✅ Event handler types
const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => { ... };

// ✅ useRef with nullable initial
const inputRef = useRef<HTMLInputElement>(null);
```

## Skills in scope

- `typescript-strict` — for TypeScript patterns
- `node-modern` — for React server components with Node.js
- `bug-hunter` — for React-specific bugs (stale closures, memory leaks)
- `output-standards` — for standardized `<nextsteps>` formatting