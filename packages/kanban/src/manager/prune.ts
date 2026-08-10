import { deleteBoard, listBoardSummaries, mutateBoard, readBoard, writeBoard } from '../storage.js';

/**
 * Cards kept on a live session mirror once they reach a terminal state.
 *
 * A session board is written in full on every mutation, so its card count is
 * a direct cost on every todo update — an hours-long session that cycles
 * through many todo lists accumulates archived and completed cards forever
 * and each update gets slower. Terminal cards past this window carry no
 * remaining decision value: the durable record lives in the session journal.
 */
export const SESSION_MIRROR_TERMINAL_TASK_LIMIT = 200;

export interface CompactSessionMirrorResult {
  removedTaskIds: string[];
  remainingTaskCount: number;
}

/**
 * Bound the card count of a live session mirror board.
 *
 * Drops the oldest terminal (archived / completed) cards beyond
 * `limit`, keeping every card that still carries open work. Only boards of
 * kind `session_mirror` are touched — a project or managed board is a durable
 * record and is never compacted. Cards referenced as a dependency of a
 * retained card are also kept, so readiness stays computable.
 */
export async function compactSessionMirrorBoard(
  projectRoot: string,
  boardId: string,
  options: { limit?: number | undefined } = {},
): Promise<CompactSessionMirrorResult | null> {
  const limit = options.limit ?? SESSION_MIRROR_TERMINAL_TASK_LIMIT;
  const removedTaskIds: string[] = [];
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    if ((board.kind ?? 'project') !== 'session_mirror') return null;
    if (board.lifecycle?.mode === 'managed') return null;

    const isTerminal = (status: string): boolean => status === 'archived' || status === 'completed';
    const terminal = board.tasks.filter((task) => isTerminal(task.status));
    if (terminal.length <= limit) return null;

    // Never drop a card another retained card still points at: readiness and
    // the dependency graph must stay resolvable after compaction.
    const retainedDependencies = new Set(
      board.tasks
        .filter((task) => !isTerminal(task.status))
        .flatMap((task) => task.dependsOn ?? []),
    );
    const droppable = terminal
      .filter((task) => !retainedDependencies.has(task.id))
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      );
    const dropCount = Math.min(droppable.length, terminal.length - limit);
    if (dropCount <= 0) return null;

    const dropped = new Set(droppable.slice(0, dropCount).map((task) => task.id));
    board.tasks = board.tasks.filter((task) => !dropped.has(task.id));
    for (const task of board.tasks) {
      if (task.dependsOn?.length) {
        task.dependsOn = task.dependsOn.filter((id) => !dropped.has(id));
      }
    }
    removedTaskIds.push(...dropped);
    return removedTaskIds.length;
  });
  if (!updated) return null;
  return { removedTaskIds, remainingTaskCount: updated.board.tasks.length };
}

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
