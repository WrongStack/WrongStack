# Learned instructions for `test`

> Project-specific learning data for the `test` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T08:34:41.240Z; skill=testing; applied=1; wins=1 -->
- **Run WrongStack's storage slice without a build step via `npx vitest run packages/core/tests/storage` from repo root — the root `vitest.config.ts` aliases `@wrongstack/core` (and extracted packages) to source, so stale dist never affects these tests; note the package script `test` covers ALL of `packages/core/tests`, which is broader than storage.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `npx vitest run packages/core/tests/storage`
  - *How:* `vitest.config.ts`
  - *How:* `@wrongstack/core`
  - *How:* `test`
  - *How:* `packages/core/tests`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T08:21:41.933Z; skill=testing; applied=1; wins=1 -->
- **When an in-process test simulates a crash with a real `FileSessionWriter` in `packages/core/tests/storage/`, remember that `writer.close()` finalizes the summary sidecar (re-stamps `endedAt`/`outcome:'completed'`) — place `close()` after every assertion that reads crash-state via `store.load()`, or fabricate raw JSONL instead of opening a writer. Never leave a writer unclosed: it reproduces the A-14 leak class ("Closing file descriptor on garbage collection", future Node hard error).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `FileSessionWriter`
  - *How:* `packages/core/tests/storage/`
  - *How:* `writer.close()`
  - *How:* `endedAt`
  - *How:* `outcome:'completed'`
  - *How:* `close()`
  - *How:* `store.load()`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-22T08:34:41.240Z; skill=testing; applied=2; wins=2 -->
- **When `submit_result` returns the generic "required / confidence must be 0..1" error despite all fields present and in range, retry at most once with a compacted payload — if it still refuses, the channel-side validator is rejecting all payloads; deliver the report in the final text response instead of looping.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`

---
*Last capture: 2026-08-22T08:34:41.240Z · 3 entries*
