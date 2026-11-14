# Release Process

WrongStack ships only through GitHub Releases. Pushing a `vX.Y.Z` tag makes
`.github/workflows/release.yml` build the GitHub Release (standalone binaries,
installers and checksums); that is the whole release.

## npm is retired

npm publishing is retired for good. Every workspace package is
`"private": true`, so `npm publish` / `bun publish` refuse in any package
directory; the root `prepublishOnly` hook fails with an explanation; the npm
publish scripts are deleted; and no workflow publishes to or reads from the
registry. The versions already on npm stay frozen as they are (no deprecation,
no unpublish). `bun run release` is an alias for `bun run release:check` and
publishes nothing.

## The tag (GitHub Release)

After `bun run release:check` passes on the committed release candidate and
`main` is pushed, push an annotated tag matching the root manifest version (the
full checklist is in [release.md](release.md)):

```bash
git tag -a v<version> -m '<version>' && git push origin v<version>
```

A `verify` job proves the tag matches `package.json` and is an ancestor of
`origin/main`, and pins that SHA. Every later job checks out the pinned SHA, so
a moved tag cannot change what is built.

## Standalone binaries (the primary distribution)

The same tag also builds one self-contained executable per platform — Bun
runtime, CLI, every project daemon, all surfaces and the package assets in a
single file — and publishes them as GitHub release assets. The
`github-release` job depends on the tag checks (`verify`) and the
binary jobs only. The full `release:check` runs as the separate `gate` job,
which nothing waits on — an unrelated red suite cannot hold a binary release
back, while every shipped binary still has to pass the cross-platform smoke.

| Job | What it does |
| --- | --- |
| `binaries` | `bun scripts/build-binaries.mjs` cross-compiles all targets on one Ubuntu runner, then `bun scripts/smoke-binary.mjs` runs the Linux x64 build |
| `binaries-smoke` | runs the same smoke on real Windows x64, Windows arm64 and macOS (arm64) runners |
| `github-release` | verifies manifest coverage and digests, then uploads `wstack-*`, `SHA256SUMS`, `install.sh`, `install.ps1` |
| `gate` | runs the full `release:check` as an independent signal; nothing waits on it |

Asset upload jobs resolve the release ID through `gh release view`, which
supports both drafts and published releases. A pre-existing draft stays a
draft while verified assets are attached; publish it after reviewing the
completed uploads. Reruns compare asset names and SHA-256 digests and skip
uploads that already match.

Targets: `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`,
`linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`.

Build and smoke locally (Bun required):

```bash
bun run build:binary                     # this machine's target only
bun scripts/smoke-binary.mjs            # smoke it
bun run build:binaries                   # every target → dist-bin/
```

How the binary differs from a source/workspace install at runtime — daemon dispatch,
project-script dispatch, the extracted asset tree, "am I main" guards — is
documented once in `packages/persistence/src/standalone-binary.ts`; the entry
that implements it is `scripts/binary/entry.mjs`. Two rules for new code:

- **Dynamic imports must use literal specifiers.** `import(variable)` is
  invisible to the bundler and silently missing from the binary.
- **Locate package files through the helpers** (`moduleDirFor`,
  `wrongstackPackageJsonPath`, `daemonSpawnArgs`, `cliSpawnArgs`,
  `scriptSpawnArgs`), never through `import.meta.url` or `process.argv[1]`
  directly. A new runtime asset directory also goes into `ASSETS` in
  `scripts/build-binaries.mjs`.

## Desktop updater signatures

Windows NSIS installers and macOS application archives carry Tauri updater
signatures. The application embeds `plugins.updater.pubkey` and sets
`requireSignedVersion: true`, so both package bytes and the announced version
must match the signature. These signatures do not provide Windows Authenticode
certificates or macOS notarization. Linux `.deb` and `.rpm` updates use the
release page and the system package manager.

The repository secret `TAURI_SIGNING_PRIVATE_KEY` holds the updater signing key.
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional for password-protected keys.
The reusable desktop workflow accepts these secrets explicitly; only the
Windows/macOS installer-build step receives them. Local installer builds without
the key still work, but do not emit updater payloads.

`scripts/desktop-updater.mjs` collects the signed artifacts without changing
their bytes. The release job checks every payload and its authenticated version
against the embedded public key, requires all four Windows/macOS targets, and
includes payloads, signatures and `latest.json` in `DESKTOP-SHA256SUMS`. It uploads
the discovery manifest last, after the artifacts it names. Artifact URLs name
the immutable release tag rather than `latest`.

The initial key's local recovery copy is
`%USERPROFILE%\.wrongstack\credentials\desktop-updater-key.dpapi`, with its public
key in `desktop-updater-key.pub` beside it. Windows DPAPI ties that encrypted copy
to the Windows account and machine that created it. Repository checkouts contain
only the public key. Preserve the existing signing identity when setting up a
different machine; a new key cannot update installations that trust the old one.

