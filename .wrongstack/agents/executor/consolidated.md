## Type Checking Test Files

- When modifying any file under `packages/kanban/tests`, run `pnpm exec tsc --noEmit --pretty false -p packages/kanban/tsconfig.test.json`. The test tsconfig is strict enough to catch issues that runtime tests miss: optional collection access, incomplete `KanbanColumn` fixtures, stale API options, and unused test setup.
- To detect *newly introduced* test TypeScript diagnostics (as opposed to pre-existing baseline noise), use `node scripts/check-test-typecheck.mjs --json`. A raw `tsc -p packages/tools/tsconfig.test.json` run currently surfaces substantial baselined output plus cross-package `rootDir` leakage, making regressions hard to spot without the script's diffing.

## Test Type Narrowing

- When mocking `node:fs/promises`, derive the callback path argument from the real signature using `Parameters<typeof fs.readFile>[0]` or `Parameters<typeof fs.writeFile>[0]`, then narrow with `typeof path === 'string'` before performing any string-only operations on it.