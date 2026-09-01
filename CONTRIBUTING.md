# Contributing to WrongStack

Thank you for your interest in contributing to WrongStack! This guide covers the essentials for getting set up and submitting changes.

---

## Prerequisites

- **Node.js** ≥ 22.19.0
- **pnpm** ≥ 11.5.3 (`corepack enable && corepack prepare pnpm@11.5.3 --activate`)
- **Git**
- **Python 3** (only if you work on the security-scanner skills)

## Setup

```bash
git clone https://github.com/WrongStack/WrongStack.git
cd WrongStack
pnpm install
pnpm build
```

The `postinstall` script configures git hooks (`.githooks/pre-commit`) automatically.

## Development Workflow

### Building

```bash
pnpm build                    # Build all packages
pnpm --filter @wrongstack/core build   # Build a single package
```

### Testing

```bash
pnpm test                     # Run vitest + webui tests
pnpm test:watch               # Watch mode
pnpm test:coverage            # Coverage report
pnpm test:e2e                 # Playwright E2E suite
node node_modules/vitest/vitest.mjs run packages/telegram/  # Tests for one package
```

### Linting & Formatting

```bash
pnpm lint                     # Lint with Biome
pnpm exec biome check --write .  # Auto-fix lint issues
pnpm format                   # Format with Biome
pnpm typecheck                # TypeScript type-check all packages
```

### Benchmarks

```bash
pnpm bench                    # Run vitest bench
pnpm bench:perf               # Run performance benchmarks
```

---

## Pre-Commit Hooks

The `.githooks/pre-commit` hook runs:

1. **`guard-against-corruption`** — blocks known corruption patterns and suspicious mass-changes
2. **`lint-console-logging`** — enforces structured logging instead of raw `console.*`
3. **`guard-unresolved-imports`** — blocks commits that import modules not staged/tracked

These are advisory-only without `set -e`. The hook enables it. **Do not bypass with `--no-verify`** unless you understand the guards.

### Local CI (`pnpm ci:local`)

There is no pre-push hook: `git push` is not gated. Run `pnpm ci:local` yourself before pushing — it is the laptop equivalent of [`.github/workflows/ci.yml`](.github/workflows/ci.yml): lint, build, typecheck, Vitest + WebUI tests, HQ dashboard / TUI status-bar suites, and the snapshot/architecture gates.

Coverage ratchets (~45 min) and Playwright e2e stay in GitHub CI. The full maintainer matrix remains available as `pnpm release:check`.

```bash
pnpm ci:local          # laptop subset of GitHub CI
pnpm release:check     # full matrix, including coverage
```

---

## Code Style

WrongStack uses **Biome** for formatting and linting, with strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, etc.).

Key conventions:

- **ESM only** — `"type": "module"` in all packages. Use `import`/`export`, not `require`.
- **File extensions in imports** — use `.js` in relative imports (NodeNext resolution).
- **No `console.*` in production code** — use the structured logger instead.
- **Strict null checks** — never use `!` non-null assertions without a preceding guard.
- **`as never` is a red flag** — only acceptable in test code where you deliberately bypass types.

---

## Monorepo Layout

```
packages/    — 20 publishable packages (core, cli, tools, providers, etc.)
apps/        — wrongstack (binary shim), desktop (Electron)
website/     — Marketing/docs site
e2e/         — Playwright E2E tests
docs/        — Architecture docs, ADRs, plans, slash-command reference
scripts/     — Build, lint, and guard scripts
```

Each package has its own `package.json`, `tsconfig.json`, `src/`, and `tests/`.

---

## Submitting Changes

### 1. Create a branch

```bash
git checkout -b feat/your-feature
```

### 2. Make your changes

- Keep commits focused — one logical change per commit.
- Run `pnpm ci:local` before pushing — pushes are not gated by any hook. Fix failures locally instead of pushing a red tree.
- Write tests for new functionality.

### 3. Commit message convention

We follow **Conventional Commits**:

```
feat(tools): add glob support to read tool
fix(cli): correct fallback chain for review agents
docs(core): document BootConfig options
refactor(webui): extract AudienceMemoryPanel scope logic
test(telegram): add cursor persistence integration test
chore(deps): bump undici to 7.28.0
```

### 4. Push and open a PR

```bash
git push origin feat/your-feature
```

Open a pull request against `main`. CI runs lint → typecheck → build → test automatically.

---

## CI Pipeline

The [CI workflow](.github/workflows/ci.yml) runs on every push and PR to `main`:

| Job | What it does |
|---|---|
| **Lint** | Biome lint check |
| **Typecheck** | `tsc --noEmit` across all project references |
| **Build** | `pnpm build` — esbuild all packages |
| **Test** | `pnpm test` — vitest + webui tests |

All jobs must pass before merge.

---

## Adding a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, `src/`, `tests/`.
2. Add to `pnpm-workspace.yaml` (covered by `packages/*` glob).
3. Add a project reference in root `tsconfig.json`.
4. Create a `vitest.config.ts` if the package needs test-specific config.
5. Run `pnpm install` to link.

---

## Release Process

Releases are manual (no automated publishing yet):

```bash
pnpm release:check    # Full gate: audit + build + contracts + lint + typecheck + test
pnpm release          # release:check + portable build + ordered publish
pnpm release:plan     # print the dependency-layer publish order (publishes nothing)
pnpm release:verify   # confirm every working-tree version is live on npm
```

Versioning uses `pnpm version:patch` (or `version:minor` / `version:major`) and conventional-commit-based semver bumps.

### Why the publish is ordered

`pnpm publish -r` sorts topologically but publishes concurrently, so the
registry can observe a package before its dependencies. That shipped a real
outage in 0.317.2: `wrongstack` landed on npm 25 seconds ahead of its
transitive dependency `@wrongstack/webui-hq`, and every `npm i -g wrongstack`
in that window failed with `ETARGET`. `scripts/publish-workspace.mjs` publishes
in dependency layers and polls the registry until each layer is actually
resolvable before starting the next, so the install target is always last.

---

## Reporting Bugs

Open a [GitHub Issue](https://github.com/WrongStack/WrongStack/issues) with:

1. WrongStack version (`wstack --version`)
2. Node.js and OS version
3. Minimal reproduction steps
4. Expected vs. actual behavior
5. Relevant logs (redact API keys!)

## Reporting Security Vulnerabilities

See [SECURITY.md](SECURITY.md). **Do not open public issues for security vulnerabilities.**

---

## Questions?

- [Documentation](docs/)
- [Configuration Reference](docs/configuration.md)
- [Architecture Docs](docs/director-architecture.md)
- [GitHub Issues](https://github.com/WrongStack/WrongStack/issues)
