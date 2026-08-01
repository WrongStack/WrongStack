import { deleteBoard, listBoardSummaries, readBoard, writeBoard } from '../storage.js';

/**
 * Result of a prune operation.
 */
export interface PruneSessionBoardsResult {
  archived: string[];
  deleted: string[];
  skipped: string[];
}

/**
 * Prune session mirror boards whose retention TTL has elapsed.
 *
 * Boards with `kind: 'session_mirror'` and a retention policy of
 * `archive_after_ttl` or `delete_after_ttl` are evaluated. If the TTL
 * has elapsed since `updatedAt`, the board is either:
 * - `archive_after_ttl`: board `kind` changed to `'archive'` and
 *   `retention.archivedAt` stamped. The board is hidden from default
 *   queries by the board-kind filter.
 * - `delete_after_ttl`: board permanently deleted via `deleteBoard`.
 *
 * Boards with `retention.mode: 'keep'` or no TTL set are always skipped.
 * Non-session boards are never touched.
 */
export async function pruneSessionBoards(
  projectRoot: string,
  options: { now?: string } = {},
): Promise<PruneSessionBoardsResult> {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const summaries = await listBoardSummaries(projectRoot);

  const result: PruneSessionBoardsResult = {
    archived: [],
    deleted: [],
    skipped: [],
  };

  for (const summary of summaries) {
    const kind = summary.kind ?? 'project';
    if (kind !== 'session_mirror') {
      result.skipped.push(summary.id);
      continue;
    }

    const retention = summary.retention;
    if (!retention || retention.mode === 'keep' || !retention.ttlMs) {
      result.skipped.push(summary.id);
      continue;
    }

    // Already archived — skip.
    if (retention.archivedAt) {
      result.skipped.push(summary.id);
      continue;
    }

    const updatedAtMs = Date.parse(summary.updatedAt);
    const ageMs = nowMs - updatedAtMs;
    if (ageMs < retention.ttlMs) {
      result.skipped.push(summary.id);
      continue;
    }

    if (retention.mode === 'delete_after_ttl') {
      await deleteBoard(projectRoot, summary.id);
      result.deleted.push(summary.id);
    } else {
      // archive_after_ttl: load the full board, mark as archived, persist.
      const board = await readBoard(projectRoot, summary.id);
      if (!board) {
        result.skipped.push(summary.id);
        continue;
      }
      const retention = board.retention;
      if (!retention || retention.mode === 'keep' || !retention.ttlMs) continue;
      board.kind = 'archive';
      board.retention = {
        mode: retention.mode,
        ttlMs: retention.ttlMs,
        archivedAt: now,
      };
      board.updatedAt = now;
      await writeBoard(projectRoot, board);
      result.archived.push(summary.id);
    }
  }

  return result;
}
