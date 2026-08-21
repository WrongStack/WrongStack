# Finding: TODO/FIXME/HACK debt across source

**Severity:** Low
**Category:** Maintainability / Technical debt

## Description

At least 39 source files under `packages/**/src` contain `TODO`, `FIXME`, or `HACK` markers. Individually harmless, but several files accumulate multiple markers (up to 9 in one plugin), suggesting unfinished work that is not tracked on any board. Untracked TODOs rot: they reference conditions that may no longer hold and hide real defects.

## Evidence

Verified via ripgrep count of pattern `TODO|FIXME|HACK` over `packages/**/src/**/*.ts` — 39 matching files. Highest-density files:

| File | Count |
|---|---|
| `packages/plugins/src/auto-doc/index.ts` | 9 |
| `packages/webui-server/src/server/skills-handlers.ts` | 5 |
| `packages/core/src/agent-status-helpers.ts` | 5 |
| `packages/core/src/core/agent-response.ts` | 5 |
| `packages/cli/src/services/project-facts.ts` | 2 |
| `packages/core/src/security/capabilities.ts` | 2 |
| `packages/tui/src/hooks/use-todos-auto-clear.ts` | 2 |
| …and 32 more files with 1–2 markers each | |

## Proposed remediation

1. Triage the markers: convert each actionable one into a Kanban card or tracked issue; delete stale ones that no longer apply.
2. Prioritize `packages/core/src/security/capabilities.ts` (security-adjacent TODOs deserve immediate tracking).
3. Enforce going forward: a CI check that fails on new `FIXME`/`HACK` markers in `packages/*/src` unless the marker carries a ticket reference (e.g. `TODO(WS-123):`), matching the repo's existing `architecture/` governance style.
