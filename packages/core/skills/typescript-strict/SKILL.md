---
name: typescript-strict
description: |
  Use this skill when writing, reviewing, or fixing TypeScript where type safety matters — type errors, narrowing, unsafe casts, or tightening compiler strictness.
  Triggers: user mentions "TypeScript", "type error", "tsc", "strict", "type safety", "narrowing", "any", "unknown", "discriminated union", "branded type", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes".
version: 2.1.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run]
trigger: "Use this skill when writing, reviewing, or fixing TypeScript where type safety matters \u2014 type errors, narrowing, unsafe casts, or tightening compiler strictness."
metadata:
  routing-group: frontend
---

# TypeScript Strict

## Selection card
- Task: TypeScript contracts and narrowing without any.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Target TypeScript 7.0.2, verified from npm on 2026-10-09. Static types protect
compile-time contracts; external data still needs runtime validation. Work
within the project strictness and module-resolution contract.

## Rules

1. **Pre-flight: Inspect repo `tsconfig.json` & live TypeScript version first.** Check `package.json`
   for the installed `typescript` version and inspect the project's `tsconfig.json`. Query
   `registry.npmjs.org/typescript/latest` before recommending modern compiler flags (e.g.
   `isolatedDeclarations` in TS 5.5+, `satisfies` in TS 4.9+) to ensure compiler compatibility.
2. Respect the project's `tsconfig`. Write code that passes the flags it has.
   Tightening flags repo-wide is a separate, requested change — it can surface
   hundreds of errors.
3. Fix type errors, don't silence them. No `as any`, no `as unknown as T`, no
   `@ts-ignore`; a `@ts-expect-error` needs a comment explaining why.
3. Choose satisfies when validating an inferred expression without replacing its
   inferred type; keep intentional annotations/widening where the contract needs them.
4. Validate at trust boundaries. JSON, network responses, environment, and user
   input arrive as `unknown` and are narrowed by Zod, TypeBox, or explicit type guards.
5. Prefer narrowing to assertion. A non-null `!` or an `as` cast is acceptable
   only where the invariant is locally obvious and a check would be noise.
6. Model finite states as discriminated unions, and end exhaustive switches with
   a `never` check so a new variant fails to compile.
7. Always handle potential `undefined` safely when `noUncheckedIndexedAccess` is active.
8. Annotate the return types of exported functions (`isolatedDeclarations` compliance);
   inference is fine inside private helpers.

## Fixing a type error

1. Read the full error, including the "Type X is not assignable to Y" chain —
   the last line usually names the real mismatch.
2. Decide which side is wrong: the value, or the declared type. Changing the
   declaration to match a buggy value hides the bug.
3. Fix at the source of the bad value, not at every use site.
4. Re-run the checker; one fix can expose or clear several errors.

## Patterns

```ts
// Exhaustive switch — adding a variant becomes a compile error here.
type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'error'; message: string };

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function render(block: Block): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return block.url; // Caller must render/escape this as data, never interpolate untrusted HTML.
    case 'error':
      return block.message;
    default:
      return assertNever(block);
  }
}

// Trust boundary — unknown in, narrowed out.
interface User {
  id: string;
  email: string;
}

function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).email === 'string'
  );
}

const body: unknown = await response.json();
if (!isUser(body)) throw new Error('Unexpected user payload');

// Branded id — a SessionId can no longer be passed where a UserId is expected.
type UserId = string & { readonly __brand: 'UserId' };
const toUserId = (raw: string): UserId => raw as UserId; // the one sanctioned cast
```

With a schema library already in the project (zod, valibot, arktype), use it at
the boundary instead of hand-written guards.

## Strictness flags worth knowing

| Flag | What it catches | Typical fix |
|---|---|---|
| `strict` | Implicit any, unchecked null, loose function types | Annotate; narrow nullables |
| `noUncheckedIndexedAccess` | `arr[i]` and `record[key]` may be undefined | Check the value, or use `.at()` with a guard |
| `exactOptionalPropertyTypes` | `prop?: T` receiving an explicit `undefined` | Declare `prop?: T \| undefined`, or omit the key |
| `noImplicitReturns` | Code paths that fall off the end | Return on every path |
| `noImplicitOverride` | Accidental method overrides | Add `override` |

## Anti-patterns

| Anti-pattern | Why it hurts | Instead |
|---|---|---|
| `as any` / double assertion | Turns off checking for everything downstream | Narrow, or fix the declaration |
| `Function`, `Object`, `{}` as types | Accept almost anything | Specific signatures and shapes |
| `Promise<any>` | Callers lose all type information | `Promise<unknown>` or a generic |
| `a?.b?.c?.d` to dodge an unclear type | Hides which level can be absent | Establish what can be absent, then narrow |
| Optional fields for mutually exclusive states | Allows impossible combinations | Discriminated union |
| Loosening `tsconfig` to make an error go away | Reintroduces the whole class of bugs | Fix the code |

## Before returning

- [ ] Code passes the project's own `tsconfig`, checked with the type checker
- [ ] No new `any`, double assertions, or unexplained suppressions
- [ ] External data narrowed from `unknown` at the boundary
- [ ] Finite states modeled as unions with exhaustive handling
- [ ] Exported functions have explicit return types

## Current compiler and module contract

Target TypeScript 7.0.2, checked from npm on 2026-10-09. Verify compiler/migration
support in the framework and build plugins; use the repository's authoritative
checker rather than silently substituting a different implementation.
Match moduleResolution/module/exports to the emitted runtime: bundler and
NodeNext describe different consumers. Type checking does not validate network
payloads or ensure HTML strings are escaped.
satisfies checks compatibility without serving as a runtime parser or a
universal replacement for intentional annotations and widening.
Read the [resolution reference](https://www.typescriptlang.org/tsconfig/moduleResolution.html).

## Skills in scope

- `node-modern` — for runtime patterns in Node.js TypeScript code
- `react-modern` — for component and hook typing
- `testing` — for type-safe fixtures and assertions
