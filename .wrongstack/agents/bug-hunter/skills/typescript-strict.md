## Retry and live-tree hygiene
- On retries, re-read the live call site before editing; if a fix is already present, report it resolved instead of re-applying and corrupting the diff. Use `git status --short -- <path>` to attribute remaining `tsc` diagnostics before counting a non-zero exit against the reviewed change.
- Re-read `packages/vibeui/src/lib/use-session.ts` immediately before a guarded `edit`; if a peer rewrite blocks the edit, report externally fixed findings with live `file:line` anchors.
- Adjudicate Chimera file-shape claims (`one-liner`, missing EOF newline) with `[System.IO.File]::ReadAllBytes(...)` on trailing bytes; stale rendered diffs are not authoritative.

## Strict verification commands
- Use local TypeScript (`node node_modules/typescript/bin/tsc`) and `bunx` because `packageManager` pins Bun `bun@1.4.3`; do not use `pnpm exec`.
- Verify `packages/webui-server` “missing required property” claims with `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/webui-server/tsconfig.json`.
- For edited packages, run narrow `node node_modules/typescript/bin/tsc --noEmit --pretty false -p <tsconfig>` checks against `packages/webui-server/tsconfig.json`, `packages/sage/tsconfig.json`, and `packages/vibeui/tsconfig.json`, plus relevant `bunx biome check <path>` and `bunx vitest run <test>`.

## Node-daemon TDZ closures
- Adjudicate `closure over a later-declared let` in `packages/sage/src/project-server.ts` only when a synchronous module-evaluation path invokes the closure; event-loop callbacks (`net` server `'connection'`, timers, IPC) cannot interleave with synchronous module-body execution.
- Treat `createSlowOperationReporter(() => ({ pendingRequests, clients: clients.size }))` and `createHygieneRunner` `isBusy` as intentional startup-safe forward closures; construct-time TDZ would crash daemon startup and fail `packages/sage/tests/project-server-maintenance.test.ts` — prove with `bunx vitest run packages/sage/tests/project-server-maintenance.test.ts`.
