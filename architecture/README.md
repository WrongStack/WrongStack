# Architecture Health Registry

This directory contains machine-readable inputs for WrongStack architecture verification.

- `registry.json` defines the implementation scope, Core source-area classifications, and test-project ownership.
- `exceptions.json` contains temporary, owned, expiring architecture exceptions.

Run:

```bash
pnpm check:architecture
pnpm check:test-inventory
pnpm check:test-skips
pnpm check:test-types
pnpm check:build-manifest
pnpm report:architecture
```

`check:architecture` fails for workspace cycles, unclassified Core areas, test files without exactly one runtime-test owner, non-command imports of CLI slash-command adapters, unowned module cycles, expired exceptions, stale exceptions, and committed report evidence that predates the newest commit under `architecture/`, `packages/`, or `apps/`. The slash-command catalog entry point is the only permitted composition import; reusable behavior belongs under `packages/cli/src/services/`.

`report:architecture` writes the current JSON and Markdown evidence to `docs/reports/`. Generated evidence must be updated in the same PR that intentionally changes the architecture baseline. This is enforced by the freshness gate: `check:architecture` fails when the newest commit touching `architecture/`, `packages/`, or `apps/` is strictly newer than the last commit that regenerated the report pair (git commit timestamps, never mtimes). Regenerate with `pnpm report:architecture` and commit both report files together — regenerating only one of the pair remains stale, because freshness is measured as the older of the two. In a shallow clone (e.g. `actions/checkout` with `fetch-depth: 1`, the default on PR runs) the gate skips with a warning instead of guessing: at the shallow boundary every path reads as newly added at HEAD, so path-filtered history cannot decide freshness. Use `fetch-depth: 0` when you want CI to enforce the gate.

`check:test-types` executes every package `tsconfig.test.json`. Existing diagnostic identities and occurrence counts are recorded per package under `test-typecheck-baseline/`; a new diagnostic or an increased occurrence count fails, while resolved debt is reported without requiring a baseline rewrite. Diagnostic identities use the first 64 bits of SHA-256 over the normalized project/file/code/message tuple.

`check:test-inventory` compares the registry with Vitest's actual file collection for every runtime project. `check:test-skips` ratchets all reviewed `skip`, `skipIf`, `runIf`, conditional skip, and runtime-skip declarations against `test-skip-budget.json`; adding, changing, or resolving one requires an explicit budget review.

`check:build-manifest` verifies that all in-scope `dist` files match the SHA-256 lineage written by `write:build-manifest`. CI additionally runs `check:clean-dist` before the build and reuses the verified artifact in downstream jobs.

Website is excluded from the implementation program by the 2026-07-21 scope decision.

## Exception requirements

Every exception must have:

- a stable ID;
- a supported rule kind;
- exact scope/members;
- an owner;
- a concrete reason;
- introduction and review dates;
- a removal condition;
- a canonical task ID.

An exception is not a permanent allowance. Expired and stale records fail verification.
