# PR-00 — Clean Baseline and Ownership Window

**Labels**  
`p0` `baseline` `coordination` `architecture` `release`

## Status

- **Captured:** 2026-07-10
- **Source ref:** `ade511b832f990e4e282b79758757b44a0bada70`
- **Baseline branch:** `chore/pr-00-clean-baseline`
- **Isolated worktree:** `.worktrees/pr-00-clean-baseline`
- **Source changes in this PR:** none; documentation only

## Purpose

Freeze a reproducible starting point for the P0/P1 refactor program without
stashing, restoring, committing, or otherwise taking ownership of changes in the
shared `main` worktree.

The baseline separates:

1. failures already present at the frozen source ref,
2. failures caused by an earlier failed prerequisite,
3. incomplete checks that exceeded the execution budget, and
4. regressions introduced by later refactor PRs.

## Isolation Result

The isolated worktree was created directly from the frozen source ref and was
clean before baseline commands were run:

```text
## chore/pr-00-clean-baseline
```

At capture time the shared `main` worktree contained **37 unstaged tracked-file
changes** and no untracked files. Those files were deliberately left untouched.
The mailbox/fleet registry reported no other live agent, but offline ownership
could not be inferred safely; therefore no shared-tree change was treated as
abandoned.

Dependencies were installed with lifecycle scripts disabled:

```text
pnpm install --frozen-lockfile --ignore-scripts
```

This avoids the root `postinstall` mutating Git hook configuration while taking
the baseline. Installation passed, while independently reporting the existing
`core <-> sdd` workspace dependency cycle. Missing bin-link warnings before a
first build were expected because publishable `dist/` entries do not yet exist
on a clean checkout.

## Baseline Gate Matrix

| Gate | Result | Classification | Evidence |
|---|---|---|---|
| Frozen install | PASS with warnings | Existing architecture debt | pnpm reported cyclic workspace dependencies between `packages/core` and `packages/sdd` |
| Dependency audit | PASS | Clean | `pnpm audit --audit-level=low`: no known vulnerabilities |
| Root build | FAIL | Existing P0 build-order defect | `@wrongstack/core` DTS build could not resolve `@wrongstack/kanban` |
| Workspace typecheck | FAIL | Blocked by build-order defect | core could not resolve the unbuilt kanban declarations; resulting callback parameters became implicit `any` |
| Lint | FAIL | Existing quality-gate defect | 1 error, 104 warnings, 19 infos |
| Full root + WebUI tests | INCOMPLETE | Execution-budget limit | full run exceeded 20 minutes; two root shards and WebUI run each exceeded 15 minutes |
| Focused WebSocket reconnect test | PASS | Clean | 4/4 tests passed |
| Focused ACP server-agent test | PASS | Clean | 13/13 tests passed |
| Focused HQ WS-client test | PASS | Clean | 18/18 tests passed |
| Hotspot architecture guard | FAIL | Existing architecture debt | `App.tsx` and `SettingsPanel/index.tsx` exceed committed caps |
| CLI package smoke | BLOCKED | Downstream of root build failure | CLI `dist/index.js` was never produced because root build stopped in core |
| HQ asset build | PASS after prerequisites | Build-order diagnosis | passes after `kanban -> core -> tools`; direct clean attempt cannot resolve `@wrongstack/tools/tool-icons` |
| HQ manifest/build parity | FAIL | Existing package-contract defect | build emits `dist/index.html`; manifest targets `dist/index.js` and `dist/index.d.ts`, neither exists |

## Confirmed Root Causes

### 1. Root build forces core before a real dependency

`scripts/build.mjs` detects the workspace cycle and force-prepends core. Core,
however, has a runtime/package dependency on `@wrongstack/kanban`. On a clean
checkout kanban declarations do not exist yet, so core's DTS build fails:

```text
src/coordination/director-tools.ts: TS2307
Cannot find module '@wrongstack/kanban'
```

The diagnostic sequence below passed completely:

```text
pnpm --filter @wrongstack/kanban build
pnpm --filter @wrongstack/core build
pnpm --filter @wrongstack/tools build
pnpm --filter @wrongstack/webui-hq build
```

This proves the immediate clean-build failure is dependency ordering, not an
independent compile error in those four packages. It also confirms that the
cycle workaround is unsafe on an empty `dist/` tree.

### 2. Lint is independently red

The blocking lint error is:

```text
packages/webui/tests/components/file-explorer.test.tsx:2
lint/style/useImportType
```

Warnings are baseline debt, not permission to introduce new warnings. PR-01
must remove the blocker and keep touched files warning-neutral.

### 3. Hotspot guardrails are independently red

```text
packages/webui/src/App.tsx                         1261 / 1250
packages/webui/src/components/SettingsPanel/index.tsx 1451 / 1450
```

The caps must not be raised. PR-01 restores the guard by extracting behavior-
preserving modules.

### 4. HQ package metadata does not describe its actual artifact

After a successful prerequisite-ordered build:

```text
packages/webui-hq/dist/index.html  = present
packages/webui-hq/dist/index.js    = absent
packages/webui-hq/dist/index.d.ts  = absent
```

PR-06 owns the decision and fix: either declare the package asset-only, or add a
real library build. The two contracts must not be mixed.

## Ownership Window

Every implementation PR starts from a clean worktree. A file may have only one
active owner at a time. Cross-cutting files (`pnpm-lock.yaml`, root
`package.json`, `scripts/build.mjs`) require an explicit mailbox handoff before
editing.

