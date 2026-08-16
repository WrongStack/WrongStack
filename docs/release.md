# Release Checklist

Step-by-step guide for publishing a WrongStack release.

---

## Pre-release

- [ ] If source changes made committed projections stale, refresh them first with `pnpm release:prepare` and review the diff before committing. It regenerates, in order:
  - the provider catalog (`providers:catalog:write`)
  - the plugin manifest projections (`plugins:manifest:write`)
  - Core API snapshots, hotspot and test-only-export baselines, and `docs/reports` architecture evidence (`check:architecture:sync` + `report:architecture`)
  - the test-skip budget (`test-skips:sync` — review required; every skip declaration change is a policy decision)
- [ ] Run the repository release gate: `pnpm release:check`
  - `pnpm audit --audit-level=moderate`
  - dependency-ordered `pnpm build`, then `pnpm check:dist-hidden`
  - `pnpm providers:catalog:check` and `pnpm plugins:manifest:check` (each rebuilds its own package first)
  - `node scripts/check-package-contracts.mjs`
  - `pnpm write:build-manifest` → `pnpm check:build-manifest`
  - `pnpm check:architecture`, `pnpm check:test-inventory`, `pnpm check:test-skips`
  - `pnpm check:node-pty`, `pnpm check:rulebook`, `pnpm lint:i18n`
  - `pnpm typecheck:only` (the workspace build from the top of the gate is reused; no rebuild) and `pnpm check:test-types`
  - `pnpm test:coverage`
- [ ] Run the exact publish dry-run script: `pnpm release:dry`
- [ ] Run `pnpm lint` separately if the release policy requires the full Biome lint; it is not currently part of `release:check`.

## Version bump

```bash
# Pick the right bump (patch / minor / major)
node scripts/bump-version.mjs minor

# Verify
git diff --stat
```

- [ ] Root, all 19 `packages/*`, both `apps/*`, and website version surfaces were updated by the bump script
- [ ] `website/package-lock.json`, `website/src/lib/utils.ts`, and `website/index.html` contain the intended website version
- [ ] CHANGELOG.md has a new dated release section; do not rewrite older release entries

## Commit the release candidate

```bash
git commit -am 'release: 0.5.0'
```

- [ ] Commit message follows `release: X.Y.Z` format
- [ ] Working tree is clean and the commit contains the intended version/docs only

## Publish and verify

The intended publication path is the tag-triggered, environment-gated workflow
`.github/workflows/release.yml` (WS-040; see [release-process.md](release-process.md)):
pushing a version tag *requests* a publish, and a required reviewer must approve
the `npm-publish` environment before anything reaches the registry. `pnpm release`
remains available as a local fallback:

```bash
pnpm release
```

`pnpm release` reruns `release:check`, then recursively publishes public workspace packages with `--access public`. Unlike the CI path (`release:ci`), it keeps pnpm's git checks, so run it from a clean tree on `main` that is up to date with the remote. Confirm npm authentication and the intended registry before running it.

- [ ] `pnpm release` completed successfully
- [ ] Every intended public package is visible on npm

After publication is verified, tag and push the exact published commit:

```bash
git tag v0.5.0
git push --follow-tags
```

- [ ] The tag points at the exact published commit

## Post-release

- [ ] Verify packages on npm: `npm info @wrongstack/core`
- [ ] Test install: `npm install -g wrongstack && wrongstack version`
- [ ] Create or verify the GitHub Release and notes manually (no checked-in release workflow currently does this)
- [ ] Update README.md "What's new" section if major release

## Hotfix process

If a critical bug is found after release:

```bash
git checkout v0.5.0
git checkout -b hotfix/0.5.1
# fix the bug
node scripts/bump-version.mjs patch
git commit -am 'release: 0.5.1'
pnpm release
# after npm verification:
git tag v0.5.1
git push --follow-tags
```

---

## Automation status

`.github/workflows/pages.yml` builds and deploys `website/` on pushes to `main` or manual dispatch. It does **not** typecheck/test/publish the npm workspace or create releases. If a release workflow is added later, document its triggers, ancestry/tag checks, permissions, and required secrets here only after the file exists.

---

## npm publish dry run

To see exactly what would be published without actually publishing:

```bash
pnpm release:dry
```
