/**
 * Backwards-compatible re-export: the runtime helpers moved to
 * `@wrongstack/plugin-sdk/runtime` so third-party plugin authors get the
 * same audit-hardened helpers first-party plugins use, without depending on
 * the whole @wrongstack/plugins package. This shim keeps the
 * `@wrongstack/plugins/runtime` subpath (and every in-repo relative
 * import) working unchanged.
 *
 * Why this one still imports the BARREL while the six leaf shims
 * (`redos-guard`, `sandbox`, `llm`, …) import granular
 * `@wrongstack/plugin-sdk/runtime/*` entries: the language-runner helpers
 * (`resolveRunnerCommand`, `sanitizeRunnerPath`, `runRunnerCommand`,
 * `probeRunnerCommand`), `withinProject`, `collectSourceFiles(Async)` and
 * `matchesExtension` are defined in the sdk's runtime barrel module itself.
 *
 * DO NOT re-try granular-rewiring this shim without fixing the blocker
 * first: round sdk-runner-r1 (2026-09-06, PERF_LOG) extracted the runner
 * module to `./runtime/runner` and rewired this shim — it REGRESSED
 * path-guard +46% and branch-guard +24% cold-import because
 * `@wrongstack/core/utils` (~43ms, measured) is unavoidable in the runner
 * graph and the split added per-entry resolution on top of the same
 * transitive chains. Everything was reverted. The unlock is a cheap
 * `@wrongstack/core/utils` (or a lazy `buildChildEnv`), LANDED 2026-09-06 (round core-utils-r1): @wrongstack/core/utils/child-env now imports in ~4.5ms and the plugin-sdk barrel uses it — the runner-extraction re-attempt is a fresh hypothesis (expect barrel consumers near the ~12ms tier), not a blind retry.