/**
 * Canonical rule for "this untrusted string may be used as ONE path segment".
 *
 * Any surface that takes a caller-supplied id and joins it onto a directory —
 * an HQ transcript route, an ACP session file, a per-session sidecar — must
 * validate with this rather than re-deriving the rule. Two copies of a path
 * check drift, and the half that drifts is the one nobody tested.
 *
 * Introduced for WS-019 (HQ transcript route) and made shared for WS-015 (ACP
 * session store), where the same class of bug let `sessionId` escape the store
 * directory.
 */
import * as path from 'node:path';

/**
 * Upper bound on one segment. Well past any generated id (ULID, UUID, nickname
 * `<base>#<pid>`) and short enough to keep a crafted value from pushing the
 * joined path past a filesystem limit.
 */
export const MAX_PATH_SEGMENT_LENGTH = 256;

/**
 * True when `value` is safe to use as a single path segment.
 *
 * Rejects the empty string, over-long input, the `.`/`..` traversal segments,
 * both separators (Windows accepts `/` too, so checking only `path.sep` is a
 * platform-specific hole), NUL (truncates the path in some syscalls), and `:`
 * (Windows drive-relative paths and NTFS alternate data streams).
 *
 * IMPORTANT: when the segment arrives percent-encoded, validate AFTER decoding.
 * `%2e%2e%2f` passes every check above and decodes to `../`.
 */
export function isSafePathSegment(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_SEGMENT_LENGTH) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.includes('\0')) return false;
  if (value.includes(':')) return false;
  return true;
}

/**
 * Resolve `segments` under `root`, returning `null` unless every segment is
 * safe AND the resolved path is still inside `root`.
 *
 * The containment check is deliberately redundant with
 * {@link isSafePathSegment}: the segment rule is the guard, and this is the
 * assertion that the guard actually held. A read or write reached only through
 * this helper cannot leave `root` even if the segment rule is later loosened.
 */
export function resolveContainedPath(root: string, ...segments: string[]): string | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!isSafePathSegment(segment)) return null;
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (candidate === resolvedRoot) return null;
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (!candidate.startsWith(prefix)) return null;
  return candidate;
}
