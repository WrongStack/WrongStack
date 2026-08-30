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
  if (!sessionId || sessionId.includes('..') || sessionId.includes('\\')) {
    throw invalid(sessionId);
  }
  const resolved = path.resolve(dir, `${sessionId}${suffix}`);
  const rel = path.relative(path.resolve(dir), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalid(sessionId);
  }
  return resolved;
}

/**
 * Per-session sidecars that share the sessions directory with the transcripts
 * and share their `.jsonl` extension. Written through
 * {@link sessionScopedPath} by `ReplayLogStore` (`.replay.jsonl`) and
 * `ToolAuditLog` (`.audit.jsonl`); `.annotations.jsonl` is a legacy name kept
 * so old directories stay classified correctly.
 */
const SESSION_SIDECAR_JSONL_SUFFIXES = [
  '.replay.jsonl',
  '.audit.jsonl',
  '.annotations.jsonl',
] as const;

/** Store-level JSONLs that belong to the directory, not to any one session. */
const RESERVED_SESSION_JSONL_NAMES: ReadonlySet<string> = new Set([
  '_index.jsonl',
  '_mailbox.jsonl',
]);

/**
 * True when a file name in the sessions directory is a session transcript.
 *
 * Every directory scan needs this, and each one used to answer it for itself:
 * `SessionRecovery` filtered sidecars, the store's `collectSessionIds` /
 * `collectSessionFiles` did not, and the catalog daemon's `rebuildCatalog`
 * excluded `_index.jsonl` alone. The scans that did not filter turned every
 * sidecar into a phantom session — `sess_x.replay` and `_mailbox` were listed
 * next to `sess_x` in the picker, written into `_index.jsonl` by
 * `rebuildIndex()`, and counted as candidates by prefix resolution, so a
 * session id that had been unique became an ambiguous prefix as soon as the
 * session recorded a replay log.
 *
 * One predicate, so a new sidecar suffix cannot be added to one scanner's
 * blocklist and forgotten in the others.
 */
export function isSessionTranscriptFileName(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false;
  if (RESERVED_SESSION_JSONL_NAMES.has(name)) return false;
  return !SESSION_SIDECAR_JSONL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function invalid(sessionId: string): FsError {
  return new FsError({
    message: `Invalid sessionId: ${sessionId}`,
    code: ERROR_CODES.FS_DELETE_FAILED,
    path: sessionId,
    context: { reason: 'path_traversal' },
  });
}
