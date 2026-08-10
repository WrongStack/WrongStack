# Audit Report 09: Local Build Validation and GitHub Workflows

**Files:** `.github/workflows/ci.yml`, `package.json`, `vitest.config.ts`, `scripts/`
**Date:** 2026-08-10
**Auditor:** Deep investigation (solo)

---

## Summary

WrongStack does not use GitHub CI as an acceptance or release gate; builds and releases are operated manually and validated locally. GitHub Pages publishing is the only operationally required Actions path. The other workflow files are retained repository automation, not evidence of the project's actual release contract.

---

## Findings

### B-01: No Windows GitHub CI job (Rejected as a defect)

**File:** `.github/workflows/ci.yml` — all jobs use `runs-on: ubuntu-latest`

WrongStack ships extensive Windows-specific code:
- `packages/persistence/src/atomic-write.ts:353-375` — `renameWithRetry()` with Windows-specific EPERM/EBUSY/EACCES/ENOTEMPTY retry codes and exponential backoff
- `packages/mcp/src/client.ts:626-630` — `forceKillTree(child)` using `taskkill /T /F` on Windows
- `packages/core/src/security/file-permissions.ts` — POSIX mode bits no-op on `win32`
- `packages/core/src/security/secret-vault.ts:154` — `checkKeyFilePermissions()` returns early on Windows
- `packages/plugins/src/path-guard/index.ts:154-178` — `normalizePath()` with Windows drive letter handling
- `packages/tools/src/codebase-index/indexer.ts:93` — `normalizeComparablePath()` lowercases on Windows

These paths need Windows runtime validation, but that validation does not need to run on GitHub-hosted CI.

**Disposition (2026-08-10):** The audit was running in the project's real Windows development environment and exercised the affected packages locally, including real MCP subprocess lifecycle fixtures. A temporary `test-windows` workflow added by the audit was removed after confirming that GitHub CI is outside the project's operating model. Local package/typecheck matrices remain the acceptance evidence.

### B-03: Vitest forks pool missing `restoreMocks` (Low — known)

**File:** `vitest.config.ts`

Root config does not set `restoreMocks`/`clearMocks`/`mockReset`. In Vitest 4, `vi.spyOn` on globals (e.g., `Math.random`, `console.warn`) persists for the rest of the file. Two consequences:

1. A test that depends on a pinned global must pin it itself — `afterEach` cleanup is not automatic.
2. `vi.spyOn(Math, 'random').mockReturnValue(0.5)` in test N silently makes test N+1 deterministic, masking flakiness.

The configuration omission is confirmed by source inspection; cross-test pollution was not reproduced during this audit. Adding `clearMocks: true, restoreMocks: true` requires auditing tests that may rely on the current behavior.

**Resolution (2026-08-10):** Root Vitest config now enables `clearMocks` and `restoreMocks`. One process-global fixture that relied on module-scope spy lifetime was changed to reinstall its spies in `beforeEach`; focused tests and the full root suite pass with automatic restoration enabled.

### B-04: Release provenance claim was stale (Rejected)

**File:** `package.json:60` (`release:check`)

The `release:check` script runs 14 gates:
1. `pnpm audit --audit-level=moderate`
2. `pnpm build`
3. `pnpm providers:catalog:check`
4. `pnpm plugins:manifest:check`
5. `check-package-contracts.mjs`
6. `write:build-manifest`
7. `check:build-manifest`
8. `check:architecture`
9. `check:test-inventory`
10. `check:test-skips`
11. `check:test-types`
12. `check:node-pty`
13. `lint:i18n`
14. `typecheck` + `test:coverage`

The initial draft inferred release behavior from `release:check` alone. The production release workflow already grants `id-token: write` and uses npm trusted publishing through OIDC; npm attaches provenance for this flow. An SBOM remains an optional enhancement, but missing provenance is not a current defect.

### B-05: Build artifact manifest verification is well-designed (Positive)

**Files:** `scripts/check-build-lineage.mjs`, CI `build` job lines 119-152

The build pipeline uses a three-stage artifact verification:
1. **Assert clean lineage** (`check:clean-dist`) — verifies no stale dist files
2. **Write manifest** (`write:build-manifest`) — records expected artifacts
3. **Verify manifest** (`check:build-manifest`) — downloaded artifacts are checked against the manifest in downstream jobs

This prevents stale or corrupted build artifacts from propagating to test/e2e jobs. The `include-hidden-files: true` flag on upload is paired with a `check:dist-hidden` gate that asserts no dotfiles exist in dist output — a thoughtful security measure.

### B-06: CI concurrency cancellation may waste E2E runs (Info)

**File:** `.github/workflows/ci.yml:20-22`

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

A trivial doc-only push cancels an in-progress E2E run (which takes up to 15 minutes). This is efficient for fast feedback but can frustrate developers who need E2E validation. Not a bug — intentional trade-off documented by the comment.

### B-07: Vitest worker count is mode-sensitive and fixed (Positive)

**File:** `vitest.config.ts:76`

```typescript
maxWorkers: getVitestMaxWorkers(),
```

The worker count is selected from fixed repository defaults: 4 for explicit run mode and 2 for watch or implicit mode. It is not hardware-derived auto-tuning. The cap prevents spawn-heavy tests from competing with an unbounded number of Vitest workers.

---

## CI Pipeline Architecture

```
push/PR to main
  │
  ├─ lint (5 min) ──────────────────── Biome lint
  ├─ typecheck (15 min) ────────────── tsc + test-type ratchet
  ├─ build (15 min) ────────────────── esbuild + tsc declarations
  │   └─ upload verified artifacts
  │
  ├─ test (45 min) ← needs build ───── coverage ratchets + architecture
  ├─ e2e (15 min) ← needs build ────── Playwright
  └─ tui-smoke (10 min) ← needs build  Non-TTY exit code + ANSI check
```

All jobs use:
- Pinned SHA actions (no mutable tags)
- `persist-credentials: false` (WS-042)
- `--frozen-lockfile`
- Minimal permissions (`contents: read`)

---

## Summary Table

| ID | Severity | Finding | Fix effort |
|----|----------|---------|------------|
| B-01 | Rejected | No Windows GitHub CI despite Windows-specific code | Local Windows validation is the project contract |
| B-03 | Low | Vitest missing restoreMocks/clearMocks | **Resolved** |
| B-04 | Rejected | Release provenance missing | OIDC trusted publishing already provides provenance |
| B-05 | Positive | Build artifact lineage verification | — |
| B-06 | Info | Concurrency cancels in-progress E2E | Documented trade-off |
| B-07 | Positive | Fixed mode-sensitive Vitest worker cap | — |
