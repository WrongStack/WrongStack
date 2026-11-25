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

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The target text of `p` when it is a symlink, otherwise `undefined`. */
function danglingLinkTarget(p: string): string | undefined {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : undefined;
  } catch {
    return undefined;
  }
}

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
  if (
    input.trim().length === 0 ||
    input.includes('\0') ||
    Buffer.byteLength(input, 'utf8') > MAX_PATH_BYTES
  ) {
    return null;
  }
  if (input.startsWith('-')) return null;

  const configuredRoot = resolve(options.projectRoot ?? process.cwd());
  const followSymlinks = options.followSymlinks !== false;
  const projectRoot = followSymlinks ? realpathWithMissingLeaf(configuredRoot) : configuredRoot;
  if (projectRoot === null) return null;

  // First resolve to an absolute path so the relative-to-project
  // check has a stable input. realpathSync may throw on a missing
  // path; fall back to lexical resolve so a `write` to a brand-new
  // file is not silently rejected.
  const absoluteInput = isAbsolute(input);
  const lexical = absoluteInput ? resolve(input) : resolve(configuredRoot, input);
  // Relative input must not escape the spelling of the configured root before
  // symlink resolution. Absolute input is judged against the canonical root
  // below so callers may use either side of a linked project-root path.
  if (!absoluteInput && !withinLexical(configuredRoot, lexical)) return null;

  // Now canonicalize: follow symlinks so a path that LIVES inside
  // the project but POINTS outside is rejected.
  if (followSymlinks) {
    const real = realpathWithMissingLeaf(lexical);
    if (real === null || !withinLexical(projectRoot, real)) return null;
    return real;
  }

  return withinLexical(configuredRoot, lexical) ? lexical : null;
}

/** Symlink hops followed before giving up (the kernel's own ELOOP limit is 40). */
const MAX_DANGLING_LINK_HOPS = 40;

/**
 * Canonicalize existing ancestors while preserving a new leaf path.
 *
 * A DANGLING symlink also fails realpath with ENOENT, but it is not a new
 * file: `open(O_CREAT)` / `appendFile` follow it and create its target. Read
 * as "missing", `<root>/notes.jsonl -> ~/.bash_login` was judged to be inside
 * the project while the write landed in the user's shell profile
 * (WS-2026-09-26-06). So a link found on the way is replaced by its target
 * and resolution starts over from there.
 */
function realpathWithMissingLeaf(candidate: string, hops = 0): string | null {
  let current = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = realpathSync(current);
      return missing.reduceRight((parent, part) => join(parent, part), resolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const linkTarget = danglingLinkTarget(current);
      if (linkTarget !== undefined) {
        if (hops >= MAX_DANGLING_LINK_HOPS) return null;
        const target = resolve(dirname(current), linkTarget);
        return realpathWithMissingLeaf(
          missing.reduceRight((parent, part) => join(parent, part), target),
          hops + 1,
        );
      }
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function withinLexical(projectRoot: string, candidate: string): boolean {
  const rel = relative(projectRoot, candidate);
  if (rel === '' || rel === '.') return true;
  // Parent escapes only: `..` itself, or a `..${sep}` prefix. Any other
  // leading-dot name (`.gitignore`, `..audit-notes.md`) is an ordinary
  // segment inside the project; a bare `startsWith('..')` wrongly rejects
  // those (same idiom bug as withinProjectPath in ./index.js).
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
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
