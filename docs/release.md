# Release Checklist

Step-by-step guide for publishing a WrongStack release.

---

## Pre-release

- [ ] If source changes made committed projections stale, refresh them first with `bun run release:prepare` and review the diff before committing. It regenerates, in order:
  - the provider catalog (`providers:catalog:write`)
  - the plugin manifest projections (`plugins:manifest:write`)
  - Core API snapshots, hotspot and test-only-export baselines, and `docs/reports` architecture evidence (`check:architecture:sync` + `report:architecture`)
  - the test-skip budget (`test-skips:sync` — review required; every skip declaration change is a policy decision)
- [ ] Run the repository release gate: `bun run release:check`
  - `bun scripts/audit-dependencies.mjs --audit-level=moderate`
  - dependency-ordered `bun run build`, tools-package WASM smoke, then `bun run check:dist-hidden`
  - `bun run providers:catalog:check`, `bun run website:tools:check` and `bun run plugins:manifest:check`
  - `bun scripts/check-package-contracts.mjs`
  - `bun scripts/check-npm-package-install.mjs`
  - `bun run write:build-manifest` → `bun run check:build-manifest`
  - `bun run check:architecture`, `bun run check:test-inventory`, `bun run check:test-skips`
  - `bun run check:node-pty`, `bun run check:rulebook`, `bun run lint:i18n`
  - `bun run typecheck:only` (the workspace build from the top of the gate is reused; no rebuild) and `bun run check:test-types`
  - `bun run test:coverage`
- [ ] Run the exact publish dry-run script: `bun run release:dry`
- [ ] Run `bun run lint` separately if the release policy requires the full Biome lint; it is not currently part of `release:check`.
- [ ] Manually dispatch the CI and dependency-audit workflows for the reviewed ref and inspect their results. `ci.yml` and `audit.yml` are `workflow_dispatch` only; a push or pull request does not run them.
- [ ] Run `bun run docs:check`, `bun run website:tools:check`, and `bun run --filter wrongstack-website build` for the release documentation and website. Update README highlights, website changelog/homepage and HTML metadata together.
- [ ] Deploy website content with a separate manual `pages.yml` dispatch after the reviewed ref is published. A successful local website build does not deploy it.

## Version bump

```bash
# Pick the right bump (patch / minor / major)
bun scripts/bump-version.mjs minor

# Verify
git diff --stat
```

- [ ] Root, every workspace package/app manifest, and website version surfaces
      were updated by the bump script; use its reported manifest count rather
      than a hard-coded package total
- [ ] The bump script regenerated WebUI protocol schemas with the official writer;
      `bun scripts/generate-protocol-schema.mjs --check` passes
- [ ] `website/package-lock.json`, `website/src/lib/utils.ts`, and `website/index.html` contain the intended website version
- [ ] CHANGELOG.md has a new dated release section; do not rewrite older release entries

## Commit the release candidate

```bash
git commit -am 'release: <version>'
```

- [ ] Commit message follows `release: X.Y.Z` format
- [ ] Working tree is clean and the commit contains the intended version/docs only

## Publish and verify

The intended publication path is the tag-triggered workflow
`.github/workflows/release.yml` (WS-040; see
[release-process.md](release-process.md)). Tag and push the reviewed release
commit; do not publish from a laptop first:

```bash
git tag v<version>
git push origin v<version>
```

The workflow verifies that the tag version matches `package.json` and that the
tagged commit belongs to `main`. It then builds and smokes standalone binaries
on Linux, Windows, and macOS, creates the GitHub Release, and attaches the
verified binaries, installers, checksum manifest, and Desktop packages. npm
publication is a separate path gated by the `npm-publish` environment; a
required reviewer must approve it before the OIDC credential is minted.

- [ ] The tag points at the exact reviewed release commit
- [ ] `verify`, `binaries`, `binaries-smoke`, and `github-release` succeeded
- [ ] The GitHub Release contains all eight `wstack-*` targets, `SHA256SUMS`,
      `install.sh`, and `install.ps1`
- [ ] `SHA256SUMS` verifies every uploaded standalone binary
- [ ] The four Desktop matrix jobs passed package smoke; Desktop assets and
      `DESKTOP-SHA256SUMS` were attached
- [ ] If npm publication is intended, approve `npm-publish` and verify every
      intended public package after the workflow finishes

`bun run release` remains an emergency local npm fallback. It reruns
`release:check` and enforces a clean main checkout, so use it only from a clean,
up-to-date `main` checkout with the intended registry and authentication
verified. It does not replace the GitHub binary/Desktop release path.

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
- [ ] If npm publication was requested, verify packages such as
      `npm info @wrongstack/core`
- [ ] Update README.md "What's new" section if major release

## Hotfix process

If a critical bug is found after release:

```bash
git checkout v<version>
git checkout -b hotfix/0.5.1
# fix the bug
bun scripts/bump-version.mjs patch
git commit -am 'release: 0.5.1'
# Push and merge the hotfix through the repository's normal review path.
git push -u origin hotfix/0.5.1

# After the reviewed commit is on main:
git checkout main
git pull --ff-only
git tag v0.5.1
git push origin v0.5.1
```

---

## Automation status

- `.github/workflows/release.yml` handles tag/SHA verification, standalone
  binaries, GitHub Release creation, Desktop packages, and environment-gated
  npm trusted publishing.
- `.github/workflows/binaries.yml` is reusable and can prove the standalone
  build and cross-platform smoke without cutting a release.
- `.github/workflows/desktop.yml` is reusable and packages/smokes each Desktop
  target without publishing credentials.
- `.github/workflows/pages.yml` builds and deploys `website/` independently.

---

## npm publish dry run

To see exactly what would be published without actually publishing:

```bash
bun run release:dry
```
