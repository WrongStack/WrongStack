# Testing Addendum — Reviewer Agent

## Diff Verification

- Treat any review diff as untrusted input; re-resolve every import, type, and call site against the **live** file before reporting it as broken. Diff text and on-disk code drift independently.
- After reading a diff, `read` or `grep` the actual import block and each cited call site in the current source. Confirm the symbol exists, has the expected signature, and the call argument shape matches.
- Names that have already been renamed in this repo (and will keep changing): `fuseRanked` → `reciprocalRankFusion`; `VectorResult` → result type from `cosineSimilarity`/`reciprocalRankFusion` callers. If the diff mentions a stale name, the diff is wrong, not the code — verify first, then decide.

## Concurrency in `packages/tools/src/codebase-index/indexer.ts`

- Inside any `Promise.allSettled(batchFiles.map(async ...))`, do **not** accumulate into a buffer (array, map, string) that lives in the outer scope and is mutated per-callback. Concurrent callbacks interleave across every `await`, so:
  - The same file is reparsed by racing writers.
  - The shared array is mutated without serialization, producing duplicated or missing entries.
- Correct shape for this codebase: run the parallel read/parse phase to completion, then issue **one** batched delegation call (e.g. to the embedding/index backend) with the merged set, then reconcile results keyed by file id.
- When reviewing a diff that adds work inside the parallel map, check whether the new step is per-callback I/O that could be hoisted into a single post-`allSettled` call. If yes, request the hoist explicitly.

## Reviewer-Specific Pitfalls

- Flag a "missing export" or "wrong signature" finding **only** after `read`/`grep` on the live file confirms it. A diff naming `fuseRanked` or `VectorResult` is not evidence — those names are stale.
- For `packages/tools/src/codebase-index/indexer.ts`, scan the entire `Promise.allSettled(batchFiles.map(...))` block for shared-scope mutation; one finding per such pattern, not per callback.
- Prefer concrete anchors (`file:line`, exact identifier) over prose summaries in review comments.