Version 1.7.1 is the bootstrap release containing this updater and public key:
users of published 1.7.0 installers install it manually (`wstack update`, then
`wstack desktop update`). Later releases
can update in place. Existing published tags and their installers are not rebuilt
or replaced to bootstrap the updater.

## Full gate — `release:check`

A broad correctness sweep run on the release commit before the tag is pushed:

```bash
bun run release:check
# ↪ bun scripts/audit-dependencies.mjs --audit-level=moderate
#   bun run build
#   bun scripts/check-tools-package-smoke.mjs
#   bun run check:dist-hidden
#   bun run providers:catalog:check
#   bun run website:tools:check
#   bun run plugins:manifest:check
#   bun scripts/check-package-contracts.mjs
#   bun run write:build-manifest
#   bun run check:build-manifest
#   bun run check:architecture
#   bun run check:test-inventory
#   bun run check:test-skips
#   bun run check:node-pty
#   bun run check:rulebook
#   bun run lint:i18n
#   bun run typecheck:only
#   bun run check:test-types
#   bun run test:coverage
```

The matrix is defined in `scripts/release-check-matrix.mjs`. Its release profile
has 19 gates, including the packed tools-package smoke, catalog/projection freshness,
architecture, test inventory/skips/types, build lineage and coverage ratchets.
Full `bun run lint` and browser smoke are separate. `ci:local` and `release:fast`
use different profiles; neither is the full release profile.

Coverage executes its configured test areas; a failed or skipped prerequisite
prevents certification. Report a full pass only after the final process exits 0
with `0 failed · 0 skipped · 19 passed`. Per-gate evidence is written under
`.reports/release-check-matrix/`. Focused tests or old logs do not certify the
current checkout.

## Narrow plugin guard — `test:guard`

`test:guard` runs three focused plugin tests. It is an explicit command only:
the root `prepublishOnly` hook no longer runs it — that hook now always fails,
because nothing in this repository may be published to npm. The full
`bun run release:check` remains the actual repository-wide gate.

```bash
bun run test:guard
# ↪ bun --bun run vitest run packages/plugins/tests/catalog.test.ts
#                            packages/plugins/tests/plugin-teardown.test.ts
#                            packages/plugins/tests/smoke.test.ts
```

**What it guards**:

| File | Why it matters |
|------|-----------------|
| `packages/plugins/tests/catalog.test.ts` | The plugin catalog must list every plugin exported from `src/index.ts`. A mismatch means `spec-linker` (or any other consumer) will be stale on day one. |
| `packages/plugins/tests/plugin-teardown.test.ts` | Lifecycle expectations are checked per plugin — the teardown of each plugin that owns timers, watchers or stores. |
| `packages/plugins/tests/smoke.test.ts` | All 8 historic plugin files (the original 8 from the pre-catalog era) must still import and register. Catches broken barrel exports. |

**Why a separate script?** It gives maintainers focused feedback on catalog,
lifecycle, and barrel regressions. Avoid fixed timing claims: duration varies by
machine and the full suite is much larger than this three-file selection.

## When each layer runs

| Command | What runs |
|---------|-----------|
| `bun run release` | Alias for `release:check`; publishes nothing |
| `bun run release:check` | Full repository release gate, no publication |
| `bun run test:guard` | Three focused plugin tests only |
| `prepublishOnly` (root) | Always fails: npm publishing is retired |
| `bun run test` | Root Vitest suite, then the WebUI package test script |
| Tag push (`v*.*.*`) | Verify the tag/SHA; build and smoke standalone assets; create the GitHub Release |
| Manual `CI` dispatch (`ci.yml`) | Run the repository CI jobs on the selected ref; pushes and pull requests do not start them |
| Manual `Dependency Audit` dispatch (`audit.yml`) | Run the configured dependency audit; there is no scheduled or push trigger |
| Manual `Deploy Website` dispatch (`pages.yml`) | Validate/build the website and deploy the selected ref to Pages |

Since 1.0.34, CI, dependency audit and Pages deployment use
`workflow_dispatch` only. Publishing a commit does not start those checks or
deploy the website. Dispatch them for the reviewed ref and inspect their final
results separately from the tag-triggered release workflow. Updating README,
changelog and website content prepares those surfaces; it does not establish
a GitHub release or a live deployment.

## Adding a new guard

When the catalog grows (e.g. a new invariants test, a new
contract test) the guard list in `package.json` should be
extended:

```jsonc
{
  "scripts": {
    "test:guard": "bun --bun run vitest run packages/plugins/tests/catalog.test.ts packages/plugins/tests/plugin-teardown.test.ts packages/plugins/tests/smoke.test.ts packages/plugins/tests/<new-guard>.test.ts"
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

## Cross-references

- [`packages/plugins/src/catalog.ts`](../packages/plugins/src/catalog.ts) — what the catalog test guards
- [`docs/feature-matrix.md`](feature-matrix.md) — the plugin-to-tool mapping the catalog test guards
- [`packages/plugins/README.md`](../packages/plugins/README.md) — the plugin contract
- [`release.md`](release.md) — maintainer checklist, version bump, tagging, and current automation status
- [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) — website deployment only
