# WrongStack website

The marketing and documentation site is a Vite/React application in the Bun
workspace. Work from the repository checkout, not a standalone copy of this
folder: the build reads runtime catalogs and installer scripts from sibling
packages and `scripts/`.

## Setup

Use the Bun version pinned in the repository's `.bun-version`. From the repository
root in PowerShell:

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
bun scripts/build.mjs --target @wrongstack/core
bun run --filter wrongstack-website dev
```

The reviewed native rebuild and core dependency build mirror the Pages workflow.
The shared Bun typechecker imports core utilities from built workspace artifacts;
a fresh checkout needs those artifacts before website typechecking or building.
Vitest, jsdom and Biome come from the root workspace dependencies.

## Verification

Run these sequentially from the repository root:

```powershell
bun run --filter wrongstack-website typecheck
bun run --filter wrongstack-website typecheck:tests
bun run --filter wrongstack-website test --maxWorkers=1
bun run --filter wrongstack-website lint
bun run --filter wrongstack-website build
```

To format website files with the repository's `biome.json`:

```powershell
bun run --filter wrongstack-website format
```

The production build writes `website/dist/`, checks mode, roster, tool and plugin
catalog membership against runtime source, and emits static route shells plus
canonical installer scripts. Tests run separately under Vitest; `bun test` is a
different runner and is not the website test command.

## Keeping content compatible

- Page components live in `src/pages/`; shared copy and catalogs live in `src/data/`.
- Settings defaults have source-backed checks in `tests/content-defaults.test.tsx`.
- After changing built-in tool contracts, run `bun run website:tools:write` from
  the repository root, then `bun run website:tools:check`. These commands rebuild
  the tools package before generating or comparing website projections.
- Preserve historical changelog entries; verify current command examples against
  the owning package scripts and runtime handlers.
- For each release, align root `README.md` and `CHANGELOG.md` with
  `src/data/changelog-1x.ts` and `src/data/release-highlights.ts`. Keep exactly one
  latest entry matching the root package version and `src/lib/utils.ts` metadata.
- Keep Open Graph and Twitter descriptions in `index.html` identical to the
  release highlights' social description, and set the structured-data version
  and modification date to the current changelog entry. The site-data tests
  verify this alignment; the homepage uses the shared release highlights.
- Keep hand-maintained files at or below 800 physical lines.

Deployment is the manually dispatched `.github/workflows/pages.yml` workflow.
Local build verification does not deploy the site or prove hosted-browser behavior.
