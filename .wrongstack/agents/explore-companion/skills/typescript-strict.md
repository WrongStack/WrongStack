## Verify from current source

- Re-verify file-payload claims against current source before applying stale role notes. [applied 4×, 4 ok] `packages/core/src/sandbox/windows-helper.ts` is now the 82-line `runas /trustlevel:0x20000` variant (`defaultWindowsHelperRunner`), not the PowerShell/C# Safer P/Invoke script older notes describe — read its contract from the TypeScript signatures and header doc, and map sandbox blast radius from `windows-native.ts:11` (production), `sandbox/index.ts:34` (public-API snapshot gate), and env-gated `windows-native-integration.test.ts`.

## Test collection

- Predict collection only from applicable configs: `packages/cli/tests/**` follows both `packages/cli/vitest.config.ts` and root `vitest.config.ts` (`include: packages/**/tests/**/*.test.{ts,tsx}`; tools/providers root-only; node env, `globals: false`, `setupFiles: ../../vitest.setup.ts`, `globalSetup: tests/sage-build-guard.global-setup.ts`).
- Judge CLI test deletions or weakenings against `coverage.exclude` (72/70/70/61 over `src/**`) before calling them safe.

## Typecheck gates

- Prove typecheck participation from files — `glob "packages/<pkg>/tsconfig*.json"` plus `tsconfig.test.json` and `*.test.ts` under `tests/` — never from absence in `scripts/check-test-typecheck.mjs` (`discoverProjects()` scans all workspace packages).
- Treat new or increased diagnostics as release-blocking: they trip the `architecture/test-typecheck-baseline` ratchet in `release:check`.

## WrongForge error provenance

- Trace any `WrongForge: …` message from its two mint sites in `packages/cli/src/wrongforge-leader/wrongforge-leader-provider.ts`: `taskError()` formats failed task records as `` `${code}: ${message}` `` and special-cases `context_overflow` → HTTP 413 / kind `context_overflow`, while `providerError()` wraps direct `WfHttpError` calls where a generic 400 becomes kind `invalid_request`. [applied 33×, 33 ok]