| Workstream | Exclusive primary files/directories during its window |
|---|---|
| PR-01 quality gates | `packages/webui/src/App.tsx`, `packages/webui/src/components/SettingsPanel/**`, new WebUI extraction modules, blocking lint test |
| PR-02 WS lifecycle | `packages/webui/src/lib/ws-client.ts`, `packages/webui/src/hooks/useWebSocket.ts`, reconnect tests |
| PR-03 HTTP auth | `packages/webui-server/src/server/http-server.ts`, focused HTTP auth tests |
| PR-04 TUI signals | `packages/tui/src/run-tui.ts`, focused child-process signal tests |
| PR-05 scanner cancellation | `packages/security-scanner/src/orchestrator.ts`, focused scanner tests |
| PR-06 HQ package contract | `packages/webui-hq/package.json`, `packages/webui-hq/README.md`, HQ package-contract tests |
| PR-08 scanner edge | `packages/core/package.json`, scanner/core graph assertion, lockfile window |
| PR-09 tasking extraction | `packages/core/src/tasking/**`, SDD tracker/store compatibility exports |
| PR-10 Goal edge removal | core Goal builder/orchestrator, core manifest, lockfile window |
| PR-11 DAG enforcement | `scripts/build.mjs`, workspace graph architecture tests and architecture docs |

### Ownership rules

1. Announce the branch, worktree, task, and primary files before editing.
2. Read `git status` before every commit and stage only files owned by the PR.
3. Do not absorb pre-existing shared-tree changes into a refactor commit.
4. Do not mix behavior fixes with structural moves.
5. Keep each PR independently revertible; compatibility re-exports land before
   consumer migration.
6. Rebase onto the accepted PR-00 commit before implementation, then rerun the
   narrow baseline relevant to the workstream.
7. A red baseline may only improve. Any new failure or increased diagnostic
   count blocks the PR.

## Required Per-PR Evidence

Every P0/P1 PR description must include:

- source and final SHA,
- owned files,
- pre-existing relevant baseline failures,
- focused tests before/after,
- package typecheck/build result,
- `git status --short`, and
- rollback boundary (commit or PR).

## Exit Criteria

PR-00 is complete when:

- [x] a clean isolated worktree exists at a frozen SHA,
- [x] dependency installation is reproducible without lifecycle side effects,
- [x] audit/build/typecheck/lint/test/package results are classified,
- [x] build-order failure is separated from independent source failures,
- [x] ownership windows are explicit,
- [x] the shared dirty worktree remains untouched, and
- [x] this baseline record is committed on its dedicated branch.

The full test suite remains **incomplete**, not passing. PR-15 must repeat it in
a clean release-verification environment after P0/P1 fixes land.

## PR-10 — Deferral and Inventory (attempted 2026-07-10)

Attempted on `refactor/pr-10-core-goal-edge` from `351744e4` baseline.
PR-10 cannot be applied in a single independently-revertible PR from the
current session because it requires touching the same files the live peer
workstream owns. Inventory captured for the next session:

### Core `createRequire('@wrongstack/sdd')` call sites (2)

- `packages/core/src/goal/phase-graph-builder.ts:14-18` — used at
  `:64-66` to materialise `DefaultTaskStore` + `TaskTracker` and call
  `tracker.createGraph`.
- `packages/core/src/goal/phase-orchestrator.ts:17-21` — used at
  `:793-797` to materialise the per-phase tracker via
  `getTrackerForPhase(phase)`.

### Production consumers (3 sites, 2 packages)

- `packages/core/src/goal/auto-phase-runner.ts:96-130` — instantiates
  both `PhaseGraphBuilder` and `PhaseOrchestrator` directly inside core.
- `packages/cli/src/goal-host.ts:516,557,715` — three sites build and
  run Goal phases (interactive/verify/conflict-resolution paths).
  **Peer-owned worktree at capture time.**
- `packages/webui-server/src/server/goal-ws-handler.ts:268,310` — one
  build + one orchestrator for the HQ interactive run. **Peer-owned
  worktree at capture time.**

### Test consumers (5)

- `packages/core/tests/goal/phase-store.test.ts` (3 sites)
- `packages/core/tests/goal/phase-orchestrator.test.ts` (11 sites)
- `packages/core/tests/goal/phase-orchestrator-extra.test.ts` (2 sites)
- `packages/core/tests/goal/phase-graph-builder.test.ts` (3 sites)
- `packages/core/tests/goal/checkpoint.test.ts` (1 site)

### Required design

`PhaseOrchestratorOptions` and `PhaseGraphBuilderOptions` need an optional
`trackerFactory?: () => { store: TaskStore; TaskTracker: TaskGraphTracker }`
(plus `storeFactory?` for cases where the test wants a custom store without
a tracker). The default factory uses an in-core in-memory implementation
that mirrors `DefaultTaskStore`'s API and a `TaskTracker` that operates on
the in-memory store. Consumers in `cli` and `webui-server` keep importing
`DefaultTaskStore` + `TaskTracker` from `@wrongstack/sdd` and pass a
factory that wires them in. This keeps the core contract independent of
SDD at the type level while preserving every existing call site behaviour.

### Conflict with the PR-00 ownership window

`cli/src/goal-host.ts` and `webui-server/src/server/goal-ws-handler.ts`
are listed in the shared main worktree as modified by active peer work
(38 unstaged files at capture time). Touching them in the same commit as
the core change would either absorb that peer work or fail the
corruption guard. The session is therefore stopping at this decision
record; PR-10 becomes the first concrete refactor of the next session,
coordinated with whatever peer branches land first.

### Hardening companion test (mirrors PR-08)

Add to `packages/core/tests/architecture/package-boundaries.test.ts`:

```ts
describe('P0/P1 manifest regression (PR-10)', () => {
  it('core does not declare @wrongstack/sdd in package.json', async () => {
    // identical pattern to the PR-08 scanner regression
  });
});
```

This test cannot be added in this session because the manifest still
declares the edge; the assertion is staged in the plan and will be
written together with the core source change.

