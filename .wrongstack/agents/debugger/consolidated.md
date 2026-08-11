## Vitest Mock Typing

- When a hoisted Vitest mock factory is later reset with `mockReturnValue` / `mockResolvedValue` to a richer value, the factory's inferred return type will cause a TS2345/TS2322 mismatch against the reassigned value. Annotate the factory explicitly:
  - Sync: `vi.fn((): any => null)` instead of `vi.fn(() => null)`.
  - Async with single value: `vi.fn(async (): Promise<any> => null)` instead of `vi.fn(async () => null)`.
  - Async with array: `vi.fn(async (): Promise<any[]> => [])` instead of `vi.fn(async () => [])` (which infers `never[]`).
- Affected pattern in this project: slash-command coverage tests in `packages/cli/tests/kanban-slash-coverage.test.ts` and `memory-slash-coverage.test.ts`.

## Verifying Test-Side Type-Drift Fixes

- Do not judge success from raw `tsc -p <pkg>/tsconfig.test.json` output. It mixes hundreds of ACCEPTED baseline diagnostics with task-introduced errors.
- Use `node scripts/check-test-typecheck.mjs --report-only --json` and inspect the baseline-compared `newDiagnostics` array. Filter by `file` prefix to isolate the files you touched.
- Any raw `tsc` error that is absent from the task's new-diagnostics enumeration is baseline noise — leave it untouched. Example: `file-handlers.test.ts(41) TS2339 'sent'` is baseline and must not be "fixed" as part of a type-drift task.