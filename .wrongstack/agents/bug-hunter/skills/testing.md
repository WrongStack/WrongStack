## SQLite migration coverage

- Build the N-1 fixture with raw `loadRuntimeDatabaseSync()` DDL at a `mkdtempSync` path, then set the version row to the old `SCHEMA_VERSION`. A fresh-install fixture never reaches the upgrade branch; this is the only shape that does.
- Reopen the temp path through the real store constructor — not the raw loader — and assert both halves: the previously-throwing writer now succeeds, and the version row advanced to the current `SCHEMA_VERSION`. An assertion on only one of these passes even when the migration silently no-ops.
- Keep migration cases in `packages/techstack/tests/store/` beside `store-roundtrip.test.ts`, and clean up the `mkdtempSync` directory at the end of each case.

## Verification commands

- Typecheck: `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/techstack/tsconfig.json`
- Lint: `pnpm exec biome check packages/techstack/src/store/schema.ts packages/techstack/tests/store/store-roundtrip.test.ts` — scope Biome to the files you touched rather than the whole package.
- Tests: `pnpm exec vitest run packages/techstack/tests/store` — run the directory, not a single file, so sibling store tests catch regressions from schema changes.

## Pitfalls

- `packages/techstack/src/store/schema.ts` is the source of truth for `SCHEMA_VERSION`; read it, never hard-code the number in the test, or the fixture silently becomes a fresh install after the next bump.
