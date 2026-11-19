# Bun development workflow

## Migration validation status

The commands and CI configuration use Bun. `migration:check` validates
configuration and dry-run plans; `release:check` validates the complete runtime,
build, type and coverage gates. Package checks support focused iteration and do
not certify a release by themselves.

Bun 1.4.3's `node:sqlite` leaves prepared statements holding database files open
on Windows after `DatabaseSync.close()`. The initial migration suite reported
many cascading `EBUSY` teardown failures from this shared runtime issue. See
[Bun issue #40001](https://github.com/oven-sh/bun/issues/40001) and the pending
[upstream fix #40005](https://github.com/oven-sh/bun/pull/40005).

The runtime selector now uses native `bun:sqlite` under Bun and calls
`close(true)` to finalize statements. SAGE text and session catalog titles use
additive Unicode search columns in place of custom SQL functions. Older rows
are backfilled on the first filtered query, updates invalidate the derived
values through triggers, and refresh plus query share one SQLite snapshot.
Node consumers retain `node:sqlite`. Tests and release gates remain enabled;
a successful full matrix is still required before release.

WebSocket hosts load the actual npm `ws` implementation through typed runtime
helpers, instead of Bun's built-in compatibility shim. HTTP WebSocket proxy
handshakes support both absolute HTTP URIs and origin-form paths.
Published server bundles include the
private `ws/native` entry, so ordinary registry installs do not need the patch.

Under Bun, continuous memory profiling records JavaScriptCore heap statistics
(`.heapstats.json`), including its explicit backend and limitation metadata;
allocation stack sampling is unavailable through this backend. The isolated
resource inspector tracks global timers plus native-reported resources. It
cannot infer heap retention or timers created through imported `node:timers` APIs.

The workspace and GitHub Actions use Bun 1.4.5, pinned in `.bun-version` and
`package.json`. Install Bun, then run:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
bun run setup:hooks
bun run build
bun run test
bun run release:check
```

Use `bun run test`, because `bun test` selects Bun's own test runner. The project
continues to use Vitest, executed under Bun, and TypeScript for declaration emit.
`node:` imports are compatibility APIs and do not select the Node executable.

For local iteration, select packages instead of repeatedly running the full suite:

```sh
bun run test:package vector-memory
bun run test:package persistence sage
bun run test:package webui
bun run test:package cli --dry-run
bun run test:package --list
bun run test:affected --list
```

Package selection runs suites sequentially using the root test configuration;
WebUI uses its own environment configuration, and CLI/TUI also run their dedicated
dashboard/color suites. Empty selections fail instead of reporting success.
This selects package tests only; callers must include affected consumer packages
when shared APIs change. `test:affected` is a local import-cache aid and may run
the full root suite on a cold cache or after configuration/lockfile changes.
`bun run test` and `bun run release:check` still provide full validation.
Root and WebUI tests cache transformed modules on disk while preserving file
isolation. `WRONGSTACK_VITEST_MAX_WORKERS` can override the shared worker cap.

```sh
bun run migration:check       # frozen install dry-run, workspace and CI command checks
bun run release:check --list # list gates without running them
```

`bun.lock` is the installation lockfile. `bunfig.toml` enables Bun execution and
the isolated linker, and preserves the 24-hour release-age policy. The old pnpm
files remain as migration evidence and the reviewed advisory-policy source;
pnpm is not needed to execute these commands. The reviewed dependency patches remain
pinned in `package.json` and the Bun lockfile.

CI installs with scripts disabled and explicitly executes only the reviewed
native dependencies through `setup:native`. Releases ship only as GitHub Release
binaries, built by CI from a `vX.Y.Z` tag.

npm publishing is retired, so there is no registry publish job and no OIDC
trusted-publishing step. The root `prepublishOnly` hook fails on purpose with
"npm publishing is retired: WrongStack releases ship only as GitHub Release
binaries". The only OIDC tokens CI mints are the build-provenance attestation
for the standalone binaries (`.github/workflows/binaries.yml`) and the Pages
deployment token (`.github/workflows/pages.yml`).
