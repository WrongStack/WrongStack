export interface WriteTarget {
  path: string;
  kind: 'file' | 'scope' | 'deletion-scope';
}

// ---------------------------------------------------------------------------
// ReDoS guard for glob matching (audit T-02 / issue #365)
// ---------------------------------------------------------------------------
// compilePathGlob is a pure synchronous compiler (kept sync — the 247-test
// surface and scope-overlap helpers depend on it). The ReDoS surface is the
// *execution* of the compiled regex against tool-supplied paths: a hostile
// path matched against a pathological protect glob can stall the agent loop
// synchronously. `matchesAnyGuarded` runs each match inside the
// worker-thread watchdog from runtime/redos-guard.ts and terminates on
// budget. Fail-closed: a timed-out match is treated as a HIT so a hostile
// path can never bypass the guard by making the check hang.
import { withReDoSGuard } from '../runtime/redos-guard.js';

/** Default wall-clock budget per glob match (ms). Must clear worker spin-up (~20ms). */
export const GLOB_REDOS_BUDGET_MS = 250;

export interface GuardedMatchOptions {
  /** Invoked when a match times out — wired to the plugin's redosTimeouts counter. */
  onTimeout?: (info: { regex: RegExp; input: string; budgetMs: number; elapsedMs: number }) => void;
  /** Per-regex wall-clock budget. Default GLOB_REDOS_BUDGET_MS. */
  budgetMs?: number;
}

/**
 * Async, ReDoS-guarded equivalent of `matchesAny`. Each pattern is executed
 * inside a worker thread and terminated when the budget elapses. Returns
 * true on the first match; a timeout also returns true (fail-closed). Use
 * this for PROTECT matching against untrusted paths; keep allow-list
 * matching synchronous (a timeout there must NOT look like an exemption).
 */
/**
 * Batch all patterns into ONE worker invocation via a top-level alternation.
 * For glob-compiled sources (each alternative keeps its own anchors and the
 * shared i flag), "does any pattern match" is preserved exactly. This
 * collapses worker spin-up from O(patterns) to O(1) — without it, 9 default
 * protect patterns × ~20 ms spin-up × N targets blows the 5-second
 * PreToolUse deadline on bulk writes (chimera, index.ts:282).
 */
function mergeGuardedRegex(patterns: RegExp[]): RegExp {
  // Always build a fresh RegExp: returning a caller-supplied pattern object
  // would alias it into the worker call and any later lastIndex mutation.
  const flags = new Set<string>();
  for (const p of patterns) {
    for (const f of p.flags) {
      if (f !== 'g' && f !== 'y') flags.add(f); // drop stateful flags
    }
  }
  const uniqueFlags = [...flags].join('');
  return new RegExp(patterns.map((p) => p.source).join('|'), uniqueFlags);
}

export async function matchesAnyGuarded(
  path: string,
  patterns: RegExp[],
  options: GuardedMatchOptions = {},
): Promise<boolean> {
  const normalized = normalizePath(path);
  if (patterns.length === 0) return false;
  const result = await withReDoSGuard(
    mergeGuardedRegex(patterns),
    normalized,
    options.budgetMs ?? GLOB_REDOS_BUDGET_MS,
    options.onTimeout ? { onTimeout: options.onTimeout } : {},
  );
  if (result.timedOut) return true; // fail-closed: treat as protected
  return result.match !== null;
}

/**
 * Compile a glob pattern to a RegExp. Supports `**` (any depth),
 * `*` (within one segment), and `?` (single char). Matching is done
 * against forward-slash-normalized relative-ish paths, and a pattern
 * without a slash matches the basename anywhere in the tree
 * (`.env` matches `sub/dir/.env`).
 */
export function compilePathGlob(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '/' && normalized.slice(i) === '/**') {
      // A trailing `/**` includes the directory itself as well as descendants.
      // Otherwise `.git/**` misses the bare `.git` target.
      source += '(?:/(?:[^/]+(?:/[^/]+)*)?)?';
      break;
    }
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        const followedBySlash = normalized[i + 2] === '/';
        // Globstar spans whole path segments, never a substring of one.
        source += followedBySlash ? '(?:[^/]+/)*' : '(?:[^/]+(?:/[^/]+)*)?';
        i += followedBySlash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch !== undefined && /[.+^${}()|[\]\\]/.test(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  // Anchored at a segment boundary so `.env` also matches `sub/dir/.env`
  // and `a/b` matches `repo/a/b` but never `xa/b`.
  return new RegExp(`(?:^|/)${source}$`, 'i');
}

