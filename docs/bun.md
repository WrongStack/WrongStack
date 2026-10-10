# Bun development workflow

## Migration validation status

The commands and CI configuration use Bun, but full runtime validation is not
green yet. `migration:check` validates configuration and dry-run plans; it does
not certify the test suite or a release.

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

The workspace and GitHub Actions use Bun 1.4.3, pinned in `.bun-version` and
`package.json`. Install Bun, then run:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
bun run setup:hooks
bun run build
bun run test
bun release:check
```

Use `bun run test`, because `bun test` selects Bun's own test runner. The project
continues to use Vitest, executed under Bun, and TypeScript for declaration emit.
`node:` imports are compatibility APIs and do not select the Node executable.

```sh
bun migration:check       # frozen install dry-run, workspace and CI command checks
bun release:check --list # list gates without running them
bun release:dry           # exercise every publishable package without publishing
```

`bun.lock` is the installation lockfile. `bunfig.toml` enables Bun execution and
the isolated linker, and preserves the 24-hour release-age policy. The old pnpm
files remain as migration evidence and the reviewed advisory-policy source;
pnpm is not needed to execute these commands. Both dependency patches remain
pinned in `package.json` and the Bun lockfile.

CI installs with scripts disabled and explicitly executes only the reviewed
native dependencies through `setup:native`. Publishing still keeps verification,
packing and the privileged OIDC job separate.

Bun does not yet implement npm OIDC trusted publishing. The privileged publish
job runs the pinned npm 12.2.0 compatibility client **under Bun** using
`bun x --bun npm@12.2.0`; it does not require the Node or npm executable. The npm
10 package-install gate similarly runs its compatibility oracle under Bun.
These adapters preserve registry compatibility rather than switching CI to a
long-lived publishing token. Actual OIDC publishing needs a GitHub Actions run
and is not proven by a local dry-run.
