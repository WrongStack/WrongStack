---
name: typescript-strict
description: |
  Use this skill when writing or reviewing TypeScript code with strict mode
  in WrongStack. Triggers: user mentions "TypeScript", "strict", "type error",
  "type safety", "narrowing", "branded type", "discriminated union", "noUncheckedIndexedAccess".
version: 1.1.0
---

# TypeScript Strict Mode — WrongStack

## Overview

Strict TypeScript patterns for WrongStack: exhaustive switch, branded types, discriminated unions, and `noUncheckedIndexedAccess`. WrongStack uses `strict: true` with additional strictness flags.

## Rules

1. Never silence errors with `as any` or double assertions — validate or narrow values at trust boundaries.
2. Don't use `!` non-null assertion — silence the type checker without explanation.
3. Always annotate return types on exported functions — hides errors otherwise.
4. Use `Promise<unknown>` or generics instead of `Promise<any>`.
5. Be specific with types — `Function` and `Object` are too broad.
6. Enable `noUncheckedIndexedAccess` — always handle the `undefined` case on array/object access.

## Patterns

### Do

```ts
// ✅ Exhaustive switch with assertNever
function assertNever(x: never): never {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`);
}
switch (block.type) {
  case 'text': return renderText(block);
  case 'tool_use': return renderToolUse(block);
  case 'error': return renderError(block);
  default: return assertNever(block);
}

// ✅ Branded types for invariants
type UserId = string & { readonly __brand: 'UserId' };
type SessionId = string & { readonly __brand: 'SessionId' };

// ✅ Discriminated union
type Result =
  | { status: 'success'; data: User }
  | { status: 'error'; error: Error }
  | { status: 'loading' };

// ✅ noUncheckedIndexedAccess — always handle undefined
const first = items.at(0);
if (first) console.log(first.toUpperCase());
```

### Don't

```ts
// ❌ Non-null assertion — silences the type checker
console.log(name!.toUpperCase());

// ❌ Promise<any> — loses type safety
async function fetchUser(): Promise<any> { ... }

// ❌ Too broad
const handler: Function = () => {};
const data: Object = {};

// ❌ Missing return type on export
export function processData(data: string) { ... }
```

## Non-negotiable rules

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitReturns": true,
  "exactOptionalPropertyTypes": true
}
```

Never silence errors with `as any` or double assertions. Validate or narrow values at trust boundaries.

## Workflow — applying strict TypeScript

Apply strict TypeScript in this order:

```
1. tsconfig.json          → enable strict flags first
2. Per-file patterns     → apply the patterns below
3. CI gate → tsc --noEmit must pass
```

**Step 1 — tsconfig.json** (the foundation):
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

**Step 2 — Per-file patterns** (after tsconfig):
- Add `assertNever` for exhaustive switches
- Create branded types for invariant strings (UserId, SessionId)
- Use discriminated unions instead of optional fields
- Handle `T | undefined` on every array/object access

**Step 3 — CI gate**:
```bash
pnpm run typecheck   # must pass before merge
```

## Patterns

### Exhaustive switch

```ts
function assertNever(x: never): never {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`);
}

switch (block.type) {
  case 'text': return renderText(block);
  case 'tool_use': return renderToolUse(block);
  case 'error': return renderError(block);
  default: return assertNever(block);
}
```

### Branded types for invariants

```ts
type UserId = string & { readonly __brand: 'UserId' };
type SessionId = string & { readonly __brand: 'SessionId' };

function toUserId(s: string): UserId {
  return s as UserId;
}

// now TypeScript won't let you accidentally pass SessionId where UserId is expected
```

### Discriminated unions

```ts
type Result =
  | { status: 'success'; data: User }
  | { status: 'error'; error: Error }
  | { status: 'loading' };

// ✅ TypeScript knows which fields exist in each branch
function handle(result: Result) {
  if (result.status === 'success') {
    console.log(result.data.name); // data exists here
  } else if (result.status === 'error') {
    console.log(result.error.message); // error exists here
  }
}
```

### noUncheckedIndexedAccess

After enabling `noUncheckedIndexedAccess: true`, array/object access returns `T | undefined`:

```ts
const items = ['a', 'b', 'c'];
const first: string | undefined = items[0]; // ✅ correct
const last = items[items.length - 1]; // string | undefined

// ✅ Always handle the undefined case
if (items[0] !== undefined) {
  console.log(items[0].toUpperCase());
}

// ✅ Or use a guard helper
const first = items.at(0);
if (first) console.log(first.toUpperCase());
```

## Anti-patterns

| Anti-pattern | Why bad | Fix |
|---|---|---|
| `!` non-null assertion | Silences the type checker | Use a narrow check |
| `Promise<any>` return type | Loses type safety | Use `Promise<unknown>` or generic |
| `Function` or `Object` types | Too broad | Be specific |
| `as any` or double assertions for shortcuts | Defeats type safety | Validate or narrow at boundaries |
| Optional chaining chain | `a?.b?.c?.d` when `a` might be undefined | Verify with if/guard first |
| Missing return types on exports | Hides errors | Always annotate public APIs |

## Useful utility types

```ts
// Make properties optional
type Partial<T> = { [P in keyof T]?: T[P] };

// Make properties required
type Required<T> = { [P in keyof T]-?: T[P] };

// Pick specific properties
type UserPreview = Pick<User, 'id' | 'name'>;

// Omit specific properties
type UserWithoutPassword = Omit<User, 'password'>;

// Readonly arrays
function processItems(items: readonly string[]): void { ... }
```

## Strict null checking

```ts
// ✅ Good — explicit handling
const name: string | null = getName();
if (name !== null) {
  console.log(name.toUpperCase());
}

// ✅ Optional chaining + nullish coalescing
const len: number = str?.length ?? 0;

// ❌ Bad — assumes not null
console.log(name!.toUpperCase());
```

## Skills in scope

- `node-modern` — for TypeScript + ESM patterns
- `react-modern` — for React + TypeScript patterns
- `bug-hunter` — for type-related bugs like unsafe casts
- `output-standards` — for standardized `<nextsteps>` formatting