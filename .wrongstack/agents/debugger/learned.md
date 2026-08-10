# Learned instructions for `debugger`

> Project-specific learning data for the `debugger` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-07-31T21:08:04.406Z -->
- **Always annotate hoisted Vitest mock factories with an explicit return type when the mock is later re-set with `mockReturnValue`/`mockResolvedValue` to a richer value: `vi.hoisted(() => vi.fn(() => null))` infers return `null` (and `vi.fn(async () => [])` infers `never[]`), which makes later `mockReturnValue(<object>)` fail with TS2345/TS2322. Use `vi.fn((): any => null)` for sync factories and `vi.fn(async (): Promise<any> => null)` / `vi.fn(async (): Promise<any[]> => [])` for async ones — see `packages/cli/tests/kanban-slash-coverage.test.ts` and `memory-slash-coverage.test.ts`.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mockReturnValue`
  - *How:* `mockResolvedValue`
  - *How:* `vi.hoisted(() => vi.fn(() => null))`
  - *How:* `null`
  - *How:* `vi.fn(async () => [])`
  - *How:* `never[]`
  - *How:* `mockReturnValue(<object>)`
  - *How:* `vi.fn((): any => null)`
  - *How:* `vi.fn(async (): Promise<any> => null)`
  - *How:* `vi.fn(async (): Promise<any[]> => [])`
  - *How:* `packages/cli/tests/kanban-slash-coverage.test.ts`
  - *How:* `memory-slash-coverage.test.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-07-31T21:12:41.601Z -->
- **Always verify test-side type-drift fixes with `node scripts/check-test-typecheck.mjs --report-only --json` and parse the baseline-compared `newDiagnostics` array (filter by `file` prefix) — never judge success from raw `tsc -p <pkg>/tsconfig.test.json` output, which mixes hundreds of ACCEPTED baseline diagnostics with the new ones. A raw-tsc error that is absent from the task's NEW-error enumeration (e.g. `file-handlers.test.ts(41) TS2339 'sent'`) is baseline and must be left untouched.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `node scripts/check-test-typecheck.mjs --report-only --json`
  - *How:* `newDiagnostics`
  - *How:* `file`
  - *How:* `tsc -p <pkg>/tsconfig.test.json`
  - *How:* `file-handlers.test.ts(41) TS2339 'sent'`
  - *How:* `scripts/check-test-typecheck.mjs`

---
*Last capture: 2026-07-31T21:08:04.406Z · 2 entries*
