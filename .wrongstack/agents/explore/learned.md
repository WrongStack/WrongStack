# Learned instructions for `explore`

> Project-specific learning data for the `explore` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-10-01T16:53:06.703Z; skill=codebase-navigation; applied=4; wins=4; skipped=7; skippedWins=7 -->
- **For existence/enumeration inside gitignored `.temp_files/` and `.wrongstack/`, never rely on the `glob` tool — it silently honors gitignore and returns zero results even when thousands of files live there (observed: `.temp_files/**` glob returned 0 while tree showed 4212 files / 822 dirs). Use `read` for exact-path existence checks (read bypasses ignore rules and returns a real ENOENT) and `tree` with a name `glob` filter (`tree path=".temp_files" glob="*name*"`) for existence sweeps across the ignored subtree. The repo-wide `grep` baseline (rg also respects gitignore for content but still searches all *tracked* files) remains the right tracer for cross-cutting consumers of an ignored helper.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `.temp_files/`
  - *How:* `.wrongstack/`
  - *How:* `glob`
  - *How:* `.temp_files/**`
  - *How:* `read`
  - *How:* `tree`
  - *How:* `tree path=".temp_files" glob="*name*"`
  - *How:* `grep`

<!-- learned-stamp: category=warning; capturedAt=2026-10-01T16:49:57.703Z; skill=codebase-navigation; applied=8; wins=8; skipped=4; skippedWins=4 -->
- **Treat `\.temp_files/` exactly like `.wrongstack/` when tracing: `codebase-search`/`codebase-context` never cover it, so empty results there prove nothing. The reliable method is one repo-wide `files_with_matches` grep for the script basename — an untruncated zero-match result proves the helper has no tracked consumers (no npm script, CI, or sibling helper), so its edit/delete blast radius is manual-invocation-only. Note in such scripts that top-level side-effect `.mjs` helpers export nothing, so `codebase-incoming-calls`/`outgoing-calls` have no symbols to query — the basename grep plus a single `read` is the complete answer.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `\.temp_files/`
  - *How:* `.wrongstack/`
  - *How:* `codebase-search`
  - *How:* `codebase-context`
  - *How:* `files_with_matches`
  - *How:* `.mjs`
  - *How:* `codebase-incoming-calls`
  - *How:* `outgoing-calls`
  - *How:* `read`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-10-01T16:10:44.060Z; skill=codebase-navigation; applied=1; wins=1; skipped=16; skippedWins=16 -->
- **Before attributing callers of `collectConnectionsHealth` or any `*Health` connection-check symbol, grep repo-wide for the symbol name — `packages/tui/src/connections-health.ts:73` defines a twin `collectConnectionsHealth` (with same-named `sessionCatalogHealth`/`chronicleHealth`/etc. helpers at L77–82) independent of `packages/webui-server/src/server/connections/collector.ts`; every tui hit (connections-panel, use-sidebar-panel-data, tui tests) belongs to the twin. In `packages/webui-server/src/server/connections/`, collector's public surface is double-re-exported (`connections/index.ts:1` and `connections-health-route.ts:7`) — trace consumers via `connections-health-route(\.js)?['"]`, and remember sibling `./collector.js` imports need their own grep since path-specifier patterns miss them.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `collectConnectionsHealth`
  - *How:* `*Health`
  - *How:* `packages/tui/src/connections-health.ts:73`
  - *How:* `sessionCatalogHealth`
  - *How:* `chronicleHealth`
  - *How:* `packages/webui-server/src/server/connections/collector.ts`
  - *How:* `packages/webui-server/src/server/connections/`
  - *How:* `connections/index.ts:1`
  - *How:* `connections-health-route.ts:7`
  - *How:* `connections-health-route(\.js)?['"]`
  - *How:* `./collector.js`
  - *How:* `packages/tui/src/connections-health.ts`
  - *How:* `connections/index.ts`

---
*Last capture: 2026-10-01T16:53:06.703Z · 3 entries*
