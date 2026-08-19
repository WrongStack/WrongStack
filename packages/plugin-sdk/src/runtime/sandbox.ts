/**
 * Sandbox — canonical project-path validation with symlink resolution.
 *
 * Why a new helper when `runtime/index.ts` already exports
 * `withinProject` and `sanitizeRunnerPath`?
 *
 *  - `withinProject` does NOT resolve symlinks: a path like
 *    `project/link-to-/etc/passwd` reports as inside the project
 *    even though the resolved target is outside.
 *  - `sanitizeRunnerPath` is for runner argv (linter binaries),
 *    not user-supplied tool input. The two paths share the
 *    leading-dash + length checks but `sanitizeRunnerPath`
 *    rejects a `cwd` for which it cannot resolve; user-input
 *    sandbox needs canonicalization instead.
 *
 * The previous design (per SAGE memory T-03) relied on three
 * duplicate `withinProject` copies in `runtime/index.ts`,
 * `file-watcher/index.ts`, and `path-guard/glob.ts`. They drifted
 * on edge cases. This helper is the single replacement.
 *
 * Contract:
 *   `safePath(input, projectRoot?)` returns the canonical absolute
 *   path inside the project on success, or `null` on rejection.
 *
 * Rejection cases:
 *   - empty string
 *   - length > 4096 bytes (matches `runtime.withinProject`)
 *   - leading-dash (option smuggling)
 *   - cannot be resolved (path doesn't exist or EPERM)
 *   - resolved path escapes the project root
 *   - symlink target is outside the project
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface SafePathOptions {
  /**
   * Project root for the sandbox. Defaults to `process.cwd()`. Pass
   * the session cwd from the plugin host when available so that
   * tools running in a subdirectory are scoped to that directory.
   */
  projectRoot?: string;
  /**
   * If true (default), follow symlinks via `realpathSync`. Set false
   * for plugins that need to record the literal path the user wrote
   * (e.g. checkpoint capture, git diff).
   */
  followSymlinks?: boolean;
}

const MAX_PATH_BYTES = 4096;

/**
 * Resolve `input` to an absolute path inside the project root.
 *
 * Returns `null` for empty/oversized/leading-dash inputs and for
 * paths whose real target escapes the project.
 */
export function safePath(input: string, options: SafePathOptions = {}): string | null {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > MAX_PATH_BYTES) return null;
  if (input.startsWith('-')) return null;

  const projectRoot = resolve(options.projectRoot ?? process.cwd());

  // First resolve to an absolute path so the relative-to-project
  // check has a stable input. realpathSync may throw on a missing
  // path; fall back to lexical resolve so a `write` to a brand-new
  // file is not silently rejected.
  const lexical = isAbsolute(input) ? resolve(input) : resolve(projectRoot, input);
  if (!withinLexical(projectRoot, lexical)) return null;

  // Now canonicalize: follow symlinks so a path that LIVES inside
  // the project but POINTS outside is rejected.
  if (options.followSymlinks !== false) {
    let real: string;
    try {
      real = realpathSync(lexical);
    } catch {
      // ENOENT / EPERM: the path doesn't resolve. Treat as outside
      // the project — the caller (a tool input) shouldn't name a
      // path we can't see.
      return null;
    }
    if (!withinLexical(projectRoot, real)) return null;
    return real;
  }

  return lexical;
}

function withinLexical(projectRoot: string, candidate: string): boolean {
  const rel = relative(projectRoot, candidate);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Boolean convenience for callers that don't need the canonical path.
 * Equivalent to `safePath(input, options) !== null`.
 */
export function isInsideProject(input: string, options: SafePathOptions = {}): boolean {
  return safePath(input, options) !== null;
}
