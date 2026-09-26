## Commands
- Before tracing any claimed type error by hand, run `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/<pkg>/tsconfig.json` (same as `-p packages/<pkg>`). Exit 0 instantly falsifies a claimed `TS2339 Property does not exist` in `packages/cli` or `packages/core`.

## Procedure
- When a Chimera review lists files under "Assumptions / unverified" as not-read, read those exact files FIRST — before dispatching or applying any fix. Findings whose suggested fix lives in an unread module (e.g. a hook the refactor moved logic into, such as `packages/simpleui/src/hooks/use-composer-state.ts`) are high-probability false positives already resolved on disk.
- Disprove a quoted-code claim with one direct read plus the typecheck above. Never patch text that a fresh read shows absent.

## Pitfalls
- In `packages/cli/src/wiring/*`, when a wiring function registers cleanup on an external `teardownHandlers` array, also fold that cleanup into its own returned `dispose()` behind an idempotence flag. Callers may drain the array, call `dispose()`, or both; early-return branches that omit `dispose` leave tracer/exporter handles unowned.
