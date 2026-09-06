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
 * The runner-extraction unlock LANDED 2026-09-06 (round core-utils-r1):
 * `@wrongstack/core/utils/child-env` imports in ~4.5ms and the plugin-sdk
 * barrel uses it. The extraction was re-attempted as round sdk-runner-r2
 * and REVERTED on measurement: the primary arm's win landed inside the
 * noise band (path-guard 12.33 -> 11.46ms, band ~5.4ms) because the
 * child-env entry already banked the barrel's cost, and the granular
 * 10-resolution shim measurably regressed multi-symbol consumers
 * (branch-guard 10.87 -> 16.95ms). Do not re-attempt without a new
 * hypothesis; see PERF_LOG round sdk-runner-r2.
 */

export * from '@wrongstack/plugin-sdk/runtime';
