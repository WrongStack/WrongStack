import * as path from 'node:path';
import { ERROR_CODES, FsError } from '../types/errors.js';

/**
 * Resolve `<dir>/<sessionId><suffix>` for per-session sidecar files
 * (annotations, audit chain, replay log, the session JSONL itself).
 *
 * Modern session ids are date-sharded ("2026-06-11/sess_<ULID>"),
 * so a forward slash is a legitimate shard separator — NOT traversal.
 * Escape attempts are blocked two ways: an explicit ban on `..` and
 * backslashes, plus a resolved-path containment check that rejects any
 * id whose resolved target leaves `dir`. Character bans alone are how
 * several stores ended up throwing on every modern session id.
 */
export function sessionScopedPath(dir: string, sessionId: string, suffix: string): string {
  if (!sessionId || sessionId.includes('\\') || sessionId.includes('..')) {
    throw invalid(sessionId);
  }
  const resolved = path.resolve(dir, `${sessionId}${suffix}`);
  const rel = path.relative(path.resolve(dir), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalid(sessionId);
  }
  return resolved;
}

function invalid(sessionId: string): FsError {
  return new FsError({
    message: `Invalid sessionId: ${sessionId}`,
    code: ERROR_CODES.FS_DELETE_FAILED,
    path: sessionId,
    context: { reason: 'path_traversal' },
  });
}
