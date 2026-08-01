# Release Process

WrongStack's root manifest provides a full release command, a dry-run command,
and a narrow plugin invariant suite. The intended publication path is
`.github/workflows/release.yml` — tag-triggered, environment-gated, publishing
with npm trusted publishing (OIDC). Local `pnpm release` remains available as a
fallback.

## Publishing from CI (the intended path) — WS-040

Push a tag matching the root manifest version:

```bash
git tag v0.298.0 && git push origin v0.298.0
```

That does **not** publish. It requests a publish: the workflow's `publish` job
targets the `npm-publish` GitHub Environment, so a required reviewer must
approve before anything reaches the registry. Before that, a `verify` job
proves the tag matches `package.json`, that it is an ancestor of `origin/main`,
and that the full `release:check` gate passes.

**Why this replaced a laptop publish.** The old path used a long-lived npm
automation token in a maintainer's environment — a credential that publishes
any package in the org, sitting on a machine that also runs every dependency's
postinstall script. CI uses a short-lived OIDC token minted per run and scoped
to this repository and this workflow file. npm also attaches a provenance
attestation automatically, so a consumer can verify which commit and workflow
produced a tarball. The `--provenance` flag is not needed and pnpm has no such
flag — provenance comes from the trusted-publishing exchange itself.

### One-time setup (the workflow fails until this is done)

1. **Per package on npmjs.com.** Trust is bound per package, not per org:
   register the trusted publisher (repository, workflow `release.yml`,
   environment `npm-publish`) on each one. There are 27:

   ```bash
   pnpm release:packages
   ```

   A package without a registered publisher fails with a bare `404` from the
   registry. That is npm rejecting an unknown publisher, not a bug in the
   workflow.

2. **GitHub → Settings → Environments → `npm-publish`**, with required
   reviewers. This is the control that keeps a tag push from shipping on its
   own; removing it silently converts tag-push into publish.

### Known drift to fix during setup

`pnpm release:packages` flags two things worth resolving:

- `@wrongstack/governance` and `@wrongstack/techstack` declare
  `publishConfig.provenance: true`. Provenance requires a CI OIDC context, so
  those two cannot be published from a laptop at all. Under trusted publishing
  the field is redundant — provenance is emitted regardless.
- `@wrongstack/plugins` and `@wrongstack/webui-hq` have no
  `publishConfig.access`. Not fatal (the command passes `--access public`), but
  they are the odd ones out.

### `--no-git-checks`

Removed from `pnpm release` (local), retained in `pnpm release:ci`.

This is not an oversight. On a laptop the flag is the dangerous one: it removes
pnpm's refusal to publish from a dirty tree or the wrong branch, so the
published tarball need not correspond to any commit. In CI a tag checkout is a
**detached HEAD**, so pnpm's "are you on the publish branch" check cannot pass
by construction — leaving it enabled would fail every release rather than
protect one. What it guarded is replaced more strictly by the `verify` job
(tag matches the manifest, tag is an ancestor of `main`) and by the fresh
checkout, which makes tree cleanliness a property rather than an assertion.

### pnpm version floor

OIDC publishing is broken in pnpm 11.0.8 ([pnpm#11513](https://github.com/pnpm/pnpm/issues/11513),
fixed by [pnpm#11526](https://github.com/pnpm/pnpm/pull/11526)) and works from
**11.1.3**. The workflow checks the `packageManager` pin against that floor and
fails loudly, because the failure mode otherwise is a confusing 404 rather than
an obvious version error.

The workflow also deliberately omits `registry-url` from `actions/setup-node`:
that option writes an `.npmrc` containing `_authToken=${NODE_AUTH_TOKEN}`
unconditionally, and with no token in the environment pnpm sends the literal
unexpanded placeholder as a bearer token, so the OIDC exchange never happens.

## Full gate — `release:check`

A broad correctness sweep run before anything goes to npm:

```bash
pnpm release:check
# ↪ pnpm audit --audit-level=moderate
#   pnpm build
#   node scripts/check-package-contracts.mjs
#   pnpm check:node-pty
#   pnpm lint:i18n
#   pnpm typecheck
#   pnpm test
```

**What it catches**: moderate-or-higher dependency audit findings (subject to the checked-in audit policy), build/type/test failures, package export/file contract drift, an unusable optional `node-pty`, and incomplete WebUI translations. Full `pnpm lint` and browser smoke are not part of this script.

**Caveat**: it runs the *full* vitest suite. A single broken
test anywhere in the monorepo blocks the release. That's by
design — we don't ship if anything is red.

## Narrow plugin guard — `prepublishOnly` / `test:guard`

The root manifest maps `prepublishOnly` to `pnpm test:guard`. It is useful when the root package lifecycle is invoked or when run explicitly, but it must not be described as a guaranteed hook for every recursively published child package: the public workspace package manifests do not each declare it. The full `pnpm release:check` remains the actual repository-wide gate.

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
| `packages/plugins/tests/plugin-teardown.test.ts` | Lifecycle expectations are checked across the 63 entries in `PLUGIN_CATALOG`. |
| `packages/plugins/tests/smoke.test.ts` | All 8 historic plugin files (the original 8 from the pre-catalog era) must still import and register. Catches broken barrel exports. |

**Why a separate script?** It gives maintainers focused feedback on catalog,
lifecycle, and barrel regressions. Avoid fixed timing claims: duration varies by
machine and the full suite is much larger than this three-file selection.

## When each layer runs

| Command | What runs |
|---------|-----------|
| `pnpm release` | `release:check`, then recursive public publish |
| `pnpm release:dry` | Recursive publish dry-run only; run `release:check` separately |
| `pnpm release:check` | Full repository release gate, no publication |
| `pnpm test:guard` / `pnpm prepublishOnly` | Three focused plugin tests only |
| `pnpm test` | Root Vitest suite, then the WebUI package test script |
| Tag push | No npm release action in the current repository |

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

## Why keep the focused guard

| Concern | `release:check` | `test:guard` |
|---------|-----------------|--------------|
| Type/build/audit/package-contract/i18n failures | ✅ | ❌ |
| Full test suite | ✅ | ❌ |
| Focused catalog/lifecycle/barrel feedback | Covered by full tests | ✅ |
| Guaranteed for each recursively published child | N/A | ❌ — child manifests do not declare this hook |

Do not bypass `pnpm release` on the assumption that a recursive publish will
run the root hook. For dry runs, use `pnpm release:check && pnpm release:dry`.
For a real release, `pnpm release` encodes the required ordering.

## Cross-references

- [`packages/plugins/src/catalog.ts`](../packages/plugins/src/catalog.ts) — what the catalog test guards
- [`docs/feature-matrix.md`](feature-matrix.md) — the 63 plugins the H1 teardown test covers
- [`packages/plugins/README.md`](../packages/plugins/README.md) — the plugin contract
- [`../RELEASE.md`](../RELEASE.md) — maintainer checklist, version bump, tagging, publication, and current automation status
- [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) — website deployment only; not an npm release workflow
