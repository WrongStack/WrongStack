# `wstack update` — Self-Update

## What it does

Checks the npm registry for a newer version of `wrongstack` and updates the global install with the matching package manager when possible.

## Behavior

```
wstack update
  → Fetch latest version from npm
  → Compare with current (API_VERSION from version.ts)
  → If newer: run the detected global package-manager update command
  → If current: "You are on the latest version"
  → If error: "Update check failed — check your internet connection"
```

Use `wstack update --check-only` (or `-c`) to report availability without running a package manager.

By default the command detects `pnpm`, `yarn`, and `bun` from the runtime environment or install path, then falls back to npm. You can force a package manager with `--pm` or `--package-manager`; `--npm`, `--pnpm`, `--yarn`, and `--bun` are also accepted shortcuts:

```text
wstack update --pm npm
wstack update --package-manager pnpm
wstack update --yarn
```

Package lifecycle scripts are disabled for the update by default. Pass `--allow-scripts` (alias `--lifecycle-scripts`) only when the global package requires them.

On Windows, the updater resolves the package-manager executable from PATH outside
the current project. A project-local `node_modules/.bin/npm.cmd` must not be
used for a global update. If npm reports `EBUSY`, `EPERM`, or a locked
WrongStack native file, stop running WrongStack WebUI, Desktop, and background
processes, then rerun the same update command. Do not delete npm's temporary
`.wrongstack-*` staging directory while one of those processes is still running.

Equivalent manual commands:

```bash
npm install -g wrongstack@latest
pnpm add -g wrongstack@latest
yarn global add wrongstack@latest
bun add -g wrongstack@latest
```

`node-pty` is not a required global install dependency. The WebUI integrated terminal loads it only when present; this keeps `npm i -g wrongstack` from tripping npm's `allow-scripts` warning for `node-pty` on machines that only need the CLI/TUI.

## Code reference

- `packages/cli/src/subcommands/handlers/update.ts`
