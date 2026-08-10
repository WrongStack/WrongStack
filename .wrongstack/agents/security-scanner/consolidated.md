# Learned Instructions for `security-scanner`

## Mailbox & Actor State Integrity

- **Prevent previous-version mailbox writers or compactors from mutating a JSONL mailbox after v2 receipt records are enabled.** Compaction in `packages/core/src/coordination/global-mailbox.ts` rewrites only materialized message objects; an older codec that ignores unknown receipt records can silently erase security-relevant actor state. Enforce an exclusive writer-version fence with offline backup-based rollback. Never dual-write global completion for new fan-out messages.

## Encryption Enforcement

- **Require effective encryption before any sync write.** `packages/core/src/plugins/sync-plugin.ts` must reject missing or no-op encryption before writing `sync.json`. The host vault must be passed to built-in plugins through the top-level plugin API config in `packages/cli/src/wiring/plugins.ts`.

## Deletion Guards & Audit Trail

- **Guard permanent-memory deletion in `updateSage()` by checking both the persisted persistence class and `input.persistence`.** A request like `{ persistence: 'permanent', status: 'deleted' }` must not bypass an existing-state-only deletion check. Every forced deletion in `packages/sage/src/sqlite-store.ts` must be recorded in the audit log with the force decision and persistence class.

## SAGE SQLite Store Safety

- **Always `await this.initialize()` before calling `runMutation()` from public methods in `packages/sage/src/sqlite-store.ts`.** The mutation queue immediately consumes `this.db`; without initialization, a first-operation API fails at transaction startup instead of returning its documented domain result, masking the real error.

- **Decode multi-row SAGE SQLite query results through `sqliteRowsToMemories` from `packages/sage/src/sqlite-store-search-helpers.ts`.** Its per-row exception handling prevents a single malformed persisted JSON record from crashing listing, audience-retrieval, search, or verification surfaces.

- **Keep the `removedEdges` count predicate aligned with `cascadeDeleteEdges` in `packages/sage/src/sqlite-store.ts`.** Both must exclude `related_to` structural edges, which are deliberately preserved during memory deletion.

## Hygiene & Verification Integrity

- **Use `runMutation` as the only transaction boundary for SQLite hygiene deduplication.** Emit `memory.hygiene_dedup` only after that transaction commits.

- **Include normalized audience identity in `SqliteSageStore.hygiene()` deduplication keys.** Persist enabled anchor-verification results through `runMutation`; `verify: false` must perform no verification writes.

## SQLite Loader Warnings

- **Keep the TechStack SQLite loader's narrowly filtered `process.emitWarning` shim active across both lazy `node:sqlite` loading and `DatabaseSync` construction**, restoring the original function in `finally`. Store parent paths must use `node:path.dirname`.

## Compaction Summary Cache

- **Reset `defaultCompactionSummaryCache` in `beforeEach` when testing `CompactionSummaryCache`.** Empty/whitespace-only summaries and the `(empty)` / `(empty summary)` sentinels are excluded from caching; successful values retain their original formatting. Race tests should explicitly invoke two same-key `getOrCreate` calls concurrently.