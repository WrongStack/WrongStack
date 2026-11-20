import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryAnchor, MemoryCandidate, Sage, SymbolSpanReader } from './types.js';

/**
 * Ascending byte comparison for ISO-8601 timestamps. `localeCompare` is
 * locale-aware and can reorder ASCII-only ISO strings across locales (Turkish
 * `i`/`I`, German `ß`/`ss`) — see `shared/pagination.ts:compareByUpdatedDesc`
 * for the canonical rationale. Oldest-first keeps the earliest record as the
 * dedup keeper. Valid for uniform-format strings (all writers use
 * `new Date().toISOString()`).
 */
export function compareIsoAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Oldest-first ordering for a pair of memories.
 *
 * `createdAt` is millisecond-precision, so two memories written in the same
 * tick compare EQUAL. The equal case used to fall through to the caller's
 * query order (`updated_at DESC, id DESC`) — which lists the newest record
 * first, so the "newer" pick resolved to the OLDER member and the
 * `contradicts` link plus the 'investigate' candidate landed on the wrong
 * claim. Ids are ULIDs and sort lexicographically by creation time, so they
 * break the tie in true insertion order. Byte comparison for the same reason
 * `compareIsoAscending` avoids `localeCompare`.
 */
export function compareMemoryAgeAscending(a: Sage, b: Sage): number {
  const byCreated = compareIsoAscending(a.createdAt, b.createdAt);
  if (byCreated !== 0) return byCreated;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function hygieneScopeKey(m: Sage): string {
  return m.scope === 'session' ? `session:${m.ownerSessionId ?? ''}` : m.scope;
}

/**
 * Can a path-existence check alone prove every anchor valid? Only for plain
 * file/test/directory/package paths: a content hash, blob hash or symbol can
 * make a memory stale while its file still exists, and an existence pass that
 * reactivated such a memory would silently undo a deep verification.
 */
export function existenceProvesAnchors(anchors: readonly MemoryAnchor[]): boolean {
  return (
    anchors.length > 0 &&
    anchors.every(
      (anchor) =>
        Boolean(anchor.path) &&
        (anchor.type === 'file' ||
          anchor.type === 'test' ||
          anchor.type === 'directory' ||
          anchor.type === 'package') &&
        !anchor.contentHash &&
        !anchor.gitBlobHash &&
        !anchor.symbol,
    )
  );
}

/**
 * Every anchor resolves inside the project (symlinks included) to an entry of
 * the right kind — the same containment and file/directory rules
 * `verifyMemoryAnchors` applies, without hashing.
 */
export async function anchorsPresentOnDisk(
  projectRoot: string,
  realRoot: string,
  anchors: readonly MemoryAnchor[],
): Promise<boolean> {
  for (const anchor of anchors) {
    try {
      const real = await fs.promises.realpath(path.resolve(projectRoot, anchor.path!));
      const relative = path.relative(realRoot, real);
      // `rel === '..'` / a '..<sep>' prefix (not a bare startsWith('..')):
      // legal in-root names whose first segment starts with '..' (e.g.
      // `..hidden/theme.css`) produce rel values like "..hidden\theme.css"
      // and must not be misread as escapes. Same predicate as paths.ts
      // escapesRoot and the design tool's materialize/verify guards.
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return false;
      }
      const stat = await fs.promises.stat(real);
      const wantsDirectory = anchor.type === 'directory' || anchor.type === 'package';
      if (wantsDirectory ? !stat.isDirectory() : !stat.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface SqliteHygieneContext {
  projectRoot: string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  now: () => Date;
  nowIso: () => string;
  listMemories: (opts: { status: Sage['status'] | 'all'; limit: number }) => Promise<Sage[]>;
  listCandidates: (includeResolved?: boolean) => Promise<MemoryCandidate[]>;
  addCandidate: (candidate: MemoryCandidate) => Promise<void>;
  runMutation: <T>(work: () => T) => Promise<T>;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
  /** Soft-delete edge cascade for auto session GC. */
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  pruneAuditLog: () => void;
  /** Symbol-span source for deep verification (#418); name check only without it. */
  symbolSpans?: SymbolSpanReader | undefined;
}
