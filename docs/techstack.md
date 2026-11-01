# Technology stack

Workspace manifests and the lockfile define the installed stack. The
[source-derived catalog](current-catalog.md#workspace-packages) lists every
package and application. July registry comparisons are preserved in
[the historical stack report](archive/reports/techstack-2026-07-15.md).

| Area | Source of truth | Implementation |
|---|---|---|
| Runtime and package manager | [`package.json`](../package.json), [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) | Node floor, Bun pin, overrides and install policy |
| TypeScript and build | [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/build-package.mjs`](../scripts/build-package.mjs) | esbuild and declaration emit; `typescript5` is the legacy compiler-API alias |
| Terminal | [`packages/tui/package.json`](../packages/tui/package.json) | React and Ink |
| Browser apps | [`packages/webui/package.json`](../packages/webui/package.json), [`packages/hq-next/package.json`](../packages/hq-next/package.json) | React clients (Vite WebUI, Next.js HQ); `@wrongstack/webui-protocol` owns wire contracts |
| Browser server | [`packages/webui-server/package.json`](../packages/webui-server/package.json) | Node HTTP/WebSocket host over the common runtime |
| Persistence | [`packages/persistence/package.json`](../packages/persistence/package.json) | SQLite/file primitives with domain-specific project owners |
| Tests and checks | [`package.json`](../package.json) | Vitest, Playwright, TypeScript and Biome; separate coverage ratchets |
| Standalone build | [`scripts/build-binaries.mjs`](../scripts/build-binaries.mjs) | Bun executables with explicit assets and daemon dispatch |

Use `bun run build`, `bun run typecheck:only`, and scoped package tests for
development. [Release process](release-process.md) describes the full matrix.
A documentation check does not certify a release.

The `techstack` tool and `/techstack` analyze the user's project. See
[the command](slash/techstack.md) and
[`packages/techstack/src/index.ts`](../packages/techstack/src/index.ts) for discovery,
registry/advisory enrichment, jobs and snapshots.
