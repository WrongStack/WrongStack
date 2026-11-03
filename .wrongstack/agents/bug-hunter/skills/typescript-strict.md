## Live-tree adjudication

- Before editing a co-modified path, re-read the exact file immediately: `exec` `git diff --stat`, then `git diff -U0 -- <path>`, and repeat before a guarded `edit`. If `edit` reports external modification/no-match, re-anchor to live text; report externally fixed findings as resolved with live `file:line` anchors, and never retry unchanged. Re-read `packages/vibeui/src/lib/use-session.ts` immediately before every edit.
- For one-liner or missing-EOF-newline claims, inspect final bytes with `[System.IO.File]::ReadAllBytes(...)`, not rendered diffs. For trailing delimiters, inspect `(Get-Content <path>)[n][-30..-1] -join ''`. Use guarded `edit`, not PowerShell `String.Replace` with double-quoted backticks.
- Adjudicate TDZ claims about a `closure over a later-declared let` by checking whether any synchronous path can invoke it during module evaluation. `net` server `'connection'`, timers, and IPC callbacks cannot interleave with synchronous module-body execution. In `packages/sage/src/project-server.ts`, `createSlowOperationReporter(() => ({ pendingRequests, clients: clients.size }))` and the `createHygieneRunner` `isBusy` lambda are intentional startup-safe closures; check `packages/sage/tests/project-server-maintenance.test.ts`.

## Verification

- Use `bunx vitest run …`, `bunx biome check …`, and `node node_modules/typescript/bin/tsc --noEmit --pretty false -p <pkg>/tsconfig.json`; avoid `pnpm exec` because `packageManager` pins Bun `bun@1.4.3`.
- For Sage, run `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/sage/tsconfig.json`, `bunx biome check packages/sage/src/memory-text.ts`, and `bunx vitest run packages/sage/tests/store-helpers.test.ts`.
- For VibeUI, run `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/vibeui/tsconfig.json`, `bunx biome check packages/vibeui/src/lib/use-session.ts`, and `bunx vitest run packages/vibeui/tests/session.test.ts`.
- After run-control changes, run `bunx vitest run packages/webui-server/tests/goal-ws-handler.test.ts packages/webui-server/tests/goal-multiple-runs.integration.test.ts`, typecheck `packages/webui-server/tsconfig.json`, and lint `packages/webui-server/src/server/goal-ws-run-controls.ts`.

## Behavioral contracts

- In `packages/webui-server/src/server/goal-ws-run-controls.ts`, bare `runPromise` subsumes `(stopping && runPromise)`; `handleStop` sets `runStatus='stopped'` before clearing `runPromise`. Gate persistence with `host.releaseRunLease || wasStarting`; avoid ungated parallel `graph.runState` mutations.
- In `handleResumeGraph`, reject missing graph ids before `acquireGoalRunLease`/`acquireRunLease`; invalid ids must not acquire legacy leases or raise `GoalRunLeaseBusyError`.
- Before changing `packages/tui/src/app-view.tsx`, verify `useEffect` keyed on `liveSettings?.selectionMode` cannot clear `localSelectionMode` until that dependency changes.
