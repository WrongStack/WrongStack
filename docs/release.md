# Release Checklist

Step-by-step guide for cutting a WrongStack release.

WrongStack ships **only through GitHub Releases**: standalone `wstack` binaries,
installers and checksum manifests, all built by
`.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.

**npm publishing is retired for good.** Every workspace package is
`"private": true`, there is no publish script, the root `prepublishOnly` hook
refuses, and no workflow publishes to or reads from the npm registry. The
versions already on npm stay frozen exactly as they are — they are neither
deprecated nor unpublished. Users install the binary
(`curl -fsSL https://wrongstack.com/install.sh | sh`); `wstack update` moves a
legacy npm install onto the binary.

---

## Procedure at a glance

```bash
bun run version:set X.Y.Z        # 1. bump every manifest + website version surfaces
# 2. CHANGELOG.md, README.md "What's new", website changelog/homepage
bun run release:prepare          # 3. refresh committed projections and evidence
git commit -am 'release: X.Y.Z'  # 4. commit the release candidate
bun run release:check            # 5. full gate — do not touch the tree afterwards
git push origin main             # 6. push main
git tag -a vX.Y.Z -m 'X.Y.Z'     # 7. annotated tag on the release commit
git push origin vX.Y.Z           #    → CI builds binaries and creates the GitHub release
```

## 1. Version bump

```bash
bun run version:set X.Y.Z
git diff --stat
```

- [ ] Root, every workspace package/app manifest, and website version surfaces
      were updated by the bump script; use its reported manifest count rather
      than a hard-coded package total
- [ ] The bump script regenerated WebUI protocol schemas with the official writer;
      `bun scripts/generate-protocol-schema.mjs --check` passes
- [ ] `website/package-lock.json`, `website/src/lib/utils.ts`, and `website/index.html` contain the intended website version

## 2. Release notes and website

- [ ] CHANGELOG.md has a new dated release section; do not rewrite older release entries
- [ ] README highlights, website changelog/homepage and HTML metadata are updated together
- [ ] `bun run docs:check`, `bun run website:tools:check`, and `bun run --filter wrongstack-website build` pass

## 3. Refresh projections

- [ ] `bun run release:prepare`, then review the diff. It regenerates, in order:
  - the provider catalog (`providers:catalog:write`)
  - the plugin manifest projections (`plugins:manifest:write`)
  - Core API snapshots, hotspot and test-only-export baselines, and `docs/reports` architecture evidence (`check:architecture:sync` + `report:architecture`)
  - the test-skip budget (`test-skips:sync` — review required; every skip declaration change is a policy decision)

## 4. Commit the release candidate

```bash
git commit -am 'release: X.Y.Z'
```

- [ ] Commit message follows `release: X.Y.Z` format
- [ ] Working tree is clean and the commit contains the intended version/docs only

## 5. Release gate

- [ ] `bun run release:check` (`bun run release` is an alias) passes. It runs:
  - `bun scripts/audit-dependencies.mjs --audit-level=moderate`
  - dependency-ordered `bun run build`, tools-package WASM smoke, then `bun run check:dist-hidden`
  - `bun run providers:catalog:check`, `bun run website:tools:check` and `bun run plugins:manifest:check`
  - `bun scripts/check-package-contracts.mjs`
  - `bun run write:build-manifest` → `bun run check:build-manifest`
  - `bun run check:architecture`, `bun run check:test-inventory`, `bun run check:test-skips`
  - `bun run check:node-pty`, `bun run check:rulebook`, `bun run lint:i18n`
  - `bun run typecheck:only` (the workspace build from the top of the gate is reused; no rebuild) and `bun run check:test-types`
  - `bun run test:coverage`
- [ ] Run `bun run lint` separately if the release policy requires the full Biome lint; it is not currently part of `release:check`.
- [ ] Do not edit the tree after the gate passes; a change invalidates it.
- [ ] In a shared checkout with ongoing writers, push the reviewed candidate
      and dispatch `release-check.yml` with its full SHA before creating the
      tag. This runs the same uncached 19-gate matrix in a clean checkout and
      retains its logs. Verify the run's SHA and success; a local run whose
      sources changed during verification is not certification.
- [ ] Optionally dispatch the CI and dependency-audit workflows for the reviewed ref. `ci.yml` and `audit.yml` are `workflow_dispatch` only; a push or pull request does not run them.

## 6–7. Push main, then the tag

```bash
git push origin main
git tag -a v<version> -m '<version>'
git push origin v<version>
```

The workflow verifies that the tag version matches `package.json` and that the
tagged commit belongs to `main`. It then builds and smokes standalone binaries
on Linux, Windows, and macOS, creates the GitHub Release, and attaches the
verified binaries, installers, and checksum manifest. That is
the whole release; nothing is published anywhere else.

- [ ] The tag points at the exact reviewed release commit
- [ ] `verify`, `binaries`, `binaries-smoke`, and `github-release` succeeded
- [ ] The GitHub Release contains all eight `wstack-*` targets, `SHA256SUMS`,
      `install.sh`, and `install.ps1`
- [ ] `SHA256SUMS` verifies every uploaded standalone binary

A failed binary job is re-run for the same tag through the
workflow's manual `workflow_dispatch` input; never bump the version to recover.

## Post-release

- [ ] Verify the standalone installers on at least one release platform:

```bash
# macOS / Linux
curl -fsSL https://wrongstack.com/install.sh | sh

# Windows PowerShell
irm https://wrongstack.com/install.ps1 | iex
```

  The same scripts also ship as release assets
  (`https://github.com/WrongStack/WrongStack/releases/latest/download/install.sh`
  / `install.ps1`); the wrongstack.com copies are emitted from
  `scripts/install/` by the website build.

- [ ] Run `wstack version` from the installed standalone binary
- [ ] Deploy website content with a separate manual `pages.yml` dispatch for the released ref. A successful local website build does not deploy it.

## Hotfix process

If a critical bug is found after release:

```bash
git checkout v<version>
git checkout -b hotfix/0.5.1
# fix the bug
bun run version:set 0.5.1
git commit -am 'release: 0.5.1'
# Push and merge the hotfix through the repository's normal review path.
git push -u origin hotfix/0.5.1

# After the reviewed commit is on main:
git checkout main
git pull --ff-only
git tag -a v0.5.1 -m '0.5.1'
git push origin v0.5.1
```

---

## Automation status

- `.github/workflows/release.yml` handles tag/SHA verification, standalone
  binaries, and GitHub Release creation. It never publishes
  to npm and does not query the npm registry.
- `.github/workflows/binaries.yml` is reusable and can prove the standalone
  build and cross-platform smoke without cutting a release.
- `.github/workflows/pages.yml` builds and deploys `website/` independently.
