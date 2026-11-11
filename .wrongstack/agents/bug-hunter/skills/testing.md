## Testing Addendum

### Commands
- External-plugin trust gate: `bun --bun run vitest run packages/core/tests/plugin/trust.test.ts packages/cli/tests/plugin-closure-hash.test.ts packages/runtime/tests/external-ts-plugin-reload.test.ts`; covers digest format, pin/verify parity across access shapes, and sibling-helper tampering; do not run repo-wide suite when these pass.
- Core goal: `bun --bun run vitest run packages/core/tests/goal`; typecheck `packages/core/tsconfig.json`; Biome changed core sources/tests.
- Goal WS/run-control: `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/webui/tsconfig.json`; `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/webui-server/tsconfig.json`; `bunx biome check packages/webui/src/hooks/ws-handlers/goal-handlers.ts packages/webui-server/src/server/goal-ws-run-controls.ts`; `bun --bun run vitest run packages/webui-server/tests/goal-ws-handler.test.ts packages/webui-server/tests/goal-handlers.test.ts packages/webui-server/tests/goal-multiple-runs.integration.test.ts`; `bun --bun run vitest run packages/webui/tests/hooks/ws-handlers-misc-goal.test.ts packages/webui/tests/components/goal-view.test.tsx`.
- CLI teardown wiring: `bun --bun run vitest run packages/cli/tests/dep-watcher-wiring.test.ts packages/cli/tests/tech-stack-audit-session-end.test.ts packages/cli/tests/tech-stack-audit-survives-teardown.test.ts`.

### Checks & Pitfalls
- Before interpreting failures, confirm pin provenance with `git status --short` and `git log --oneline -- <file>`; preserve committed contracts and do not treat untracked pins as intended behavior.
- Goal WS controls: verify acquire-vs-stop races: post-await stopping checks, local-lease cleanup, and stop persistence based on entry-time `startInFlight`.
- Goal handlers: verify `acceptsGoal` accepts keyless `goal.error` and `goal.stopped`, including without a graph.
- Dep watcher: register teardown synchronously before `multiAgentHost.spawn()` awaits; test late director availability and `withDirector: false`; avoid `.then`-based registration that can miss teardown.
