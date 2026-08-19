/**
 * Backwards-compatible re-export: the runtime helpers moved to
 * `@wrongstack/plugin-sdk/runtime` so third-party plugin authors get the
 * same audit-hardened helpers first-party plugins use, without depending
 * on the whole @wrongstack/plugins package. This shim keeps the
 * `@wrongstack/plugins/runtime` subpath (and every in-repo relative
 * import) working unchanged.
 */

export * from '@wrongstack/plugin-sdk/runtime';
