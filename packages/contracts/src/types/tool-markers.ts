/**
 * Sentinel keys provider adapters use to wrap tool-call arguments that could
 * not be parsed into a proper JSON object. Single source of truth — the core
 * tool executor (which DETECTS these markers to surface a friendly error)
 * defines them here, and the providers package (which PRODUCES them when
 * wrapping) imports from `@wrongstack/core`.
 *
 * P3 #14 (before-release.md): the list was duplicated in tool-executor.ts with
 * a "Keep this list in sync" comment — a manual rule that will eventually be
 * forgotten. Centralizing it removes the sync burden.
 *
 * Layering note: this lives in core (not providers) because the dependency
 * direction is providers → core, not the reverse. Putting it in providers
 * would force core into a forbidden upward dependency.
 *
 * Current markers:
 * - `__raw`            — produced by `parseToolInput` (Anthropic / shared)
 * - `__raw_arguments`  — produced by `contentFromOpenAI` (OpenAI / compatible)
 * - `_raw`             — produced by the streaming response builder's
 *                        `safeJsonOrRaw` (legacy fallback)
 */
export const MALFORMED_ARG_MARKERS = ['__raw', '__raw_arguments', '_raw'] as const;
