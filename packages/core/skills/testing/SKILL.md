---
name: testing
description: |
  Use this skill when writing, reviewing, or improving tests in WrongStack.
  Triggers: user says "test", "unit test", "integration test", "e2e", "mock",
  "vitest", "coverage", "assert", "expect", "test strategy", "write tests".
version: 1.1.0
required-capabilities: [filesystem.read, verification.run]
required-tools: []
optional-capabilities: [execution.shell]
---

# Testing — WrongStack

## Overview

Writes and reviews tests for WrongStack TypeScript code. WrongStack uses **vitest** as the test runner, **pnpm workspaces**, and co-located test files (`foo.ts` → `foo.test.ts`). Tests must pass before every commit.

## Rules

1. Co-locate tests: `src/foo.ts` → `tests/foo.test.ts` (same package).
2. Always test public API surfaces — don't test internals.
3. Use `vi.mock()` for external deps; never mock internal modules.
4. Every async test needs a timeout: `test(..., { timeout: 5000 })`.
5. Mock time with `vi.useFakeTimers()` for debounce/throttle tests.
6. Coverage gate: new code must have ≥70% coverage, don't lower existing coverage.
7. Don't commit test-only deps — test deps go in `devDependencies`.
8. Tests must be isolated — each test cleans up its mocks/state.

## Patterns

### Do

```typescript
// ✅ Co-located test
// packages/tools/src/bash.ts → packages/tools/tests/bash.test.ts

// ✅ Test the public API
import { parseArgs } from '../src/arg-parser';
test('parses --flag value pairs', () => {
  expect(parseArgs(['--name', 'Alice'])).toEqual({ name: 'Alice' });
});

// ✅ Async test with timeout
test('fetches user data', async () => {
  const user = await fetchUser('123');
  expect(user.name).toBe('Alice');
}, { timeout: 5000 });

// ✅ Mock external deps
vi.mock('axios');
const axios = await import('axios');
vi.mocked(axios.get).mockResolvedValue({ data: { name: 'Alice' } });

// ✅ Fake timers for debounce
vi.useFakeTimers();
vi.advanceTimersByTime(300);
expect(handler).toHaveBeenCalledWith('input');

// ✅ Isolation — cleanup
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
```

### Don't

```typescript
// ❌ Mocking internal modules
vi.mock('../src/internal/helper'); // internal — don't mock

// ❌ No timeout on async test
test('fetches data', async () => {
  // fetch hangs forever in CI — always add timeout
});

// ❌ Testing implementation details
test('calls validateEmail() three times', () => {
  // ❌ fragile — test behavior, not implementation
});

// ❌ Forgotten cleanup
// Mocked axios persists across tests — always cleanup
```

## Test types

| Type | Scope | When to use |
|------|-------|-------------|
| **Unit** | Single function/module | Pure logic, parsing, transformations |
| **Integration** | Multi-module interaction | API calls, file I/O, tool chains |
| **E2E** | Full command flow | CLI smoke tests, slash commands |

### Unit test structure

```typescript
describe('parseArgs', () => {
  it('parses --flag value', () => {
    expect(parseArgs(['--name', 'Alice'])).toEqual({ name: 'Alice' });
  });

  it('throws on missing value for --required', () => {
    expect(() => parseArgs(['--required'])).toThrow();
  });

  it.each([...])('handles %s input', (input, expected) => {
    expect(parseArgs(input)).toEqual(expected);
  });
});
```

### Integration test structure

```typescript
test('executes bash tool with timeout', async () => {
  const result = await bash({
    command: 'echo hello',
    cwd: '/tmp',
    signal: AbortSignal.timeout(5000),
  });
  expect(result.stdout.trim()).toBe('hello');
}, { timeout: 10000 });
```

## Mocking patterns

```typescript
// ✅ Mock node:fs/promises
vi.mock('node:fs/promises');
const fs = await import('node:fs/promises');
vi.mocked(fs.readFile).mockResolvedValue('content');

// ✅ Mock process.env
const originalEnv = process.env;
beforeEach(() => { process.env = { ...originalEnv }; });
afterEach(() => { process.env = originalEnv; });

// ✅ Mock spawn
vi.mock('node:child_process');
const { spawn } = await import('node:child_process');
vi.mocked(spawn).mockReturnValue({
  on: vi.fn(),
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
} as any);
```

## Coverage

```bash
# Run with coverage
pnpm test -- --coverage

# Coverage thresholds (enforced in CI)
coverageThreshold: {
  global: { branches: 70, functions: 70, lines: 70, statements: 70 }
}
```

## WrongStack-specific test notes

- **Subpath exports**: Some packages define an `exports` field in `package.json` — tests must use the public entry point, not `dist/`.
- **AbortSignal**: Any test involving timeouts must use `AbortSignal.timeout()` not `setTimeout`.
- **pnpm workspaces**: Run `pnpm test` in the package root, or `pnpm -r test` for all packages.
- **Vitest config**: Each package has its own `vitest.config.ts`.

## Out of scope

- **Don't test internal modules.** Test the public API surface. Mocking `../src/internal/helper` couples the test to implementation; the moment the helper moves, the test breaks for the wrong reason.
- **Don't commit test-only deps to `dependencies`.** Devs install `devDependencies`. Test-only deps in `dependencies` bloat the production install and can leak into runtime code.
- **Don't lower the coverage gate to make tests pass.** New code carries its own ≥70% coverage; existing coverage never decreases. A passing test suite with sinking coverage is regression, not progress.
- **Don't write async tests without a timeout.** `test(..., { timeout: 5000 })` is mandatory. A hang in CI is a worse failure than a flapping test.
- **Don't mock `node:fs` and forget cleanup.** `vi.restoreAllMocks()` and `vi.useRealTimers()` in `afterEach` are mandatory. Mocks leaking across tests are how unit tests go red in a clean checkout.
- **`setTimeout` is the wrong timeout primitive in tests.** `AbortSignal.timeout()` is the WrongStack convention. A timer, not a signal, bypasses the abort plumbing.
- **Don't import from `dist/`.** Subpath exports are the entry point. `dist/` is build output; tests against it depend on the build having been run.
- **Don't report a coverage percentage from a partial run.** Coverage is the full suite, not a subset. A 90% on 60% of the files is not 90%.

## Before returning

- [ ] Tests co-located: `src/foo.ts` → `tests/foo.test.ts` in the same package
- [ ] Public API only; no internal-module mocks
- [ ] Async tests carry an explicit timeout (`{ timeout: 5000 }` or appropriate)
- [ ] `vi.restoreAllMocks()` and `vi.useRealTimers()` in `afterEach`
- [ ] `AbortSignal.timeout()` used for timeouts, not `setTimeout`
- [ ] No new `dependencies` entries for test-only packages
- [ ] Coverage gate met: new code ≥70%, existing coverage not reduced
- [ ] Coverage from full suite, not partial run
- [ ] Failing tests pair with the code under test, not staged in a separate commit
- [ ] `<nextsteps>` mirrors the open test gaps in priority order

## Skills in scope

- `bug-hunter` — for turning test failures into concrete bugs
- `typescript-strict` — for type-safe test assertions
- `node-modern` — for async/test patterns with AbortSignal
- `git-flow` — for committing tests with the code they test
- `output-standards` — for standardized `<nextsteps>` formatting
