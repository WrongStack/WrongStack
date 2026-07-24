/**
 * Canonical directory-name ignore list for recursive tree walkers.
 *
 * Every walker that enumerates the project tree (glob, grep's native
 * fallback, tree, the codebase indexer, the chronicle file observer, the
 * semantic-search indexer, project fingerprinting, security scans) should
 * start from this list instead of hand-rolling its own — the hand-rolled
 * copies drifted, and a walker missing `.turbo` or `__pycache__` pays for
 * it by walking thousands of artifact files.
 *
 * The list is intentionally conservative: only dependency stores, VCS
 * internals, and build/cache artifacts that are never the subject of a
 * search. Directories a user may legitimately target (`.wrongstack`,
 * `vendor`, `out`) are NOT here — walkers with stricter needs append their
 * own entries.
 *
 * @module utils/walk-ignore
 */

/** Directory basenames every recursive walker skips (matched per path segment). */
export const DEFAULT_WALK_IGNORE_DIRS: readonly string[] = Object.freeze([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
  '.nyc_output',
  '__snapshots__',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.cache',
  '.parcel-cache',
  '.pnpm-store',
  '.gradle',
]);

/** Set form of {@link DEFAULT_WALK_IGNORE_DIRS} for per-segment membership checks. */
export const DEFAULT_WALK_IGNORE_SET: ReadonlySet<string> = new Set(DEFAULT_WALK_IGNORE_DIRS);
