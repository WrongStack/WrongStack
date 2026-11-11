## Proven lifecycle guard

- In `packages/core/src/session-catalog/registry.ts`, decrement any new lifecycle reference counter in a `finally` around the awaited RPC; `activate_reservation` can reject with "Resume reservation expired", and a success-only decrement pins the binding so `closeBinding()` never closes its IPC client.

## Verification

- Typecheck affected packages with `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/<package>/tsconfig.json`. For `packages/tui` panel-controller changes, run `bunx biome check packages/tui/src/hooks/use-panel-controllers.ts` and `bun --bun run vitest run packages/tui/tests/mcp-panel-management.test.tsx`.
- Before export/import claims in co-modified files, grep live declarations, read imports from `./constants.js`, and attribute unrelated errors with `git status --short -- <path>`.

## Replay, sequence, paths, close

- In `packages/core/src/storage/session-store/tree-replay.ts`, read early `return` arms before claiming a wrong bucket: `branch_created`, `branch_switched`, and `branch_status_changed` return before `this.branchLastSeq.set(branch.id, seq)`, so branch-control events are never recorded against the trunk.
- In `packages/core/src/storage/file-session-writer.ts`, `_nextSeq` is the next assigned index: stamp with assign-then-advance, never pre-increment. The `session_start`/`session_resumed` preamble consumes journal, so pre-increment makes stamped `seq` disagree with `load-session-data.ts`'s `ev.seq ?? parsedEventIndex` fallback by one.
- In `load-session-data.ts`, `parsedEventIndex` is journal-absolute and increments per accepted event before eviction; never offset it by `eventsDropped`.
- Resolve relative write-target paths against `ctx.workingDir ?? ctx.cwd`, as `resolvePath()` in `packages/tools/src/_util.ts` does; `ctx.cwd` alone diverges after `set_working_dir()` and can make path-matched tool gates fire on the wrong file.
- Before adding a `close()` path that rejects the in-flight promise in `connectWithElection()` in `packages/core/src/session-catalog/client.ts`, verify an `explicitlyClosed` guard; without it the election loop can `spawnDetached()` a catalog daemon after `close()`.

## Trust hashing

- Do not claim a sibling is excluded from the plugin-directory digest on import-reachability grounds; membership comes from `walk(dir)`, not relative-import resolution. Do not re-flag shared-root import-closure hashing as a bypass without reading `hashLocalImportClosure`; `${relMissing}\0-1\0unresolved` records keep added/removed helpers digest-visible.
