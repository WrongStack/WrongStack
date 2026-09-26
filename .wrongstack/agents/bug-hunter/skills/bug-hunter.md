## Schema migrations in `packages/techstack`

- Treat a `SCHEMA_VERSION` bump as incomplete until `applySchema` (`packages/techstack/src/store/schema.ts`) contains a guarded migration for it. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a version bump alone ships a broken upgrade path to every file-backed store.
- Copy the guard pattern from `ensureCatalogStorageColumns` in `packages/core/src/session-catalog/store-schema.ts`: read the existing columns via `PRAGMA table_info(<table>)` into a set, then `ALTER TABLE ... ADD COLUMN` only for columns absent from that set. Never issue an unconditional `ALTER TABLE` — it throws on re-run against a store that already migrated.
- Report a schema bug as two defects when both are present: the missing migration, and the missing regression test. A version bump with no migration is the root cause; a passing test suite is what hid it.

## Test placement

- Put legacy-version regression tests in `packages/techstack/tests/store/store-roundtrip.test.ts`. Do not place them in `sqlite.test.ts`: that file mocks `node:sqlite`, so no SQL executes and migration defects are invisible there.
- Reproduce the failure by opening a store written at the *previous* `SCHEMA_VERSION`, not a fresh `:memory:` fixture. Fresh in-memory stores only exercise the new-database path and will pass against a store that cannot upgrade.
- When hunting a suspected migration bug, confirm which harness actually reaches real SQLite before trusting a green run; state in the finding which test file you reproduced in.

## Pitfalls

- Do not fix a migration by editing the `CREATE TABLE` body alone — that only affects newly created stores and silently splits old and new databases.
- Do not assume a clean `:memory:` suite proves the migration works; verify against an on-disk fixture at the prior version.
