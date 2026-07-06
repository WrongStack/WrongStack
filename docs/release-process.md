# Release Process

WrongStack uses a **two-layer guard** before any package is
published. Both layers are wired into `pnpm release` (which is
the only sanctioned way to publish) so a guard failure blocks
the release.

## Layer 1 — `release:check`

A broad correctness sweep run before anything goes to npm:

```bash
pnpm release:check
# ↪ pnpm audit --audit-level=moderate
#   pnpm typecheck       # tsc --noEmit across all packages
#   pnpm build           # tsup builds
#   pnpm test            # full vitest run
```

**What it catches**: type errors, build failures, audit warnings
above moderate, and any test failure in any package.

**Caveat**: it runs the *full* vitest suite. A single broken
test anywhere in the monorepo blocks the release. That's by
design — we don't ship if anything is red.

## Layer 2 — `prepublishOnly`

A narrow correctness sweep that npm runs **automatically** before
`pnpm publish` (or `pnpm release` which calls publish):

```bash
pnpm prepublishOnly
# ↪ pnpm test:guard
#   ↪ vitest run packages/plugins/tests/catalog.test.ts
#           packages/plugins/tests/plugin-teardown.test.ts
#           packages/plugins/tests/smoke.test.ts
```

**What it guards**:

| File | Why it matters |
|------|-----------------|
| `packages/plugins/tests/catalog.test.ts` | The plugin catalog must list every plugin exported from `src/index.ts`. A mismatch means `spec-linker` (or any other consumer) will be stale on day one. |
| `packages/plugins/tests/plugin-teardown.test.ts` | The H1 audit pattern (every plugin implements `teardown` + `health`) must hold across the **63** plugins. A regression means a plugin can leak timers, watchers, or file handles across hot-reload. |
| `packages/plugins/tests/smoke.test.ts` | All 8 historic plugin files (the original 8 from the pre-catalog era) must still import and register. Catches broken barrel exports. |

**Why a separate script?** Running only the guards (≈2 seconds
instead of ≈8 seconds for the full suite) lets CI flag the most
common release-blocking regressions — stale catalog, missing
teardown, broken barrel — quickly, without paying the full test
cost on every publish.

## When each layer runs

| Command | Layer 1 (`release:check`) | Layer 2 (`prepublishOnly`) |
|---------|---------------------------|---------------------------|
| `pnpm release` | ✅ | ✅ (npm/pnpm automatic) |
| `pnpm release:dry` | ❌ | ✅ (publish --dry-run still runs prepublishOnly) |
| `pnpm release:check` alone | ✅ | ❌ (use this if you want to inspect without publishing) |
| `pnpm test:guard` alone | ❌ | ❌ (use this for fast feedback during plugin development) |
| `pnpm test` alone | ❌ | ❌ (full vitest, not a release gate) |
| **CI tag push** (`.github/workflows/release.yml`) | ✅ (explicit step) | ✅ (explicit step + automatic on `pnpm release`) |
| **CI manual dispatch** (`workflow_dispatch`) | ✅ if `dry_run=false` | ✅ if `dry_run=false` (skipped on `dry_run=true`) |

## Adding a new guard

When the catalog grows (e.g. a new invariants test, a new
contract test) the guard list in `package.json` should be
extended:

```jsonc
{
  "scripts": {
    "test:guard": "vitest run packages/plugins/tests/catalog.test.ts packages/plugins/tests/plugin-teardown.test.ts packages/plugins/tests/smoke.test.ts packages/plugins/tests/<new-guard>.test.ts"
  }
}
```

The pattern: a guard test is **fast** (sub-second each), **specific**
(catches one well-defined class of regression), and **independent**
(doesn't depend on the plugin lifecycle state). The three
existing guards — catalog, H1 teardown, smoke — are the
baseline; new ones should match the same shape.

> The H1 teardown test enumerates every entry in
> `packages/plugins/src/catalog.ts`. The catalog itself enforces
> kebab-case names + uniqueness at module load, so any future plugin
> added to the index must also be added to the catalog — the
> `plugin-teardown.test.ts` guard catches a drift between the two.

## Why two layers and not one

| Concern | Layer 1 | Layer 2 |
|---------|---------|---------|
| Type errors | ✅ | (redundant) |
| Build failures | ✅ | (redundant) |
| Audit warnings | ✅ | (redundant) |
| Any test failure | ✅ | (redundant — 90% overlap) |
| **Fast catalog/H1 invariant feedback** | ❌ (slow — 8s) | ✅ (2s) |
| **Survives `pnpm publish` without `release:check`** (e.g. `pnpm publish -r` direct call) | ❌ | ✅ |

Layer 2 is the **safety net** for the case where someone bypasses
`pnpm release` and runs `pnpm publish` directly (e.g. to publish
a single package in a hurry). Without Layer 2, the catalog could
drift silently. With Layer 2, the guard fires regardless of how
publish was invoked.

## Cross-references

- [`packages/plugins/src/catalog.ts`](../packages/plugins/src/catalog.ts) — what the catalog test guards
- [`docs/feature-matrix.md`](feature-matrix.md) — the 63 plugins the H1 teardown test covers
- [`packages/plugins/README.md`](../packages/plugins/README.md) — the plugin contract
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — the CI workflow that runs both layers on tag push and (optionally) on manual dispatch
