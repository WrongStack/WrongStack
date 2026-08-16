---
name: typescript-strict
description: |
  Use this skill when writing or reviewing TypeScript code with strict mode
  in WrongStack. Triggers: user mentions "TypeScript", "strict", "type error",
  "type safety", "narrowing", "branded type", "discriminated union", "noUncheckedIndexedAccess".
version: 1.2.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run]
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

## Out of scope

- **Don't use `as any` or double assertions to silence errors.** Validate or narrow values at trust boundaries. A cast that hides a real type error is a bug surfaced later in runtime.
- **Don't use `!` non-null assertion.** `name!.toUpperCase()` silences the type checker without explanation. Use a narrow check or an assertion function.
- **Don't use `Function` or `Object` types.** They're too broad; `any`-shaped in disguise. Be specific.
- **Don't return `Promise<any>`.** `Promise<unknown>` or a generic. `Promise<any>` loses the type information the caller needs.
- **Don't omit return types on exported functions.** Without an explicit return type, exported functions hide errors and let callers assume any shape. Annotate public APIs.
- **Don't use optional chaining chains to dodge narrowing.** `a?.b?.c?.d` is "I don't know what `a` is" with a costume. Verify with `if (a)` first.
- **Don't loosen `noUncheckedIndexedAccess` to make tests pass.** It is the safety net. Once it's off, array access silently returns `T` instead of `T | undefined` and `undefined` slips through.
- **Don't mix `enum` and union types.** Pick one per project. `enum` is the legacy form; const-asserted string unions are the modern form.
- **Don't write code that compiles under `strict: false`.** WrongStack runs with `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, and `exactOptionalPropertyTypes`. Code that only compiles under relaxed flags is the kind of debt this skill exists to prevent.
- **Don't accept `unknown` without narrowing at the use site.** `unknown` is the safe top type; leaving it un-narrowed is a typed-any escape hatch.

## Before returning

- [ ] No `as any` or double assertions; validation/narrowing at boundaries
- [ ] No `!` non-null assertion; narrow checks or assertion functions instead
- [ ] No `Function` or `Object`; specific function/object types used
- [ ] No `Promise<any>`; `Promise<unknown>` or generic
- [ ] Exported functions carry explicit return types
- [ ] `noUncheckedIndexedAccess` honored; `T | undefined` handled at every index access
- [ ] `exactOptionalPropertyTypes` honored; `prop?: T` and `prop: T | undefined` distinguished
- [ ] Discriminated unions used over optional fields where state is finite
- [ ] `assertNever` in `default:` of exhaustive switches
- [ ] Branded types for invariant strings (`UserId`, `SessionId`)
- [ ] `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `exactOptionalPropertyTypes` in `tsconfig.json`
- [ ] `pnpm run typecheck` passes before merge
- [ ] `<nextsteps>` mirrors open follow-ups (cast removals, narrowing gaps, tsconfig tightening)

## Skills in scope

- `node-modern` — for TypeScript + ESM patterns
- `react-modern` — for React + TypeScript patterns
- `bug-hunter` — for type-related bugs like unsafe casts
- `output-standards` — for standardized `<nextsteps>` formatting
