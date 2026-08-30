import * as path from 'node:path';

export type SessionIdResolution =
  | { status: 'resolved'; id: string }
  | { status: 'missing'; query: string }
  | { status: 'ambiguous'; query: string; candidates: string[] };

/**
 * Resolve a user-facing session reference without ever guessing.
 *
 * Precedence: exact canonical id → exact leaf → unique canonical/leaf prefix.
 * Ambiguous leaf or prefix matches are returned to the caller for an explicit
 * error instead of selecting whichever session happened to sort first.
 */
export function resolveSessionId(
  query: string,
  candidateIds: readonly string[],
): SessionIdResolution {
  const trimmed = query.trim();
  const normalized = trimmed.replace(/\\/g, '/');
  if (!normalized) return { status: 'missing', query: normalized };

  const uniqueIds = [...new Set(candidateIds.map((id) => id.replace(/\\/g, '/')))];
  if (uniqueIds.includes(normalized)) return { status: 'resolved', id: normalized };

  const leaf = (id: string): string => path.posix.basename(id);
  const exactLeafMatches = uniqueIds.filter((id) => leaf(id) === normalized);
  if (exactLeafMatches.length === 1) {
    return { status: 'resolved', id: exactLeafMatches[0]! };
  }
  if (exactLeafMatches.length > 1) {
    return {
      status: 'ambiguous',
      query: normalized,
      candidates: exactLeafMatches.sort(),
    };
  }

  const prefixMatches = uniqueIds.filter(
    (id) => id.startsWith(normalized) || leaf(id).startsWith(normalized),
  );
  if (prefixMatches.length === 1) return { status: 'resolved', id: prefixMatches[0]! };
  if (prefixMatches.length > 1) {
    return { status: 'ambiguous', query: normalized, candidates: prefixMatches.sort() };
  }
  return { status: 'missing', query: trimmed };
}

export function sessionIdResolutionError(resolution: Exclude<SessionIdResolution, { status: 'resolved' }>): Error {
  if (resolution.status === 'ambiguous') {
    return new Error(
      `Ambiguous session id "${resolution.query}". Matches: ${resolution.candidates.join(', ')}`,
    );
  }
  return new Error(`Session not found: ${resolution.query}`);
}