export function normalizePath(p: string): string {
  const slashNormalized = p.replace(/\\/g, '/');
  const drive = /^[a-z]:/i.exec(slashNormalized)?.[0] ?? '';
  const absolute = slashNormalized.startsWith('/') || drive.length > 0;
  const body = drive ? slashNormalized.slice(drive.length).replace(/^\//, '') : slashNormalized;
  const segments: string[] = [];

  for (const segment of body.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (drive) return `${drive}/${joined}`.replace(/\/$/, '');
  if (slashNormalized.startsWith('//')) return `//${joined}`.replace(/\/$/, '') || '//';
  if (slashNormalized.startsWith('/')) return `/${joined}`.replace(/\/$/, '') || '/';
  return joined;
}

export function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[a-z]:\/)/i.test(path);
}

export function resolveTargetPath(path: string, base?: string): string {
  const normalized = normalizePath(path);
  // Keep the repository-root sentinel when no base is supplied. An empty
  // diagnostic obscures which broad scope the guard blocked.
  const target = normalized === '' && /^\.\/?$/.test(path.trim()) ? '.' : normalized;
  return base && !isAbsolutePath(target) ? normalizePath(`${base}/${target}`) : target;
}

/** Convert an absolute runtime target back to the repository-relative glob vocabulary. */
export function relativeToInvocationCwd(path: string, invocationCwd?: string): string {
  const normalizedPath = normalizePath(path).replace(/\/$/, '');
  const normalized = normalizedPath === '' && /^\.\/?$/.test(path.trim()) ? '.' : normalizedPath;
  if (!invocationCwd || !isAbsolutePath(normalizePath(invocationCwd))) return normalized;
  const root = normalizePath(invocationCwd).replace(/\/$/, '');
  const pathForComparison = /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  const rootForComparison = /^[a-z]:\//i.test(root) ? root.toLowerCase() : root;
  if (pathForComparison === rootForComparison) return '.';
  if (pathForComparison.startsWith(`${rootForComparison}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

export function effectiveToolCwd(
  toolInputCwd: unknown,
  invocationCwd?: string,
): string | undefined {
  if (typeof toolInputCwd !== 'string' || toolInputCwd.length === 0) return invocationCwd;
  if (!invocationCwd || isAbsolutePath(normalizePath(toolInputCwd))) return toolInputCwd;
  return resolveTargetPath(toolInputCwd, invocationCwd);
}

export function matchesAny(path: string, patterns: RegExp[]): boolean {
  const normalized = normalizePath(path);
  return patterns.some((re) => re.test(normalized));
}

/** A glob-valued writer target describes a scope, not one concrete path. */
export function isUnresolvedPathScope(path: string): boolean {
  return /[*?]/.test(path);
}

export function isRootPathScope(path: string): boolean {
  const normalized = normalizePath(path).replace(/\/$/, '');
  return normalized === '.' || normalized === '';
}

/** A single list target without a file-like basename may denote a directory. */
export function isDirectoryAmbiguousPath(path: string): boolean {
  const normalized = normalizePath(path).replace(/\/$/, '');
  if (isRootPathScope(normalized)) return true;
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return path.endsWith('/') || (basename.length > 0 && !basename.includes('.'));
}

export function hasConfiguredProtectedDescendant(path: string, patterns: string[]): boolean {
  const normalized = normalizePath(path).replace(/\/$/, '').toLowerCase();
  if (!normalized || isUnresolvedPathScope(normalized)) return false;
  return patterns.some((pattern) => {
    const prefix = staticPrefix(normalizePath(pattern)).toLowerCase();
    return prefix.startsWith(`${normalized}/`);
  });
}

export function staticPrefix(pattern: string): string {
  const normalized = normalizePath(pattern);
  if (normalized === '.') return '';
  const wildcardIndex = normalized.search(/[*?]/);
  return (wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex)).replace(
    /\/$/,
    '',
  );
}

export function hasPartialSegmentWildcard(pattern: string): boolean {
  const normalized = normalizePath(pattern);
  const wildcardIndex = normalized.search(/[*?]/);
  return wildcardIndex > 0 && normalized[wildcardIndex - 1] !== '/';
}

export function globWitness(pattern: string): string {
  return pattern.replace(/\*+/g, '').replace(/\?/g, 'x');
}

export function scopesMayOverlap(left: string, right: string): boolean {
  const normalizedRight = normalizePath(right);
  if (!normalizedRight.includes('/')) {
    const leftPrefix = staticPrefix(left);
    const candidate = leftPrefix
      ? `${leftPrefix}/${globWitness(normalizedRight)}`
      : globWitness(normalizedRight);
    if (compilePathGlob(left).test(candidate)) return true;
    // A partial-segment writer glob can resolve to a directory scope. Its
    // descendants may then contain any basename-protected file even when the
    // scope expression itself does not directly match that filename.
    return hasPartialSegmentWildcard(left);
  }
  const leftPrefix = staticPrefix(left).toLowerCase();
  const rightPrefix = staticPrefix(right).toLowerCase();
  // A leading wildcard can reach any directory, so an empty static prefix is
  // not evidence that two scopes are disjoint. Treat it conservatively as an
  // overlap; callers can exempt a fully allowed writer scope before this check.
  if (!leftPrefix || !rightPrefix) return true;
  if (
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  ) {
    return true;
  }
  // Wildcards inside a segment can extend their static prefix without a slash:
  // `src/foo*` reaches `src/foobar/**`.
  return (
    (hasPartialSegmentWildcard(left) && rightPrefix.startsWith(leftPrefix)) ||
    (hasPartialSegmentWildcard(right) && leftPrefix.startsWith(rightPrefix))
  );
}

export function targetIntersectsScope(target: WriteTarget, patternTexts: string[]): boolean {
  if (target.kind === 'file') return false;
  const normalized = normalizePath(target.path).replace(/\/$/, '');
  if (!isUnresolvedPathScope(normalized)) {
    if (normalized === '.' || normalized === '') return patternTexts.length > 0;
    const descendantScope = `${normalized}/**`;
    return patternTexts.some((pattern) =>
      scopesMayOverlap(descendantScope, normalizePath(pattern)),
    );
  }
  return patternTexts.some((pattern) => scopesMayOverlap(normalized, normalizePath(pattern)));
}

export function targetIntersectsPatterns(
  target: WriteTarget,
  patternTexts: string[],
  patterns: RegExp[],
): boolean {
  if (matchesAny(target.path, patterns)) return true;
  return targetIntersectsScope(target, patternTexts);
}

/**
 * ReDoS-guarded variant of `targetIntersectsPatterns` (issue #365 / audit
 * T-02): the direct path match runs through `matchesAnyGuarded` (worker
 * watchdog, fail-closed on timeout); scope-overlap logic stays synchronous
 * because it matches against constructed candidate paths, not the raw
 * hostile input.
 */
export async function targetIntersectsPatternsGuarded(
  target: WriteTarget,
  patternTexts: string[],
  patterns: RegExp[],
  options: GuardedMatchOptions = {},
): Promise<boolean> {
  if (await matchesAnyGuarded(target.path, patterns, options)) return true;
  return targetIntersectsScope(target, patternTexts);
}

export function targetFullyAllowed(
  target: WriteTarget,
  allowTexts: string[],
  allowRes: RegExp[],
): boolean {
  if (target.kind === 'file') return matchesAny(target.path, allowRes);
  const normalized = normalizePath(target.path).replace(/\/$/, '');
  if (isUnresolvedPathScope(normalized)) {
    return allowTexts.some((allow, index) => {
      const allowNormalized = normalizePath(allow);
      if (allowNormalized === normalized) return true;
      const targetPrefix = staticPrefix(normalized);
      const allowRe = allowRes[index];
      return (
        targetPrefix.length > 0 &&
        !hasPartialSegmentWildcard(normalized) &&
        allowNormalized.endsWith('/**') &&
        allowRe?.test(targetPrefix)
      );
    });
  }
  // A concrete directory is fully covered only when an allow glob explicitly
  // includes every descendant beneath it. Allowing the directory entry alone
  // does not cover files the writer may change below it.
  return allowTexts.some((allow, index) => {
    const allowNormalized = normalizePath(allow);
    const allowRe = allowRes[index];
    return allowNormalized.endsWith('/**') && allowRe?.test(`${normalized}/.path-guard-probe`);
  });
}
