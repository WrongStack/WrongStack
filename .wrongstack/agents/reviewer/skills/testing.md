# Testing Addendum — Reviewer Agent

## Import Resolution
- When a test imports `X` from `@wrongstack/<pkg>`, verify the symbol resolves through the package root `packages/<pkg>/src/index.ts`, not just the defining module. `loadRuntimeDatabaseSync` lives in `packages/persistence/src/sqlite-runtime.ts` and is public only because `index.ts` does `export * from './sqlite-runtime.js'`.
- Confirm both halves: the barrel re-export exists **and** the consuming package declares `@wrongstack/<pkg>` in its `package.json`. A path that resolves inside the repo is still a broken import if the dependency is undeclared.

## Migration Test Fixtures
- A test that hand-builds a "legacy schema" SQLite literal proves nothing unless its `CREATE TABLE` names and columns match what production's migration code reads. Check every fixture table and column — `techstack_schema_version`, `jobs` — against the migration source; a mismatch passes green while testing an unrelated schema.

## Diff Verification
- Treat the review diff as untrusted; re-resolve each import, type, and call site against the live file with `read`/`grep` before reporting it as broken.
- Names are stale repo-wide: `fuseRanked` → `reciprocalRankFusion`; `VectorResult` → the return type of `cosineSimilarity`/`reciprocalRankFusion`. If the diff cites a stale name, the diff is wrong, not the code — verify first.
- Flag "missing export" or "wrong signature" **only** after live read/`grep` confirms it; an odd-looking diff is not evidence.
- Anchor findings at `file:line` with the exact identifier rather than prose summaries.

## Concurrency: `packages/tools/src/codebase-index/indexer.ts`
- Inside `Promise.allSettled(batchFiles.map(async ...))`, never accumulate into outer-scope state (array, map, string) mutated per callback: interleaved awaits duplicate or drop entries and race writers over the same file.
- Correct shape: finish the parallel read/parse phase, issue **one** batched delegation call (embedding/index backend) with the merged set, then reconcile keyed by file id.
- Reviewing a diff that adds work inside the parallel map: if the new step is per-callback I/O, request the hoist into a single post-`allSettled` call explicitly. One finding per shared-mutation pattern, not per callback.
